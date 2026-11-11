package api

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/auth"
	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/store"
)

// Auf der Download-Seite tauschen Personen ihre Termine oder kommen zum Unterricht anderer dazu, ganz ohne
// Lehrkraft: Die eine fragt an, die andere nimmt an. Angenommene Anfragen übernimmt die App einer Lehrkraft des
// Zeitraums beim nächsten Abgleich in die Daten und schickt danach neue Pläne. Wer den Link hat, kann jede Seite
// öffnen; eine Anmeldung gibt es bewusst nicht.

const (
	// Gegen versehentliche oder mutwillige Massen von Anfragen
	maxOpenPerPerson = 10
	maxOpenPerPeriod = 500
	// So lange stehen beantwortete Anfragen noch auf der Seite.
	requestHistory = 7 * 24 * time.Hour
	takenNote      = "Der Termin hat sich inzwischen geändert."
)

// Hinweise nach einer Aktion; die Seite zeigt nur diese festen Texte.
var notices = map[string]string{
	"gesendet":       "Deine Anfrage ist verschickt. Sobald die andere Person antwortet, siehst du es hier.",
	"angenommen":     "Angenommen. Die Änderung steht in eurem Plan, sobald eine Lehrkraft-App sie übernommen hat – meist nach wenigen Minuten.",
	"abgelehnt":      "Du hast die Anfrage abgelehnt.",
	"zurueckgezogen": "Deine Anfrage ist zurückgezogen.",
	"veraltet":       "Diese Anfrage ist nicht mehr offen.",
}

// tellView: Nach einer Anfrage soll die gefragte Person davon erfahren; die Seite bietet ihren Link zum Weitergeben.
type tellView struct {
	Label string
	URL   string
	// Nachricht zum Teilen, z. B. „Ich habe dir eine Anfrage zum Tauschen geschickt …“
	Text string
}

// Teilen und Kopieren gehen nur mit JavaScript; ohne (oder wenn der Browser das Kopieren verweigert) bleibt der Link
// zum Markieren stehen. Die Seite erlaubt genau
// dieses Skript (über seinen Hash in der Content-Security-Policy).
const pageScript = `for (const b of document.querySelectorAll('[data-share]')) {
  if (!navigator.share) continue;
  b.hidden = false;
  b.onclick = () => navigator.share({ text: b.dataset.share, url: b.dataset.url }).catch(() => {});
}
for (const b of document.querySelectorAll('[data-copy]')) {
  if (!navigator.clipboard) continue;
  b.hidden = false;
  b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(
    () => { b.textContent = 'Kopiert ✓'; },
    () => b.closest('.tell')?.querySelector('input')?.select(),
  );
}`

var pageScriptHash = func() string {
	sum := sha256.Sum256([]byte(pageScript))
	return "sha256-" + base64.StdEncoding.EncodeToString(sum[:])
}()

// pendingRequests zählt die offenen Anfragen an jede Person, für die Namensliste.
func (s *Server) pendingRequests(ctx context.Context, periodID string) (map[string]int, error) {
	open, err := s.store.PlanRequests(ctx, periodID, store.RequestOpen)
	if err != nil {
		return nil, err
	}
	pending := map[string]int{}
	for _, req := range open {
		pending[req.ToPerson]++
	}
	return pending, nil
}

type requestView struct {
	ID       string
	Text     string
	Status   string
	Withdraw bool
}

// slotView ist ein Termin einer Person, z. B. als Angebot zum Tauschen.
type slotView struct {
	Person      string
	PersonLabel string
	Slot        string
	Label       string
	Title       string
	// Tag und Uhrzeit zum Sortieren
	when string
}

func today() string {
	return time.Now().Format(time.DateOnly)
}

func (p planContent) person(id string) *planPerson {
	for i := range p.People {
		if p.People[i].ID == id {
			return &p.People[i]
		}
	}
	return nil
}

func (p planContent) label(personID string) string {
	if person := p.person(personID); person != nil {
		return person.Label
	}
	return "Jemand"
}

// slot sucht einen künftigen Termin der Person; vergangene lassen sich weder tauschen noch teilen.
func (p *planPerson) slot(id string) (slotView, planEntry, bool) {
	for _, day := range p.Days {
		for _, entry := range day.Entries {
			if entry.Slot == id && id != "" && day.Day >= today() {
				return slotView{Person: p.ID, PersonLabel: p.Label, Slot: id, Label: day.Date + ", " + entry.Time, Title: entry.Title}, entry, true
			}
		}
	}
	return slotView{}, planEntry{}, false
}

// options sammelt die künftigen Termine aller anderen, die `fits` erfüllen, nach Tag und Uhrzeit.
func (p planContent) options(except string, fits func(planEntry) bool) []slotView {
	var list []slotView
	for _, person := range p.People {
		if person.ID == except {
			continue
		}
		for _, day := range person.Days {
			for _, entry := range day.Entries {
				if day.Day >= today() && entry.Slot != "" && fits(entry) {
					list = append(list, slotView{Person: person.ID, PersonLabel: person.Label, Slot: entry.Slot, Label: day.Date + ", " + entry.Time, Title: entry.Title, when: day.Day + entry.Time})
				}
			}
		}
	}
	slices.SortStableFunc(list, func(a, b slotView) int { return strings.Compare(a.when, b.when) })
	return list
}

// withoutPast: Vergangene Termine bieten kein „Tauschen“ mehr an.
func withoutPast(person planPerson) planPerson {
	days := make([]planDay, len(person.Days))
	for i, day := range person.Days {
		entries := slices.Clone(day.Entries)
		if day.Day < today() {
			for j := range entries {
				entries[j].Swap, entries[j].Join = false, false
			}
		}
		days[i] = planDay{Day: day.Day, Date: day.Date, Entries: entries}
	}
	person.Days = days
	return person
}

// renderPerson zeigt die Seite einer Person mit offenen Anfragen an sie und ihren eigenen.
func (s *Server) renderPerson(w http.ResponseWriter, r *http.Request, plans planContent, link store.PlanLink, person *planPerson) {
	requests, err := s.store.PlanRequests(r.Context(), link.PeriodID)
	if err != nil {
		internal(w, err)
		return
	}
	shown := withoutPast(*person)
	query := r.URL.Query()
	data := pageData{Plans: plans, Person: &shown, Base: s.planURL(link.Token), Updated: updatedText(link), Notice: notices[query.Get("hinweis")]}
	if target := plans.person(query.Get("an")); target != nil && query.Get("hinweis") == "gesendet" && target.ID != person.ID {
		data.Tell = tellAbout(target, data.Base+"/"+target.ID, query.Get("art"))
	}
	for _, req := range requests {
		mine, toMe := req.FromPerson == person.ID, req.ToPerson == person.ID
		if req.Status == store.RequestWithdrawn || (!mine && !toMe) {
			continue
		}
		if req.Status != store.RequestOpen && time.Since(req.UpdatedAt) > requestHistory {
			continue
		}
		view := requestView{ID: req.ID, Text: requestText(plans, req, toMe), Status: statusText(plans, req, toMe)}
		if toMe && req.Status == store.RequestOpen {
			data.Incoming = append(data.Incoming, view)
			continue
		}
		view.Withdraw = mine && req.Status == store.RequestOpen
		data.History = append(data.History, view)
	}
	desk, booking, err := s.desk(r, plans, link, person)
	if err != nil {
		internal(w, err)
		return
	}
	if booking {
		data.BookingSummary = desk.summary()
	}
	renderPage(w, http.StatusOK, personPage, data)
}

func tellAbout(target *planPerson, page, kind string) *tellView {
	text := "Hallo " + target.Label + ", ich habe dir auf der Plan-Seite eine Anfrage geschickt, ob ich zu deinem Unterricht dazukommen darf. Bitte schau mal:"
	if kind == store.RequestSwap {
		text = "Hallo " + target.Label + ", ich habe dir auf der Plan-Seite eine Anfrage zum Tauschen unserer Termine geschickt. Bitte schau mal:"
	}
	return &tellView{Label: target.Label, URL: page, Text: text}
}

func requestText(plans planContent, req store.PlanRequest, toMe bool) string {
	switch {
	case req.Kind == store.RequestSwap && toMe:
		return plans.label(req.FromPerson) + " möchte mit dir tauschen: dein Termin " + req.ToLabel + " gegen " + req.FromLabel + "."
	case req.Kind == store.RequestSwap:
		return "Tausch mit " + plans.label(req.ToPerson) + ": dein Termin " + req.FromLabel + " gegen " + req.ToLabel + "."
	case toMe:
		return plans.label(req.FromPerson) + " möchte zu deinem Unterricht am " + req.ToLabel + " dazukommen."
	default:
		return "Dazukommen bei " + plans.label(req.ToPerson) + " am " + req.ToLabel + "."
	}
}

func statusText(plans planContent, req store.PlanRequest, toMe bool) string {
	switch req.Status {
	case store.RequestOpen:
		return sentence("Wartet auf " + plans.label(req.ToPerson))
	case store.RequestAccepted:
		return "Angenommen – wird gleich in den Plan übernommen."
	case store.RequestApplied:
		return "Erledigt – steht in deinem Plan."
	case store.RequestDeclined:
		if req.Note != "" {
			return "Nicht mehr möglich: " + req.Note
		}
		if toMe {
			return "Du hast abgelehnt."
		}
		return "Abgelehnt."
	default:
		return "Nicht möglich: " + req.Note
	}
}

// sentence schließt mit einem Punkt, außer der Text endet schon mit einem (z. B. „Anna B.“).
func sentence(text string) string {
	if strings.HasSuffix(text, ".") {
		return text
	}
	return text + "."
}

// requester lädt Pläne und Person der Seite; ohne gültigen Link oder Person antwortet er selbst.
func (s *Server) requester(w http.ResponseWriter, r *http.Request) (planContent, store.PlanLink, *planPerson, bool) {
	plans, link, ok := s.publishedPlans(w, r)
	if !ok {
		return plans, link, nil, false
	}
	person := plans.person(r.PathValue("person"))
	if person == nil {
		renderPage(w, http.StatusNotFound, messagePage, pageData{Message: "Diesen Plan gibt es nicht (mehr).", Back: s.planURL(link.Token)})
		return plans, link, nil, false
	}
	return plans, link, person, true
}

// swapPage bietet zu einem eigenen Termin die Termine anderer bei derselben Lehrkraft zum Tausch an.
func (s *Server) swapPage(w http.ResponseWriter, r *http.Request) {
	plans, link, person, ok := s.requester(w, r)
	if !ok {
		return
	}
	back := s.planURL(link.Token) + "/" + person.ID
	own, entry, found := person.slot(r.URL.Query().Get("termin"))
	if !found || !entry.Swap {
		renderPage(w, http.StatusNotFound, messagePage, pageData{Message: "Diesen Termin kannst du nicht tauschen.", Back: back})
		return
	}
	options := plans.options(person.ID, func(e planEntry) bool { return e.Swap && e.Teacher == entry.Teacher })
	renderPage(w, http.StatusOK, choosePage, pageData{Plans: plans, Person: person, Base: s.planURL(link.Token), Own: &own, Options: options})
}

// joinPage bietet den Unterricht anderer zum Dazukommen an, bei jeder Lehrkraft.
func (s *Server) joinPage(w http.ResponseWriter, r *http.Request) {
	plans, link, person, ok := s.requester(w, r)
	if !ok {
		return
	}
	options := plans.options(person.ID, func(e planEntry) bool {
		_, _, already := person.slot(e.Slot)
		return e.Join && !already
	})
	renderPage(w, http.StatusOK, choosePage, pageData{Plans: plans, Person: person, Base: s.planURL(link.Token), Options: options})
}

// createRequest legt eine Tausch- oder Dazukommen-Anfrage an; die Formulare kommen von swapPage und joinPage.
func (s *Server) createRequest(w http.ResponseWriter, r *http.Request) {
	plans, link, person, ok := s.requester(w, r)
	if !ok {
		return
	}
	back := s.planURL(link.Token) + "/" + person.ID
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	req, problem := newRequest(plans, person, r.PostFormValue("art"), r.PostFormValue("mein"), r.PostFormValue("an"), r.PostFormValue("ziel"))
	if problem != "" {
		renderPage(w, http.StatusBadRequest, messagePage, pageData{Message: problem, Back: back})
		return
	}
	open, err := s.store.PlanRequests(r.Context(), link.PeriodID, store.RequestOpen)
	if err != nil {
		internal(w, err)
		return
	}
	mine := 0
	for _, o := range open {
		if o.FromPerson == person.ID {
			mine++
			if o.Kind == req.Kind && o.ToPerson == req.ToPerson && o.FromSlot == req.FromSlot && o.ToSlot == req.ToSlot {
				backTo(w, r, person.ID, "gesendet", req)
				return
			}
		}
	}
	if mine >= maxOpenPerPerson || len(open) >= maxOpenPerPeriod {
		renderPage(w, http.StatusTooManyRequests, messagePage, pageData{Message: "Du hast schon viele offene Anfragen. Warte auf Antworten oder ziehe welche zurück.", Back: back})
		return
	}
	req.ID = auth.NewToken()[:22]
	req.PeriodID = link.PeriodID
	if err := s.store.AddPlanRequest(r.Context(), req); err != nil {
		internal(w, err)
		return
	}
	backTo(w, r, person.ID, "gesendet", req)
}

// newRequest prüft eine Anfrage gegen die veröffentlichten Pläne; ein Text erklärt, was nicht geht.
func newRequest(plans planContent, person *planPerson, kind, mySlot, toPerson, toSlot string) (store.PlanRequest, string) {
	target := plans.person(toPerson)
	if target == nil || target.ID == person.ID {
		return store.PlanRequest{}, "Diese Person gibt es nicht."
	}
	theirs, theirEntry, found := target.slot(toSlot)
	if !found {
		return store.PlanRequest{}, "Diesen Termin gibt es nicht mehr."
	}
	req := store.PlanRequest{Kind: kind, FromPerson: person.ID, ToPerson: target.ID, ToSlot: toSlot, ToLabel: theirs.Label}
	switch kind {
	case store.RequestSwap:
		own, ownEntry, ok := person.slot(mySlot)
		if !ok || !ownEntry.Swap || !theirEntry.Swap {
			return req, "Diese Termine lassen sich nicht tauschen."
		}
		if ownEntry.Teacher != theirEntry.Teacher {
			return req, "Tauschen geht nur bei derselben Lehrkraft."
		}
		req.FromSlot, req.FromLabel = mySlot, own.Label
	case store.RequestJoin:
		if !theirEntry.Join {
			return req, "Zu diesem Termin kann man nicht dazukommen."
		}
		if _, _, already := person.slot(toSlot); already {
			return req, "Bei diesem Termin bist du schon dabei."
		}
	default:
		return req, "Unbekannte Anfrage."
	}
	return req, ""
}

// answerRequest: annehmen oder ablehnen (wer gefragt wurde), zurückziehen (wer gefragt hat).
func (s *Server) answerRequest(w http.ResponseWriter, r *http.Request) {
	_, link, person, ok := s.requester(w, r)
	if !ok {
		return
	}
	back := s.planURL(link.Token) + "/" + person.ID
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	id, answer := r.PostFormValue("anfrage"), r.PostFormValue("antwort")
	requests, err := s.store.PlanRequests(r.Context(), link.PeriodID)
	if err != nil {
		internal(w, err)
		return
	}
	i := slices.IndexFunc(requests, func(req store.PlanRequest) bool { return req.ID == id })
	if i < 0 {
		backTo(w, r, person.ID, "veraltet", store.PlanRequest{})
		return
	}
	req := requests[i]
	var notice string
	switch {
	case answer == "ja" && req.ToPerson == person.ID:
		err, notice = s.store.AcceptPlanRequest(r.Context(), req, takenNote), "angenommen"
	case answer == "nein" && req.ToPerson == person.ID:
		err, notice = s.store.SetPlanRequestStatus(r.Context(), link.PeriodID, id, store.RequestOpen, store.RequestDeclined, ""), "abgelehnt"
	case answer == "zurueck" && req.FromPerson == person.ID:
		err, notice = s.store.SetPlanRequestStatus(r.Context(), link.PeriodID, id, store.RequestOpen, store.RequestWithdrawn, ""), "zurueckgezogen"
	default:
		renderPage(w, http.StatusForbidden, messagePage, pageData{Message: "Diese Anfrage kannst du nicht beantworten.", Back: back})
		return
	}
	if errors.Is(err, store.ErrStale) || errors.Is(err, store.ErrNotFound) {
		notice = "veraltet"
	} else if err != nil {
		internal(w, err)
		return
	}
	backTo(w, r, person.ID, notice, store.PlanRequest{})
}

// backTo leitet nach einer Aktion zurück auf die Seite der Person, relativ zur Adresse des Formulars
// (…/<Person>/anfragen → …/<Person>), damit es auch hinter einem Proxy mit eigenem Pfad passt.
// Nach einer neuen Anfrage (`sent`) nennt die Adresse auch, wen sie betrifft, damit die Seite dessen Link anbietet.
func backTo(w http.ResponseWriter, r *http.Request, personID, notice string, sent store.PlanRequest) {
	query := url.Values{"hinweis": {notice}}
	if sent.ToPerson != "" {
		query.Set("an", sent.ToPerson)
		query.Set("art", sent.Kind)
	}
	http.Redirect(w, r, "../"+personID+"?"+query.Encode(), http.StatusSeeOther)
}

// --- Für die Apps der Lehrkräfte ---

type requestAnswer struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	From     string `json:"from"`
	To       string `json:"to"`
	FromSlot string `json:"fromSlot"`
	ToSlot   string `json:"toSlot"`
}

// acceptedRequests liefert die angenommenen Anfragen, die die App in die Daten übernehmen soll.
func (s *Server) acceptedRequests(w http.ResponseWriter, r *http.Request, account store.Account) {
	periodID, _, ok := s.planPeriod(w, r, account)
	if !ok {
		return
	}
	requests, err := s.store.PlanRequests(r.Context(), periodID, store.RequestAccepted)
	if err != nil {
		internal(w, err)
		return
	}
	list := make([]requestAnswer, 0, len(requests))
	for _, req := range requests {
		list = append(list, requestAnswer{ID: req.ID, Kind: req.Kind, From: req.FromPerson, To: req.ToPerson, FromSlot: req.FromSlot, ToSlot: req.ToSlot})
	}
	writeJSON(w, list)
}

// requestDone: Die App hat eine angenommene Anfrage übernommen (`applied`) oder konnte es nicht (`failed`, mit
// Grund für die Seite).
func (s *Server) requestDone(w http.ResponseWriter, r *http.Request, account store.Account) {
	periodID, _, ok := s.planPeriod(w, r, account)
	if !ok {
		return
	}
	var body struct{ Status, Note string }
	if !readJSON(w, r, &body) {
		return
	}
	if body.Status != store.RequestApplied && body.Status != store.RequestFailed {
		fail(w, http.StatusBadRequest, "Zustand muss applied oder failed sein.")
		return
	}
	note := strings.TrimSpace(body.Note)
	if len(note) > 300 {
		note = note[:300]
	}
	err := s.store.SetPlanRequestStatus(r.Context(), periodID, r.PathValue("id"), store.RequestAccepted, body.Status, note)
	switch {
	case errors.Is(err, store.ErrNotFound):
		fail(w, http.StatusNotFound, "Diese Anfrage gibt es nicht.")
	case errors.Is(err, store.ErrStale):
		// Ein anderes Gerät war schneller; das Ergebnis ist dasselbe.
		w.WriteHeader(http.StatusNoContent)
	case err != nil:
		internal(w, err)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}
