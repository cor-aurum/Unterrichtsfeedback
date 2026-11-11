package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/access"
	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/auth"
	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/store"
)

const (
	// Größte Sammlung von Plänen; jede Person hat ein PDF, oft mit Logo.
	maxPlanBytes = 64 << 20
	// So lange nach dem Ende des Berichtszeitraums gilt der Download-Link noch.
	PlanDaysAfterPeriod = 14
)

var (
	personIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)
	colorPattern    = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)
	errPlanExpired  = errors.New("Download-Link abgelaufen")
)

// planContent sind die Pläne eines Zeitraums, wie die App sie schickt. Texte wie Datum und Uhrzeit hat sie schon
// lesbar gemacht; der Server zeigt sie nur an.
type planContent struct {
	// Name des Berichtszeitraums und seine Daten, z. B. „9. November – 20. November 2026“
	Title  string       `json:"title"`
	Dates  string       `json:"dates"`
	Color  string       `json:"color"`
	People []planPerson `json:"people"`
	// Selbsteintragung über den Link; fehlt, wenn sie nicht läuft
	Booking *planBooking `json:"booking,omitempty"`
}

type planPerson struct {
	ID string `json:"id"`
	// Kurzname wie beim Eintragen, z. B. „Anna B.“
	Label string    `json:"label"`
	Days  []planDay `json:"days"`
	ICS   string    `json:"ics"`
	// PDF in Base64
	PDF string `json:"pdf"`
	// Was die Person bei der Selbsteintragung wählen kann; fehlt, wenn sie nicht dabei ist
	Booking *personBooking `json:"booking,omitempty"`
}

type planDay struct {
	// Tag als JJJJ-MM-TT und lesbar, z. B. „Dienstag, 17. November 2026“
	Day     string      `json:"day"`
	Date    string      `json:"date"`
	Entries []planEntry `json:"entries"`
}

type planEntry struct {
	Time     string `json:"time"`
	Title    string `json:"title"`
	Location string `json:"location"`
	// Termin (ID in der App) und Lehrkraft, für Tausch und Dazukommen; leer bei allgemeinen Terminen
	Slot    string `json:"slot,omitempty"`
	Teacher string `json:"teacher,omitempty"`
	// Ein einzelner Einzeltermin lässt sich tauschen; dazukommen kann man zu ihm und zu spontanen Gruppen.
	Swap bool `json:"swap,omitempty"`
	Join bool `json:"join,omitempty"`
}

type planAnswer struct {
	// Leer, solange es keinen Link gibt
	URL       string `json:"url"`
	UpdatedAt string `json:"updatedAt,omitempty"`
	// Letzter Tag, an dem der Link gilt (JJJJ-MM-TT)
	ExpiresAt string `json:"expiresAt"`
}

func (s *Server) planURL(token string) string {
	return s.publicURL + "/api/plan/" + token
}

// --- Verwalten (nur Lehrer des Zeitraums) ---

// planPeriod prüft, ob der Lehrer im Zeitraum eingetragen ist, und liefert den letzten Tag, an dem der Link gilt.
func (s *Server) planPeriod(w http.ResponseWriter, r *http.Request, account store.Account) (string, time.Time, bool) {
	periodID := r.PathValue("period")
	members, err := s.members(r.Context())
	if err != nil {
		internal(w, err)
		return "", time.Time{}, false
	}
	if isDemoPlan(periodID) && periodID != DemoPlanPrefix+account.TeacherID {
		fail(w, http.StatusForbidden, "Das ist nicht dein Demo-Link.")
		return "", time.Time{}, false
	}
	if !isDemoPlan(periodID) && !members.In(periodID, account.TeacherID) {
		fail(w, http.StatusForbidden, "Den Download-Link verwalten nur die Lehrkräfte des Berichtszeitraums.")
		return "", time.Time{}, false
	}
	lastDay, err := s.planLastDay(r.Context(), periodID)
	if errors.Is(err, store.ErrNotFound) {
		fail(w, http.StatusNotFound, "Den Berichtszeitraum gibt es auf dem Server noch nicht. Bitte erst abgleichen.")
		return "", time.Time{}, false
	}
	if err != nil {
		internal(w, err)
		return "", time.Time{}, false
	}
	return periodID, lastDay, true
}

// planLastDay: Der Link gilt bis 14 Tage nach dem Ende des Zeitraums; ändert sich das Ende, wandert er mit.
func (s *Server) planLastDay(ctx context.Context, periodID string) (time.Time, error) {
	if isDemoPlan(periodID) {
		return s.demoLastDay(ctx, periodID)
	}
	content, _, err := s.store.Doc(ctx, access.PeriodDocName(periodID))
	if err != nil {
		return time.Time{}, err
	}
	end, err := access.PeriodEnd(content)
	if err != nil {
		return time.Time{}, err
	}
	day, err := time.ParseInLocation(time.DateOnly, end, time.Local)
	if err != nil {
		return time.Time{}, fmt.Errorf("Ende des Berichtszeitraums %q: %w", end, err)
	}
	return day.AddDate(0, 0, PlanDaysAfterPeriod), nil
}

// Demo-Links: Im Demomodus gibt es den Berichtszeitraum nur in der App, nicht auf dem Server. Jedes Konto hat dafür
// einen eigenen Link unter `demo-konto-<Lehrer-ID>`. Er gilt bis drei Tage nach der letzten Aktualisierung; beim
// Verlassen der Demo löscht ihn die App.
const (
	DemoPlanPrefix = "demo-konto-"
	DemoPlanDays   = 3
)

func isDemoPlan(periodID string) bool {
	return strings.HasPrefix(periodID, DemoPlanPrefix)
}

func (s *Server) demoLastDay(ctx context.Context, periodID string) (time.Time, error) {
	since := time.Now()
	link, err := s.store.Plan(ctx, periodID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return time.Time{}, err
	}
	if err == nil && !link.UpdatedAt.IsZero() {
		since = link.UpdatedAt
	}
	day := time.Date(since.Year(), since.Month(), since.Day(), 0, 0, 0, 0, time.Local)
	return day.AddDate(0, 0, DemoPlanDays), nil
}

func (s *Server) getPlan(w http.ResponseWriter, r *http.Request, account store.Account) {
	periodID, lastDay, ok := s.planPeriod(w, r, account)
	if !ok {
		return
	}
	answer := planAnswer{ExpiresAt: lastDay.Format(time.DateOnly)}
	link, err := s.store.Plan(r.Context(), periodID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		internal(w, err)
		return
	}
	if err == nil {
		answer.URL = s.planURL(link.Token)
		if !link.UpdatedAt.IsZero() {
			answer.UpdatedAt = link.UpdatedAt.UTC().Format(time.RFC3339)
		}
	}
	writeJSON(w, answer)
}

// newPlanAddress richtet den Link ein oder ersetzt ihn; der alte gilt danach nicht mehr.
func (s *Server) newPlanAddress(w http.ResponseWriter, r *http.Request, account store.Account) {
	periodID, lastDay, ok := s.planPeriod(w, r, account)
	if !ok {
		return
	}
	token := auth.NewToken()
	if err := s.store.SetPlanToken(r.Context(), periodID, token); err != nil {
		internal(w, err)
		return
	}
	writeJSON(w, planAnswer{URL: s.planURL(token), ExpiresAt: lastDay.Format(time.DateOnly)})
}

// deletePlan löscht Link und Pläne.
func (s *Server) deletePlan(w http.ResponseWriter, r *http.Request, account store.Account) {
	periodID, _, ok := s.planPeriod(w, r, account)
	if !ok {
		return
	}
	if err := s.store.DeletePlan(r.Context(), periodID); err != nil {
		internal(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// putPlan nimmt die Pläne an, die die App bei Änderungen erzeugt; ohne Link gibt es nichts zu speichern (404).
func (s *Server) putPlan(w http.ResponseWriter, r *http.Request, account store.Account) {
	periodID, _, ok := s.planPeriod(w, r, account)
	if !ok {
		return
	}
	content, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxPlanBytes))
	if err != nil {
		fail(w, http.StatusRequestEntityTooLarge, "Die Pläne sind zu groß.")
		return
	}
	plans, err := parsePlans(content)
	if err == nil {
		err = checkPDFs(plans)
	}
	if err != nil {
		fail(w, http.StatusBadRequest, "Die Pläne sind ungültig: "+err.Error())
		return
	}
	err = s.store.PutPlanContent(r.Context(), periodID, content)
	if errors.Is(err, store.ErrNotFound) {
		fail(w, http.StatusNotFound, "Für diesen Berichtszeitraum gibt es keinen Download-Link.")
		return
	}
	if err != nil {
		internal(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// parsePlans liest die Pläne und prüft, was die öffentliche Seite braucht: eindeutige IDs, die in einer Adresse
// stehen dürfen, Namen und Kalender. Die PDFs prüft checkPDFs nur beim Hochladen, denn dazu muss jedes dekodiert
// werden.
func parsePlans(content []byte) (planContent, error) {
	var plans planContent
	if err := json.Unmarshal(content, &plans); err != nil {
		return plans, errors.New("kein gültiges JSON")
	}
	seen := map[string]bool{}
	for _, person := range plans.People {
		switch {
		case !personIDPattern.MatchString(person.ID) || seen[person.ID]:
			return plans, fmt.Errorf("ungültige oder doppelte ID %q", person.ID)
		case strings.TrimSpace(person.Label) == "":
			return plans, fmt.Errorf("Person %s ohne Namen", person.ID)
		case !strings.HasPrefix(person.ICS, "BEGIN:VCALENDAR"):
			return plans, fmt.Errorf("Kalender von %s fehlt", person.ID)
		}
		for _, day := range person.Days {
			for _, entry := range day.Entries {
				if entry.Slot != "" && !personIDPattern.MatchString(entry.Slot) {
					return plans, fmt.Errorf("ungültiger Termin %q", entry.Slot)
				}
			}
		}
		seen[person.ID] = true
	}
	if err := checkBooking(plans); err != nil {
		return plans, err
	}
	return plans, nil
}

func checkPDFs(plans planContent) error {
	for _, person := range plans.People {
		if !isPDF(person.PDF) {
			return fmt.Errorf("PDF von %s fehlt", person.ID)
		}
	}
	return nil
}

func isPDF(encoded string) bool {
	data, err := base64.StdEncoding.DecodeString(encoded)
	return err == nil && bytes.HasPrefix(data, []byte("%PDF"))
}

// --- Öffentliche Seite (ohne Anmeldung) ---

// Wie beim Kalender-Abo ist der Link selbst der Schlüssel (256 Bit Zufall); Raten ist aussichtslos.

// publicPlans zeigt die Namen aller Personen des Zeitraums.
func (s *Server) publicPlans(w http.ResponseWriter, r *http.Request) {
	plans, link, ok := s.publishedPlans(w, r)
	if !ok {
		return
	}
	pending, err := s.pendingRequests(r.Context(), link.PeriodID)
	if err != nil {
		internal(w, err)
		return
	}
	renderPage(w, http.StatusOK, plansPage, pageData{Plans: plans, Base: s.planURL(link.Token), Updated: updatedText(link), Pending: pending})
}

// publicPlanFile liefert zu einer Person ihre Seite, ihr PDF (`<id>.pdf`) oder ihren Kalender (`<id>.ics`).
func (s *Server) publicPlanFile(w http.ResponseWriter, r *http.Request) {
	plans, link, ok := s.publishedPlans(w, r)
	if !ok {
		return
	}
	file := r.PathValue("file")
	id, ext := file, ""
	if dot := strings.LastIndexByte(file, '.'); dot >= 0 {
		id, ext = file[:dot], file[dot:]
	}
	var person *planPerson
	for i := range plans.People {
		if plans.People[i].ID == id {
			person = &plans.People[i]
		}
	}
	if person == nil {
		renderPage(w, http.StatusNotFound, messagePage, pageData{Message: "Diesen Plan gibt es nicht (mehr). Bitte wähle deinen Namen in der Liste."})
		return
	}
	switch ext {
	case "":
		s.renderPerson(w, r, plans, link, person)
	case ".pdf":
		data, _ := base64.StdEncoding.DecodeString(person.PDF)
		serveFile(w, r, "application/pdf", "Plan "+person.Label+".pdf", link.UpdatedAt, data)
	case ".ics":
		serveFile(w, r, "text/calendar; charset=utf-8", "Termine "+person.Label+".ics", link.UpdatedAt, []byte(person.ICS))
	default:
		http.NotFound(w, r)
	}
}

// publishedPlans lädt die Pläne zum Token; unbekannte, abgelaufene oder leere Links bekommen eine Hinweisseite.
// Die Pläne kommen aus dem Zwischenspeicher, solange sie sich nicht geändert haben.
func (s *Server) publishedPlans(w http.ResponseWriter, r *http.Request) (planContent, store.PlanLink, bool) {
	link, err := s.store.PlanStampByToken(r.Context(), r.PathValue("token"))
	if err == nil {
		err = s.checkPlanValid(r.Context(), link.PeriodID)
	}
	if err == nil && !link.UpdatedAt.IsZero() {
		if plans, ok := s.planCache.get(link); ok {
			return plans, link, true
		}
		// Seit eben können neuere Pläne angekommen sein; gespeichert wird die Fassung, die gelesen wurde.
		link, err = s.store.PlanByToken(r.Context(), link.Token)
	}
	switch {
	case errors.Is(err, store.ErrNotFound):
		renderPage(w, http.StatusNotFound, messagePage, pageData{Message: "Diesen Link gibt es nicht (mehr). Bitte frag deine Lehrkraft nach dem aktuellen Link."})
		return planContent{}, link, false
	case errors.Is(err, errPlanExpired):
		renderPage(w, http.StatusGone, messagePage, pageData{Message: "Dieser Link ist abgelaufen."})
		return planContent{}, link, false
	case err != nil:
		internal(w, err)
		return planContent{}, link, false
	}
	if len(link.Content) == 0 {
		renderPage(w, http.StatusOK, messagePage, pageData{Message: "Die Pläne werden gerade vorbereitet. Bitte versuch es gleich noch einmal."})
		return planContent{}, link, false
	}
	plans, err := parsePlans(link.Content)
	if err != nil {
		internal(w, err)
		return planContent{}, link, false
	}
	s.planCache.put(link, plans)
	link.Content = nil
	return plans, link, true
}

func (s *Server) checkPlanValid(ctx context.Context, periodID string) error {
	lastDay, err := s.planLastDay(ctx, periodID)
	if err != nil {
		return err
	}
	if time.Now().After(lastDay.AddDate(0, 0, 1)) {
		return errPlanExpired
	}
	return nil
}

func serveFile(w http.ResponseWriter, r *http.Request, contentType, name string, updated time.Time, data []byte) {
	h := w.Header()
	h.Set("Content-Type", contentType)
	h.Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": name}))
	privateHeaders(h)
	http.ServeContent(w, r, "", updated, bytes.NewReader(data))
}

// privateHeaders: Weder Suchmaschinen noch fremde Seiten (über den Referer) sollen die Adresse erfahren.
func privateHeaders(h http.Header) {
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Robots-Tag", "noindex, nofollow")
	h.Set("Referrer-Policy", "no-referrer")
}

func updatedText(link store.PlanLink) string {
	if link.UpdatedAt.IsZero() {
		return ""
	}
	return link.UpdatedAt.Local().Format("02.01.2006, 15:04 Uhr")
}

type pageData struct {
	Plans   planContent
	Person  *planPerson
	Base    string
	Updated string
	Message string
	// Zurück zur Seite der Person, z. B. nach einem Fehler beim Anfragen
	Back string
	// Hinweis nach einer Aktion, z. B. „Deine Anfrage ist verschickt.“
	Notice   string
	Incoming []requestView
	History  []requestView
	// Termine anderer zum Tauschen oder Dazukommen
	Own     *slotView
	Options []slotView
	// Namensliste: offene Anfragen an jede Person
	Pending map[string]int
	// Nach dem Anfragen: wem man Bescheid sagen sollte, mit Link zu dessen Seite
	Tell *tellView
	// Selbsteintragung: die Seite zum Wählen und der Hinweis darauf auf der Seite der Person
	Booking        *bookingView
	BookingSummary *bookingSummary
}

// Script ist das einzige Skript der Seiten: Teilen und Kopieren des Links nach einer Anfrage.
func (pageData) Script() template.HTML {
	return template.HTML("<script>" + pageScript + "</script>")
}

// Color ist die Themenfarbe der App; nur geprüfte Werte landen im CSS.
func (d pageData) Color() template.CSS {
	if colorPattern.MatchString(d.Plans.Color) {
		return template.CSS(d.Plans.Color)
	}
	return "#2f6f9f"
}

// Webcal ist die Abo-Adresse des Kalenders; ein Klick öffnet die Kalender-App mit dem Abo.
func (d pageData) Webcal() template.URL {
	url := d.Base + "/" + d.Person.ID + ".ics"
	return template.URL("webcal" + strings.TrimPrefix(strings.TrimPrefix(url, "https"), "http"))
}

func renderPage(w http.ResponseWriter, status int, page *template.Template, data pageData) {
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'; script-src '"+pageScriptHash+"'")
	privateHeaders(h)
	var out bytes.Buffer
	if err := page.Execute(&out, data); err != nil {
		internal(w, err)
		return
	}
	w.WriteHeader(status)
	_, _ = w.Write(out.Bytes())
}

const pageLayout = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>{{block "title" .}}Pläne{{end}}</title>
<style>
:root { --accent: {{.Color}}; color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; font: 17px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f2933; background: #f4f6f8; }
main { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
header { border-top: 6px solid var(--accent); background: #fff; border-radius: 12px; padding: 18px 20px; margin-bottom: 20px; box-shadow: 0 1px 3px #0001; }
h1 { margin: 0 0 4px; font-size: 1.6rem; line-height: 1.2; }
h2 { margin: 22px 0 8px; font-size: 1.05rem; color: #44505c; }
.muted { color: #66727f; font-size: .95rem; margin: 0; }
.muted a { color: inherit; }
.names { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.names a { display: block; padding: 16px 12px; background: #fff; border: 1px solid #d5dbe1; border-radius: 10px; text-align: center; font-weight: 600; color: inherit; text-decoration: none; }
.names a:hover, .names a:focus { border-color: var(--accent); outline: 2px solid var(--accent); }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 16px 0 6px; }
.button { display: inline-block; padding: 12px 18px; border-radius: 10px; background: var(--accent); color: #fff; font-weight: 600; text-decoration: none; }
.button.secondary { background: #fff; color: #1f2933; border: 1px solid #c3ccd5; }
.day { background: #fff; border-radius: 10px; padding: 10px 16px; margin-bottom: 10px; border: 1px solid #e3e8ec; }
.day h3 { margin: 0 0 6px; font-size: 1rem; }
.entry { display: flex; gap: 14px; padding: 4px 0; }
.time { flex: 0 0 auto; min-width: 7.5em; font-variant-numeric: tabular-nums; font-weight: 600; }
.back { display: inline-block; margin-bottom: 14px; color: inherit; }
.what { flex: 1 1 auto; }
.small-link { color: inherit; font-size: .9rem; white-space: nowrap; }
.notice { background: #e8f3ea; border-radius: 10px; padding: 12px 16px; }
.request { background: #fff8e6; border: 1px solid #f0d9a0; border-radius: 10px; padding: 4px 16px 10px; margin-bottom: 10px; }
.request .actions { margin: 8px 0 4px; }
button.button { border: 0; font: inherit; cursor: pointer; }
button.button.secondary { border: 1px solid #c3ccd5; }
.badge { display: block; margin-top: 4px; font-size: .8rem; font-weight: 600; color: #8a5a00; }
.tell { background: #eef4fb; border-radius: 10px; padding: 4px 16px 12px; margin-bottom: 12px; }
.tell input { width: 100%; padding: 10px; border: 1px solid #c3ccd5; border-radius: 8px; font: inherit; font-size: .9rem; }
.slots { display: flex; flex-wrap: wrap; gap: 8px; margin: 4px 0 6px; }
.slot { min-width: 5.5em; padding: 10px 12px; border-radius: 10px; border: 1px solid #c3ccd5; background: #fff; font: inherit; font-weight: 600; font-variant-numeric: tabular-nums; cursor: pointer; }
.slot:hover:not(:disabled), .slot:focus { border-color: var(--accent); outline: 2px solid var(--accent); }
.slot:disabled { color: #9aa5b1; cursor: default; }
.slot .clash { display: block; font-size: .75rem; font-weight: 400; color: #8a5a00; }
.option { display: flex; gap: 12px; align-items: center; justify-content: space-between; background: #fff; border: 1px solid #e3e8ec; border-radius: 10px; padding: 10px 16px; margin-bottom: 8px; }
footer { margin-top: 28px; }
</style>
</head>
<body><main>{{block "content" .}}{{end}}</main>{{.Script}}</body>
</html>`

var (
	plansPage = template.Must(template.Must(template.New("plans").Parse(pageLayout)).Parse(`
{{define "title"}}{{.Plans.Title}}{{end}}
{{define "content"}}
<header>
  <h1>{{.Plans.Title}}</h1>
  <p class="muted">{{.Plans.Dates}}</p>
</header>
{{if .Plans.People}}
<p>Tippe auf deinen Namen.</p>
<nav class="names">
{{range .Plans.People}}<a href="{{$.Base}}/{{.ID}}">{{.Label}}{{with index $.Pending .ID}}<span class="badge">{{if eq . 1}}1 Anfrage{{else}}{{.}} Anfragen{{end}}</span>{{end}}</a>
{{end}}
</nav>
{{else}}
<p>Hier sind noch keine Personen eingetragen.</p>
{{end}}
{{if .Updated}}<footer><p class="muted">Stand: {{.Updated}}</p></footer>{{end}}
{{end}}`))

	personPage = template.Must(template.Must(template.New("person").Parse(pageLayout)).Parse(`
{{define "title"}}{{.Person.Label}} – {{.Plans.Title}}{{end}}
{{define "content"}}
<a class="back" href="{{.Base}}">← Alle Namen</a>
<header>
  <h1>{{.Person.Label}}</h1>
  <p class="muted">{{.Plans.Title}} · {{.Plans.Dates}}</p>
</header>
{{if .Notice}}<p class="notice" role="status">{{.Notice}}</p>{{end}}
{{with .Tell}}
<section class="tell">
  <p>Sag <strong>{{.Label}}</strong> Bescheid, damit die Anfrage nicht untergeht – z. B. per Nachricht mit dem Link zu der Seite:</p>
  <input type="text" readonly value="{{.URL}}" aria-label="Link zur Seite von {{.Label}}">
  <div class="actions">
    <button class="button" type="button" hidden data-share="{{.Text}}" data-url="{{.URL}}">Teilen …</button>
    <button class="button secondary" type="button" hidden data-copy="{{.URL}}">Link kopieren</button>
  </div>
</section>
{{end}}
{{range .Incoming}}
<section class="request">
  <p>{{.Text}}</p>
  <form method="post" action="{{$.Base}}/{{$.Person.ID}}/antworten" class="actions">
    <input type="hidden" name="anfrage" value="{{.ID}}">
    <button class="button" name="antwort" value="ja">Annehmen</button>
    <button class="button secondary" name="antwort" value="nein">Ablehnen</button>
  </form>
</section>
{{end}}
{{with .BookingSummary}}
<section class="tell">
  <h2>Termine selbst eintragen</h2>
  <p>{{if .Remaining}}Du kannst noch <strong>{{.Remaining}}</strong> {{if eq .Remaining 1}}Termin{{else}}Termine{{end}} wählen.{{else}}Du hast alle Termine gewählt; austragen kannst du dort auch.{{end}}
  {{if .Failed}}<br>{{if eq .Failed 1}}Eine Eintragung hat{{else}}{{.Failed}} Eintragungen haben{{end}} nicht geklappt.{{end}}</p>
  <p><a class="button" href="{{$.Base}}/{{$.Person.ID}}/termine">Termine wählen</a></p>
</section>
{{end}}
<div class="actions">
  <a class="button" href="{{.Base}}/{{.Person.ID}}.pdf" download>Plan als PDF</a>
  <a class="button secondary" href="{{.Base}}/{{.Person.ID}}.ics" download>Kalenderdatei (.ics)</a>
  <a class="button secondary" href="{{.Webcal}}">Im Kalender abonnieren</a>
</div>
<p class="muted">Abonnierst du den Kalender, holt deine Kalender-App spätere Änderungen von selbst.</p>
<h2>Deine Termine</h2>
{{range .Person.Days}}
<section class="day">
  <h3>{{.Date}}</h3>
  {{range .Entries}}<div class="entry"><span class="time">{{.Time}}</span><span class="what">{{.Title}}{{if .Location}} · {{.Location}}{{end}}</span>{{if .Swap}}<a class="small-link" href="{{$.Base}}/{{$.Person.ID}}/tauschen?termin={{.Slot}}">Tauschen</a>{{end}}</div>
  {{end}}
</section>
{{else}}
<p>Für dich sind noch keine Termine eingetragen.</p>
{{end}}
<p><a class="button secondary" href="{{.Base}}/{{.Person.ID}}/dazukommen">Bei jemandem dazukommen …</a></p>
{{if .History}}
<h2>Deine Anfragen</h2>
{{range .History}}
<section class="request">
  <p>{{.Text}}<br><span class="muted">{{.Status}}</span></p>
  {{if .Withdraw}}<form method="post" action="{{$.Base}}/{{$.Person.ID}}/antworten">
    <input type="hidden" name="anfrage" value="{{.ID}}">
    <button class="button secondary" name="antwort" value="zurueck">Zurückziehen</button>
  </form>{{end}}
</section>
{{end}}
{{end}}
{{if .Updated}}<footer><p class="muted">Stand: {{.Updated}}</p></footer>{{end}}
{{end}}`))

	// choosePage: Termine anderer zum Tauschen (mit Own) oder zum Dazukommen
	choosePage = template.Must(template.Must(template.New("choose").Parse(pageLayout)).Parse(`
{{define "title"}}{{.Person.Label}} – {{.Plans.Title}}{{end}}
{{define "content"}}
<a class="back" href="{{.Base}}/{{.Person.ID}}">← Zurück zu deinen Terminen</a>
<header>
  {{if .Own}}<h1>Termin tauschen</h1>
  <p>Dein Termin: <strong>{{.Own.Label}}</strong> · {{.Own.Title}}</p>
  <p class="muted">Wähle, mit wem du tauschen möchtest. Die andere Person muss zustimmen.</p>
  {{else}}<h1>Bei jemandem dazukommen</h1>
  <p class="muted">Wähle einen Unterricht, zu dem du dazukommen möchtest. Die Person muss zustimmen; danach habt ihr den Termin gemeinsam.</p>{{end}}
</header>
{{range .Options}}
<form method="post" action="{{$.Base}}/{{$.Person.ID}}/anfragen" class="option">
  <input type="hidden" name="art" value="{{if $.Own}}swap{{else}}join{{end}}">
  {{if $.Own}}<input type="hidden" name="mein" value="{{$.Own.Slot}}">{{end}}
  <input type="hidden" name="an" value="{{.Person}}">
  <input type="hidden" name="ziel" value="{{.Slot}}">
  <span><strong>{{.Label}}</strong><br>{{.PersonLabel}} · {{.Title}}</span>
  <button class="button">{{if $.Own}}Tausch anfragen{{else}}Anfragen{{end}}</button>
</form>
{{else}}
<p>Gerade gibt es dafür keine passenden Termine.</p>
{{end}}
{{end}}`))

	bookingPageTemplate = template.Must(template.Must(template.New("booking").Parse(pageLayout)).Parse(`
{{define "title"}}{{.Person.Label}} – Termine wählen{{end}}
{{define "content"}}
<a class="back" href="{{.Base}}/{{.Person.ID}}">← Zurück zu deinen Terminen</a>
{{with .Booking}}
<header>
  <h1>Termine wählen</h1>
  <p class="muted">{{$.Person.Label}} · {{.Period}}</p>
  {{if .Remaining}}<p>Du kannst noch <strong>{{.Remaining}}</strong> {{if eq .Remaining 1}}Termin{{else}}Termine{{end}} wählen{{with .Teacher}}{{if gt (len $.Plans.Booking.Teachers) 1}} bei {{.Name}}{{end}}{{end}}.</p>
  {{else}}<p>Du hast alle Termine gewählt.</p>{{end}}
</header>
{{if $.Notice}}<p class="notice" role="status">{{$.Notice}}</p>{{end}}
{{range .Entries}}
<section class="request">
  <p>{{.Text}}<br><span class="muted">{{.Status}}</span></p>
  {{if .Withdraw}}<form method="post" action="{{$.Base}}/{{$.Person.ID}}/austragen">
    <input type="hidden" name="eintragung" value="{{.ID}}">
    <button class="button secondary">Zurücknehmen</button>
  </form>{{end}}
</section>
{{end}}
{{if .Own}}
<h2>Deine Termine</h2>
{{range .Own}}
<div class="option">
  <span>{{.Label}}{{if .Cancelling}}<br><span class="muted">Wird ausgetragen …</span>{{end}}</span>
  {{if and .Removable (not .Cancelling)}}<form method="post" action="{{$.Base}}/{{$.Person.ID}}/austragen">
    <input type="hidden" name="termin" value="{{.Slot}}">
    <button class="button secondary">Austragen</button>
  </form>{{end}}
</div>
{{end}}
{{end}}
{{if .Teacher}}
  <h2>Freie Zeiten{{if gt (len $.Plans.Booking.Teachers) 1}} bei {{.Teacher.Name}}{{end}}</h2>
  {{if .Choosing}}<p class="muted">Mit deinem ersten Termin ist {{.Teacher.Name}} in diesem Zeitraum deine Lehrkraft. <a href="termine">Andere Lehrkraft wählen</a></p>{{end}}
  {{if .HasClash}}<p class="muted">⚠ heißt: Zu dieser Zeit hast du Gruppenunterricht.</p>{{end}}
  <form method="post" action="{{$.Base}}/{{$.Person.ID}}/eintragen">
  <input type="hidden" name="lehrkraft" value="{{.Teacher.ID}}">
  {{range .Days}}
  <section class="day">
    <h3>{{.Label}}</h3>
    <div class="slots">{{range .Slots}}<button class="slot" name="zeit" value="{{.Value}}"{{if not $.Booking.Remaining}} disabled{{end}}>{{.Time}}{{if .Clash}}<span class="clash">⚠ {{.Clash}}</span>{{end}}</button>{{end}}</div>
  </section>
  {{else}}
  <p>Gerade ist keine Zeit frei, die zu dir passt. Sprich bitte deine Lehrkraft an.</p>
  {{end}}
  </form>
{{else if .Teachers}}
  <h2>Bei wem möchtest du Unterricht haben?</h2>
  {{range .Teachers}}
  <div class="option">
    <span><strong>{{.Name}}</strong>{{if .Instrument}} · {{.Instrument}}{{end}}<br><span class="muted">{{.Free}} freie Zeiten</span></span>
    <a class="button" href="termine?lehrkraft={{.ID}}">Zeiten ansehen</a>
  </div>
  {{end}}
{{else}}
  <p>{{.Closed}}</p>
{{end}}
{{end}}
{{if .Updated}}<footer><p class="muted">Stand: {{.Updated}}</p></footer>{{end}}
{{end}}`))

	messagePage = template.Must(template.Must(template.New("message").Parse(pageLayout)).Parse(`
{{define "content"}}<header><h1>Pläne</h1><p>{{.Message}}</p></header>{{if .Back}}<p><a class="back" href="{{.Back}}">← Zurück</a></p>{{end}}{{end}}`))
)
