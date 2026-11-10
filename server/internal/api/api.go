// Package api stellt die HTTP-Schnittstelle bereit, über die die App ihre Daten abgleicht.
//
// Die App spricht den Server wie früher einen Sync-Ordner an: Sie listet die Dokumente mit ihren Revisionen, liest,
// schreibt und löscht sie. Den Abgleich (auch nach Offline-Zeiten) und Konflikte regelt die App; der Server prüft
// nur, wer welches Dokument sehen und ändern darf (siehe Paket access).
package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/access"
	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/auth"
	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/store"
)

const (
	// Größtes Dokument; die Konfiguration kann Bilder enthalten.
	maxDocBytes = 25 << 20
	// Anmeldungen, die so lange nicht genutzt wurden, verfallen.
	MaxIdle = 180 * 24 * time.Hour
	// Gültigkeit der Codes
	InviteValidity = 14 * 24 * time.Hour
	ResetValidity  = 2 * 24 * time.Hour
)

var usernamePattern = regexp.MustCompile(`^[\p{L}\p{N}._-]{3,40}$`)

type Server struct {
	store     *store.Store
	publicURL string
	origin    string
	limiter   *limiter
}

// New erzeugt den Server. publicURL ist die Adresse, unter der die App ihn erreicht (sie steht in den Codes);
// origin ist der erlaubte Ursprung für CORS, z. B. die Adresse der Web-App, oder „*“.
func New(st *store.Store, publicURL, origin string) *Server {
	return &Server{store: st, publicURL: strings.TrimRight(publicURL, "/"), origin: origin, limiter: newLimiter()}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, map[string]string{"status": "ok"}) })
	mux.HandleFunc("POST /api/login", s.login)
	mux.HandleFunc("POST /api/redeem", s.redeem)
	mux.HandleFunc("POST /api/reset", s.reset)
	mux.HandleFunc("POST /api/logout", s.authed(s.logout))
	mux.HandleFunc("GET /api/me", s.authed(s.me))
	mux.HandleFunc("GET /api/accounts", s.authed(s.accounts))
	mux.HandleFunc("POST /api/invites", s.authed(s.invite))
	mux.HandleFunc("GET /api/docs", s.authed(s.listDocs))
	mux.HandleFunc("GET /api/docs/{name}", s.authed(s.getDoc))
	mux.HandleFunc("PUT /api/docs/{name}", s.authed(s.putDoc))
	mux.HandleFunc("DELETE /api/docs/{name}", s.authed(s.deleteDoc))
	mux.HandleFunc("GET /api/merges", s.authed(s.listMerges))
	mux.HandleFunc("POST /api/merges", s.authed(s.addMerge))
	mux.HandleFunc("GET /api/feed", s.authed(s.getFeed))
	mux.HandleFunc("PUT /api/feed", s.authed(s.putFeed))
	mux.HandleFunc("PUT /api/feeds/{teacher}", s.authed(s.putTeacherFeed))
	mux.HandleFunc("POST /api/feed/address", s.authed(s.newFeedAddress))
	mux.HandleFunc("DELETE /api/feed/address", s.authed(s.deleteFeedAddress))
	mux.HandleFunc("GET /api/kalender/{file}", s.calendar)
	mux.HandleFunc("GET /api/plans/{period}", s.authed(s.getPlan))
	mux.HandleFunc("PUT /api/plans/{period}", s.authed(s.putPlan))
	mux.HandleFunc("DELETE /api/plans/{period}", s.authed(s.deletePlan))
	mux.HandleFunc("POST /api/plans/{period}/address", s.authed(s.newPlanAddress))
	mux.HandleFunc("GET /api/plan/{token}", s.publicPlans)
	mux.HandleFunc("GET /api/plan/{token}/{file}", s.publicPlanFile)
	mux.HandleFunc("GET /api/plan/{token}/{person}/tauschen", s.swapPage)
	mux.HandleFunc("GET /api/plan/{token}/{person}/dazukommen", s.joinPage)
	mux.HandleFunc("POST /api/plan/{token}/{person}/anfragen", s.createRequest)
	mux.HandleFunc("POST /api/plan/{token}/{person}/antworten", s.answerRequest)
	mux.HandleFunc("GET /api/plans/{period}/requests", s.authed(s.acceptedRequests))
	mux.HandleFunc("POST /api/plans/{period}/requests/{id}", s.authed(s.requestDone))
	return s.cors(mux)
}

// PackCode verpackt einen Code mit der Adresse des Servers, wie ihn die App einliest.
func (s *Server) PackCode(kind store.CodeKind, code string) string {
	return auth.Pack(auth.Packed{Server: s.publicURL, Kind: string(kind), Code: code})
}

// NewCode legt einen Einladungs- oder Reset-Code an und liefert ihn verpackt; auch für die Kommandozeile.
func (s *Server) NewCode(ctx context.Context, kind store.CodeKind, teacherID string) (string, time.Time, error) {
	validity := InviteValidity
	if kind == store.Reset {
		validity = ResetValidity
	}
	code := auth.NewCode()
	expires := time.Now().Add(validity)
	err := s.store.CreateCode(ctx, auth.Hash(auth.NormalizeCode(code)), store.Code{Kind: kind, TeacherID: teacherID, ExpiresAt: expires})
	return s.PackCode(kind, code), expires, err
}

// --- Anmeldung ---

type session struct {
	Token     string `json:"token"`
	Username  string `json:"username"`
	TeacherID string `json:"teacherId"`
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var body struct{ Username, Password string }
	if !readJSON(w, r, &body) {
		return
	}
	key := clientIP(r) + "|" + strings.ToLower(body.Username)
	if wait := s.limiter.blocked(key); wait > 0 {
		fail(w, http.StatusTooManyRequests, "Zu viele Fehlversuche. Bitte in "+waitText(wait)+" erneut versuchen.")
		return
	}
	account, err := s.store.AccountByUsername(r.Context(), strings.TrimSpace(body.Username))
	if err != nil || !auth.CheckPassword(account.PasswordHash, body.Password) {
		s.limiter.failure(key)
		fail(w, http.StatusUnauthorized, "Benutzername oder Passwort stimmen nicht.")
		return
	}
	s.limiter.success(key)
	s.startSession(w, r, account)
}

// redeem löst eine Einladung ein: neues Konto mit Benutzername und Passwort. Einladungen von der Kommandozeile
// sind an keinen Lehrer gebunden; dann gilt die Lehrer-ID, die die App mitschickt (ihr eigener Lehrer, damit
// vorhandene Daten zum Konto passen).
func (s *Server) redeem(w http.ResponseWriter, r *http.Request) {
	var body struct{ Code, Username, Password, TeacherID string }
	if !readJSON(w, r, &body) {
		return
	}
	username := strings.TrimSpace(body.Username)
	if !usernamePattern.MatchString(username) {
		fail(w, http.StatusBadRequest, "Der Benutzername braucht 3 bis 40 Zeichen: Buchstaben, Ziffern, Punkt, Binde- oder Unterstrich.")
		return
	}
	hash, err := auth.HashPassword(body.Password)
	if err != nil {
		fail(w, http.StatusBadRequest, "Das Passwort braucht mindestens "+strconv.Itoa(auth.MinPasswordLength)+" Zeichen.")
		return
	}
	if body.TeacherID != "" {
		if _, err := access.Parse("lehrer-" + body.TeacherID + ".json"); err != nil {
			fail(w, http.StatusBadRequest, "Ungültige Lehrer-ID.")
			return
		}
	}
	code, codeHash, ok := s.takeCode(w, r, body.Code, store.Invite)
	if !ok {
		return
	}
	teacherID := code.TeacherID
	if teacherID == "" {
		teacherID = body.TeacherID
	}
	if teacherID == "" {
		_ = s.store.PutCodeBack(r.Context(), codeHash, code)
		fail(w, http.StatusBadRequest, "Die Lehrer-ID fehlt.")
		return
	}
	account, err := s.store.CreateAccount(r.Context(), username, teacherID, hash)
	if err != nil {
		// Der Code bleibt gültig, damit man es mit einem anderen Namen erneut versuchen kann.
		_ = s.store.PutCodeBack(r.Context(), codeHash, code)
		if errors.Is(err, store.ErrTaken) {
			fail(w, http.StatusConflict, "Den Benutzernamen gibt es schon, oder dieser Lehrer hat bereits ein Konto.")
			return
		}
		internal(w, err)
		return
	}
	s.startSession(w, r, account)
}

// reset setzt mit einem Reset-Code ein neues Passwort; alle anderen Geräte werden abgemeldet.
func (s *Server) reset(w http.ResponseWriter, r *http.Request) {
	var body struct{ Code, Password string }
	if !readJSON(w, r, &body) {
		return
	}
	hash, err := auth.HashPassword(body.Password)
	if err != nil {
		fail(w, http.StatusBadRequest, "Das Passwort braucht mindestens "+strconv.Itoa(auth.MinPasswordLength)+" Zeichen.")
		return
	}
	code, _, ok := s.takeCode(w, r, body.Code, store.Reset)
	if !ok {
		return
	}
	account, err := s.store.AccountByTeacher(r.Context(), code.TeacherID)
	if err != nil {
		fail(w, http.StatusNotFound, "Zu diesem Code gibt es kein Konto mehr.")
		return
	}
	if err := s.store.SetPassword(r.Context(), account.ID, hash); err != nil {
		internal(w, err)
		return
	}
	s.startSession(w, r, account)
}

// takeCode prüft einen Code (verpackt oder nur die Zeichen) und verbraucht ihn; Fehlversuche werden gebremst.
func (s *Server) takeCode(w http.ResponseWriter, r *http.Request, text string, kind store.CodeKind) (store.Code, string, bool) {
	key := clientIP(r) + "|code"
	if wait := s.limiter.blocked(key); wait > 0 {
		fail(w, http.StatusTooManyRequests, "Zu viele Fehlversuche. Bitte in "+waitText(wait)+" erneut versuchen.")
		return store.Code{}, "", false
	}
	if packed, err := auth.Unpack(text); err == nil {
		text = packed.Code
	}
	codeHash := auth.Hash(auth.NormalizeCode(text))
	code, err := s.store.TakeCode(r.Context(), codeHash, kind)
	if err != nil {
		s.limiter.failure(key)
		fail(w, http.StatusNotFound, "Der Code ist ungültig, abgelaufen oder schon benutzt.")
		return store.Code{}, "", false
	}
	s.limiter.success(key)
	return code, codeHash, true
}

func (s *Server) startSession(w http.ResponseWriter, r *http.Request, account store.Account) {
	token := auth.NewToken()
	if err := s.store.CreateSession(r.Context(), auth.Hash(token), account.ID); err != nil {
		internal(w, err)
		return
	}
	writeJSON(w, session{Token: token, Username: account.Username, TeacherID: account.TeacherID})
}

type accountKey struct{}

// authed lässt nur angemeldete Lehrer durch und gibt das Konto an den Handler weiter.
func (s *Server) authed(next func(http.ResponseWriter, *http.Request, store.Account)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || token == "" {
			fail(w, http.StatusUnauthorized, "Nicht angemeldet.")
			return
		}
		account, err := s.store.SessionAccount(r.Context(), auth.Hash(token), MaxIdle)
		if err != nil {
			fail(w, http.StatusUnauthorized, "Die Anmeldung ist abgelaufen. Bitte erneut anmelden.")
			return
		}
		next(w, r, account)
	}
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request, _ store.Account) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	_ = s.store.DeleteSession(r.Context(), auth.Hash(token))
	w.WriteHeader(http.StatusNoContent)
}

// me nennt auch, wie viele Berichtszeiträume es gibt, in denen der Lehrer nicht eingetragen ist; was darin steht,
// erfährt er nicht.
func (s *Server) me(w http.ResponseWriter, r *http.Request, account store.Account) {
	members, err := s.members(r.Context())
	if err != nil {
		internal(w, err)
		return
	}
	foreign := 0
	for periodID := range members {
		if !members.In(periodID, account.TeacherID) {
			foreign++
		}
	}
	// conditionalWrites: Der Server kennt If-Match beim Schreiben; ältere erlauben den Header nicht einmal (CORS).
	writeJSON(w, map[string]any{
		"username": account.Username, "teacherId": account.TeacherID, "foreignPeriods": foreign, "conditionalWrites": true,
	})
}

// accounts zeigt, welche Lehrer schon ein Konto haben, damit die App nur für die anderen Einladungen anbietet.
func (s *Server) accounts(w http.ResponseWriter, r *http.Request, _ store.Account) {
	accounts, err := s.store.Accounts(r.Context())
	if err != nil {
		internal(w, err)
		return
	}
	list := make([]map[string]string, 0, len(accounts))
	for _, a := range accounts {
		list = append(list, map[string]string{"teacherId": a.TeacherID, "username": a.Username})
	}
	writeJSON(w, list)
}

// invite: Jeder Lehrer darf einen Lehrer einladen, der noch kein Konto hat.
func (s *Server) invite(w http.ResponseWriter, r *http.Request, _ store.Account) {
	var body struct{ TeacherID string }
	if !readJSON(w, r, &body) {
		return
	}
	if _, err := access.Parse("lehrer-" + body.TeacherID + ".json"); err != nil {
		fail(w, http.StatusBadRequest, "Ungültige Lehrer-ID.")
		return
	}
	if _, err := s.store.AccountByTeacher(r.Context(), body.TeacherID); err == nil {
		fail(w, http.StatusConflict, "Dieser Lehrer hat schon ein Konto. Ein neues Passwort gibt es mit einem Reset-Code vom Server.")
		return
	}
	code, expires, err := s.NewCode(r.Context(), store.Invite, body.TeacherID)
	if err != nil {
		internal(w, err)
		return
	}
	writeJSON(w, map[string]string{"code": code, "expiresAt": expires.UTC().Format(time.RFC3339)})
}

// --- Dokumente ---

// members liest die Lehrer jedes Berichtszeitraums aus dessen Dokument; eine ältere Konfiguration mit
// Berichtszeiträumen (vor `Migrate`) zählt ebenfalls.
func (s *Server) members(ctx context.Context) (access.Members, error) {
	members := access.Members{}
	config, _, err := s.store.Doc(ctx, access.ConfigName)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	if err == nil {
		if members, err = access.MembersOf(config); err != nil {
			return nil, err
		}
	}
	docs, err := s.store.Docs(ctx)
	if err != nil {
		return nil, err
	}
	for _, d := range docs {
		doc, err := access.Parse(d.Name)
		if err != nil || doc.Kind != access.PeriodConfig {
			continue
		}
		content, _, err := s.store.Doc(ctx, d.Name)
		if err != nil {
			return nil, err
		}
		_, teacherIDs, err := access.PeriodOf(content)
		if err != nil {
			return nil, err
		}
		members[doc.PeriodID] = teacherIDs
	}
	return members, nil
}

func (s *Server) listDocs(w http.ResponseWriter, r *http.Request, account store.Account) {
	members, err := s.members(r.Context())
	if err != nil {
		internal(w, err)
		return
	}
	docs, err := s.store.Docs(r.Context())
	if err != nil {
		internal(w, err)
		return
	}
	list := make([]map[string]string, 0, len(docs))
	for _, d := range docs {
		doc, err := access.Parse(d.Name)
		if err != nil || !access.CanRead(doc, account.TeacherID, members) {
			continue
		}
		list = append(list, map[string]string{"name": d.Name, "version": strconv.FormatInt(d.Revision, 10)})
	}
	writeJSON(w, list)
}

// doc prüft den Namen und das Recht; ohne Recht antwortet der Server wie bei einem fehlenden Dokument.
func (s *Server) doc(w http.ResponseWriter, r *http.Request, account store.Account, write bool) (access.Doc, access.Members, bool) {
	doc, err := access.Parse(r.PathValue("name"))
	if err != nil {
		fail(w, http.StatusBadRequest, "Unbekannter Dokumentname.")
		return doc, nil, false
	}
	members, err := s.members(r.Context())
	if err != nil {
		internal(w, err)
		return doc, nil, false
	}
	allowed := access.CanRead(doc, account.TeacherID, members)
	if write {
		allowed = access.CanWrite(doc, account.TeacherID, members)
	}
	if !allowed {
		fail(w, http.StatusForbidden, "Kein Zugriff auf diesen Berichtszeitraum.")
		return doc, nil, false
	}
	return doc, members, true
}

func (s *Server) getDoc(w http.ResponseWriter, r *http.Request, account store.Account) {
	doc, _, ok := s.doc(w, r, account, false)
	if !ok {
		return
	}
	content, revision, err := s.store.Doc(r.Context(), doc.Name)
	if errors.Is(err, store.ErrNotFound) {
		fail(w, http.StatusNotFound, "Das Dokument gibt es nicht.")
		return
	}
	if err != nil {
		internal(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Revision", strconv.FormatInt(revision, 10))
	_, _ = w.Write(content)
}

func (s *Server) putDoc(w http.ResponseWriter, r *http.Request, account store.Account) {
	doc, members, ok := s.doc(w, r, account, true)
	if !ok {
		return
	}
	content, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxDocBytes))
	if err != nil {
		fail(w, http.StatusRequestEntityTooLarge, "Das Dokument ist zu groß.")
		return
	}
	if !json.Valid(content) {
		fail(w, http.StatusBadRequest, "Das Dokument ist kein gültiges JSON.")
		return
	}
	if doc.Kind == access.Config && access.HasPeriods(content) {
		fail(w, http.StatusConflict, "Diese App-Version speichert Berichtszeiträume noch in der Konfiguration. Bitte die App aktualisieren.")
		return
	}
	if doc.Kind == access.PeriodConfig {
		periodID, teacherIDs, err := access.PeriodOf(content)
		if err != nil || periodID != doc.PeriodID {
			fail(w, http.StatusBadRequest, "Das Dokument passt nicht zu diesem Berichtszeitraum.")
			return
		}
		if _, exists := members[doc.PeriodID]; !exists && !slices.Contains(teacherIDs, account.TeacherID) {
			fail(w, http.StatusForbidden, "Wer einen Berichtszeitraum anlegt, muss selbst eingetragen sein.")
			return
		}
	}
	revision, err := s.storeDoc(r, doc.Name, content, account.ID)
	if errors.Is(err, store.ErrStale) {
		fail(w, http.StatusPreconditionFailed, "Das Dokument wurde inzwischen auf einem anderen Gerät geändert.")
		return
	}
	if errors.Is(err, errBadRevision) {
		fail(w, http.StatusBadRequest, "If-Match muss eine Revision sein.")
		return
	}
	if err != nil {
		internal(w, err)
		return
	}
	writeJSON(w, map[string]string{"version": strconv.FormatInt(revision, 10)})
}

var errBadRevision = errors.New("ungültige Revision")

// storeDoc speichert das Dokument. Mit If-Match (Revision beim Lesen, 0 für ein neues Dokument) nur, wenn es seitdem
// niemand geändert hat; ältere Apps schicken das nicht mit und überschreiben wie bisher.
func (s *Server) storeDoc(r *http.Request, name string, content []byte, accountID int64) (int64, error) {
	match := strings.Trim(strings.TrimSpace(r.Header.Get("If-Match")), `"`)
	if match == "" {
		return s.store.PutDoc(r.Context(), name, content, accountID)
	}
	expected, err := strconv.ParseInt(match, 10, 64)
	if err != nil || expected < 0 {
		return 0, errBadRevision
	}
	return s.store.PutDocIf(r.Context(), name, content, accountID, expected)
}

func (s *Server) deleteDoc(w http.ResponseWriter, r *http.Request, account store.Account) {
	doc, _, ok := s.doc(w, r, account, true)
	if !ok {
		return
	}
	// Ohne Konfiguration gäbe es keine Berichtszeiträume mehr; sie wird nur überschrieben.
	if doc.Kind == access.Config {
		fail(w, http.StatusForbidden, "Die Konfiguration lässt sich nicht löschen.")
		return
	}
	if err := s.store.DeleteDoc(r.Context(), doc.Name); err != nil {
		internal(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Zusammenführungen ---

func (s *Server) listMerges(w http.ResponseWriter, r *http.Request, _ store.Account) {
	merges, err := s.store.Merges(r.Context())
	if err != nil {
		internal(w, err)
		return
	}
	list := make([]map[string]string, 0, len(merges))
	for _, m := range merges {
		list = append(list, map[string]string{"from": m.From, "into": m.Into})
	}
	writeJSON(w, list)
}

// addMerge vermerkt, dass zwei Personen dieselbe sind. Das darf nur, wer beide sehen kann; die Apps der anderen
// Lehrer übernehmen die Zusammenführung beim nächsten Abgleich.
func (s *Server) addMerge(w http.ResponseWriter, r *http.Request, account store.Account) {
	var body struct{ From, Into string }
	if !readJSON(w, r, &body) {
		return
	}
	if body.From == "" || body.Into == "" || body.From == body.Into {
		fail(w, http.StatusBadRequest, "Zwei verschiedene Personen angeben.")
		return
	}
	visible, err := s.visibleStudents(r.Context(), account.TeacherID)
	if err != nil {
		internal(w, err)
		return
	}
	if !visible[body.From] || !visible[body.Into] {
		fail(w, http.StatusForbidden, "Zusammenführen darf nur, wer beide Personen sehen kann.")
		return
	}
	if err := s.store.AddMerge(r.Context(), store.Merge{From: body.From, Into: body.Into}, account.ID); err != nil {
		internal(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// visibleStudents sammelt die IDs aller Personen in Dokumenten, die der Lehrer lesen darf.
func (s *Server) visibleStudents(ctx context.Context, teacherID string) (map[string]bool, error) {
	members, err := s.members(ctx)
	if err != nil {
		return nil, err
	}
	docs, err := s.store.Docs(ctx)
	if err != nil {
		return nil, err
	}
	visible := map[string]bool{}
	for _, d := range docs {
		doc, err := access.Parse(d.Name)
		if err != nil || doc.Kind != access.Period || !access.CanRead(doc, teacherID, members) {
			continue
		}
		content, _, err := s.store.Doc(ctx, d.Name)
		if err != nil {
			return nil, err
		}
		ids, err := access.StudentIDs(content)
		if err != nil {
			continue
		}
		for _, id := range ids {
			visible[id] = true
		}
	}
	return visible, nil
}

// --- Hilfsfunktionen ---

// cors erlaubt der Web-App und der Android-App den Zugriff. Angemeldet wird mit einem Token im Header, nicht mit
// Cookies; deshalb ist auch „*“ unbedenklich.
func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", s.origin)
		h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, If-Match")
		h.Set("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS")
		h.Set("Access-Control-Expose-Headers", "X-Revision")
		h.Set("Access-Control-Max-Age", "86400")
		if s.origin != "*" {
			h.Add("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func readJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(target); err != nil {
		fail(w, http.StatusBadRequest, "Ungültige Anfrage.")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(value)
}

// fail antwortet mit einem Text, den die App so anzeigen kann.
func fail(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}

func internal(w http.ResponseWriter, err error) {
	log.Printf("interner Fehler: %v", err)
	fail(w, http.StatusInternalServerError, "Interner Fehler auf dem Server.")
}

// clientIP liefert die Adresse für die Bremse bei Fehlversuchen. X-Forwarded-For zählt nur, wenn die Anfrage vom
// Reverse-Proxy auf demselben Rechner kommt (siehe README). Dann gilt der hinterste Eintrag, der keine lokale Adresse
// ist: Den hängt der Proxy an. Die Einträge davor kann der Absender selbst mitschicken; nähme man sie, könnte er mit
// jedem Versuch eine andere Adresse vortäuschen und die Bremse umgehen.
func clientIP(r *http.Request) string {
	peer := r.RemoteAddr
	if host, _, err := net.SplitHostPort(peer); err == nil {
		peer = host
	}
	if !isLoopback(peer) {
		return peer
	}
	forwarded := strings.Split(strings.Join(r.Header.Values("X-Forwarded-For"), ","), ",")
	for i := len(forwarded) - 1; i >= 0; i-- {
		if ip := strings.TrimSpace(forwarded[i]); ip != "" && !isLoopback(ip) {
			return ip
		}
	}
	return peer
}

func isLoopback(ip string) bool {
	parsed := net.ParseIP(ip)
	return parsed != nil && parsed.IsLoopback()
}

func waitText(d time.Duration) string {
	if d < time.Minute {
		return strconv.Itoa(int(d.Seconds())+1) + " Sekunden"
	}
	return strconv.Itoa(int(d.Minutes())+1) + " Minuten"
}
