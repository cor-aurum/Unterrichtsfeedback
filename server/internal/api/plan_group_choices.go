package api

import (
	"errors"
	"fmt"
	"html/template"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/store"
)

// Gruppenwahl über den Download-Link: Jede Person wählt auf ihrer Seite genau eine der angebotenen Gruppen. Welche
// Gruppen es gibt und in welcher die Person ist, schickt die App mit den Plänen; der Server merkt sich die Wahl, bis
// die App einer Lehrkraft sie beim Abgleich übernimmt. Eine neue Wahl ersetzt eine noch offene ältere.

const (
	// Gegen Massen von Wahlen (auch ersetzte zählen)
	maxGroupChoicesPerPeriod = 5000
	// So lange zählt eine übernommene Wahl höchstens, bis die Pläne sie zeigen.
	choiceHold = time.Hour
)

var choiceNotices = map[string]string{
	"gewaehlt": "Gewählt. Die Gruppe steht in deinem Plan, sobald eine Lehrkraft-App die Wahl übernommen hat – meist nach wenigen Minuten.",
	"veraltet": "Diese Gruppe steht nicht mehr zur Wahl. Die Seite zeigt den aktuellen Stand.",
}

// planGroupChoice sind die Gruppen zur Wahl, wie die App sie mitschickt.
type planGroupChoice struct {
	Groups []choiceGroup `json:"groups"`
}

type choiceGroup struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Members int    `json:"members"`
}

func (c *planGroupChoice) group(id string) *choiceGroup {
	for i := range c.Groups {
		if c.Groups[i].ID == id {
			return &c.Groups[i]
		}
	}
	return nil
}

// checkGroupChoice prüft die Gruppen zur Wahl und die gewählte Gruppe jeder Person.
func checkGroupChoice(plans planContent) error {
	choice := plans.GroupChoice
	if choice == nil {
		for _, person := range plans.People {
			if person.Group != "" {
				return fmt.Errorf("Gruppe von %s ohne Gruppenwahl", person.ID)
			}
		}
		return nil
	}
	seen := map[string]bool{}
	for _, group := range choice.Groups {
		if !personIDPattern.MatchString(group.ID) || seen[group.ID] || strings.TrimSpace(group.Name) == "" {
			return fmt.Errorf("ungültige oder doppelte Gruppe %q", group.ID)
		}
		seen[group.ID] = true
	}
	for _, person := range plans.People {
		if person.Group != "" && !seen[person.Group] {
			return fmt.Errorf("Gruppe von %s steht nicht zur Wahl", person.ID)
		}
	}
	return nil
}

// currentChoice ist die Gruppe der Person: die zuletzt gewählte, solange die App sie noch nicht übernommen hat oder
// die Pläne sie noch nicht zeigen, sonst die aus den Plänen. `pending`: Die Wahl ist noch nicht im Plan.
func currentChoice(person *planPerson, choices []store.PlanGroupChoice) (groupID string, pending bool) {
	for _, c := range choices {
		if c.Person != person.ID || c.Status == store.RequestWithdrawn {
			continue
		}
		// Die neueste Wahl der Person entscheidet.
		switch {
		case c.Status == store.RequestOpen:
			return c.Group, true
		case c.Status == store.RequestApplied && person.Group != c.Group && time.Since(c.UpdatedAt) <= choiceHold:
			return c.Group, true
		}
		break
	}
	return person.Group, false
}

type choiceView struct {
	Groups  []choiceGroup
	Current string
	Pending bool
	// Hat die letzte Wahl nicht geklappt, der Grund
	Failed string
}

// CurrentName ist der Name der gewählten Gruppe; leer ohne Wahl.
func (v *choiceView) CurrentName() string {
	for _, g := range v.Groups {
		if g.ID == v.Current {
			return g.Name
		}
	}
	return ""
}

// choiceFor stellt die Gruppenwahl der Person zusammen; nil ohne Gruppenwahl.
func (s *Server) choiceFor(r *http.Request, plans planContent, link store.PlanLink, person *planPerson) (*choiceView, error) {
	if plans.GroupChoice == nil || len(plans.GroupChoice.Groups) == 0 {
		return nil, nil
	}
	choices, err := s.store.PlanGroupChoices(r.Context(), link.PeriodID)
	if err != nil {
		return nil, err
	}
	current, pending := currentChoice(person, choices)
	view := &choiceView{Groups: plans.GroupChoice.Groups, Current: current, Pending: pending}
	for _, c := range choices {
		if c.Person == person.ID && c.Status != store.RequestWithdrawn {
			if c.Status == store.RequestFailed && time.Since(c.UpdatedAt) <= requestHistory {
				view.Failed = c.Note
			}
			break
		}
	}
	return view, nil
}

// groupChoicePage zeigt die Gruppen zur Wahl.
func (s *Server) groupChoicePage(w http.ResponseWriter, r *http.Request) {
	plans, link, person, ok := s.requester(w, r)
	if !ok {
		return
	}
	view, err := s.choiceFor(r, plans, link, person)
	if err != nil {
		internal(w, err)
		return
	}
	base := s.planURL(link.Token)
	if view == nil {
		renderPage(w, http.StatusNotFound, messagePage, pageData{Message: "Gerade gibt es keine Gruppenwahl.", Back: base + "/" + person.ID})
		return
	}
	data := pageData{Plans: plans, Person: person, Base: base, Updated: updatedText(link), Notice: choiceNotices[r.URL.Query().Get("hinweis")], Choice: view}
	renderPage(w, http.StatusOK, groupChoiceTemplate, data)
}

// chooseGroup nimmt eine Wahl an, wenn die Gruppe zur Wahl steht.
func (s *Server) chooseGroup(w http.ResponseWriter, r *http.Request) {
	plans, link, person, ok := s.requester(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	groupID := r.PostFormValue("gruppe")
	if plans.GroupChoice == nil || plans.GroupChoice.group(groupID) == nil {
		choiceBack(w, r, "veraltet")
		return
	}
	choice := store.PlanGroupChoice{ID: newBookingID(), PeriodID: link.PeriodID, Person: person.ID, Group: groupID}
	err := s.store.AddPlanGroupChoice(r.Context(), choice, maxGroupChoicesPerPeriod)
	switch {
	case errors.Is(err, store.ErrLimit):
		renderPage(w, http.StatusConflict, messagePage, pageData{Message: "Gerade sind zu viele Wahlen offen. Bitte versuch es später noch einmal.", Back: s.planURL(link.Token) + "/" + person.ID})
	case err != nil:
		internal(w, err)
	default:
		choiceBack(w, r, "gewaehlt")
	}
}

// choiceBack leitet zurück auf die Seite der Wahl (…/<Person>/gruppe).
func choiceBack(w http.ResponseWriter, r *http.Request, notice string) {
	http.Redirect(w, r, "gruppe?"+url.Values{"hinweis": {notice}}.Encode(), http.StatusSeeOther)
}

// --- Für die Apps der Lehrkräfte ---

type choiceAnswer struct {
	ID     string `json:"id"`
	Person string `json:"person"`
	Group  string `json:"group"`
}

// openGroupChoices liefert die offenen Wahlen, die ältesten zuerst; so gilt am Ende die neueste.
func (s *Server) openGroupChoices(w http.ResponseWriter, r *http.Request, account store.Account) {
	periodID, _, ok := s.planPeriod(w, r, account)
	if !ok {
		return
	}
	all, err := s.store.PlanGroupChoices(r.Context(), periodID)
	if err != nil {
		internal(w, err)
		return
	}
	list := []choiceAnswer{}
	for _, c := range slices.Backward(all) {
		if c.Status == store.RequestOpen {
			list = append(list, choiceAnswer{ID: c.ID, Person: c.Person, Group: c.Group})
		}
	}
	writeJSON(w, list)
}

// groupChoiceDone: Die App hat eine Wahl übernommen (`applied`) oder konnte es nicht (`failed`, mit Grund); 409,
// wenn sie nicht mehr offen ist (z. B. durch eine neuere Wahl ersetzt).
func (s *Server) groupChoiceDone(w http.ResponseWriter, r *http.Request, account store.Account) {
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
	err := s.store.SetPlanGroupChoiceStatus(r.Context(), periodID, r.PathValue("id"), store.RequestOpen, body.Status, note)
	switch {
	case errors.Is(err, store.ErrNotFound):
		fail(w, http.StatusNotFound, "Diese Wahl gibt es nicht.")
	case errors.Is(err, store.ErrStale):
		fail(w, http.StatusConflict, "Diese Wahl ist nicht mehr offen.")
	case err != nil:
		internal(w, err)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

var groupChoiceTemplate = template.Must(template.Must(template.New("choice").Parse(pageLayout)).Parse(`
{{define "title"}}{{.Person.Label}} – Gruppe wählen{{end}}
{{define "content"}}
<a class="back" href="{{.Base}}/{{.Person.ID}}">← Zurück zu deinen Terminen</a>
{{with .Choice}}
<header>
  <h1>Gruppe wählen</h1>
  <p class="muted">{{$.Person.Label}} · {{$.Plans.Title}}</p>
  <p>{{with .CurrentName}}Deine Gruppe: <strong>{{.}}</strong>{{else}}Du hast noch keine Gruppe gewählt.{{end}}
  {{if .Pending}}<br><span class="muted">Kommt gleich in deinen Plan.</span>{{end}}</p>
</header>
{{if $.Notice}}<p class="notice" role="status">{{$.Notice}}</p>{{end}}
{{if .Failed}}<section class="request"><p>Deine letzte Wahl hat nicht geklappt: {{.Failed}}</p></section>{{end}}
<p>Wähle genau eine Gruppe. Du kannst später noch wechseln, solange die Wahl läuft.</p>
{{range .Groups}}
<form method="post" action="{{$.Base}}/{{$.Person.ID}}/gruppe" class="option">
  <input type="hidden" name="gruppe" value="{{.ID}}">
  <span><strong>{{.Name}}</strong><br><span class="muted">{{if eq .Members 1}}1 Person{{else}}{{.Members}} Personen{{end}}</span></span>
  {{if eq .ID $.Choice.Current}}<span class="muted">✓ deine Gruppe</span>{{else}}<button class="button">Wählen</button>{{end}}
</form>
{{end}}
{{end}}
{{if .Updated}}<footer><p class="muted">Stand: {{.Updated}}</p></footer>{{end}}
{{end}}`))
