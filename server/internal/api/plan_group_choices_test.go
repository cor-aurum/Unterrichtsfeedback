package api

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"
	"testing"

	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/store"
)

// Gruppenwahl über den Link: wählen, wechseln (die neueste gilt), die App übernimmt.
func TestGroupChoices(t *testing.T) {
	srv, base := setup(t)
	code, _, err := srv.NewCode(context.Background(), store.Invite, "")
	if err != nil {
		t.Fatal(err)
	}
	anna := &client{t: t, base: base}
	anna.session(anna.must(200, "POST", "/api/redeem", `{"code":"`+code+`","username":"anna","password":"geheim123","teacherId":"t-anna"}`))
	anna.must(200, "PUT", "/api/docs/berichtszeitraum_p1.json", period("p1", "t-anna"))
	link := planPath(t, anna.must(200, "POST", "/api/plans/p1/address", ""))

	plans := planContent{
		Title:       "Lehrgang",
		GroupChoice: &planGroupChoice{Groups: []choiceGroup{{ID: "g-chor", Name: "Chor", Members: 3}, {ID: "g-band", Name: "Band", Members: 1}}},
		People: []planPerson{
			{ID: "lea", Label: "Lea", ICS: calendarText, PDF: pdfBase64},
			{ID: "max", Label: "Max", ICS: calendarText, PDF: pdfBase64, Group: "g-chor"},
		},
	}
	data, _ := json.Marshal(plans)
	anna.must(204, "PUT", "/api/plans/p1", string(data))
	visitor := &client{t: t, base: base}
	choose := func(person, group string) string {
		_, text := post(t, base, link+"/"+person+"/gruppe", url.Values{"gruppe": {group}})
		return text
	}

	if page := visitor.must(200, "GET", link+"/lea", ""); !strings.Contains(page, "Du hast noch keine Gruppe gewählt") {
		t.Fatalf("Hinweis auf der Seite: %s", page)
	}
	if page := visitor.must(200, "GET", link+"/max/gruppe", ""); !strings.Contains(page, "Deine Gruppe: <strong>Chor</strong>") {
		t.Fatalf("Gruppe von Max: %s", page)
	}
	if text := choose("lea", "g-unbekannt"); !strings.Contains(text, "nicht mehr zur Wahl") {
		t.Fatalf("unbekannte Gruppe: %s", text)
	}
	if text := choose("lea", "g-chor"); !strings.Contains(text, "Gewählt.") || !strings.Contains(text, "Deine Gruppe: <strong>Chor</strong>") {
		t.Fatalf("Lea wählt: %s", text)
	}
	if text := choose("lea", "g-band"); !strings.Contains(text, "Deine Gruppe: <strong>Band</strong>") {
		t.Fatalf("Lea wechselt: %s", text)
	}

	// Für die App gilt nur die neueste Wahl.
	var open []choiceAnswer
	_ = json.Unmarshal([]byte(anna.must(200, "GET", "/api/plans/p1/group-choices", "")), &open)
	if len(open) != 1 || open[0].Person != "lea" || open[0].Group != "g-band" {
		t.Fatalf("offene Wahlen: %+v", open)
	}
	anna.must(204, "POST", "/api/plans/p1/group-choices/"+open[0].ID, `{"status":"applied"}`)
	anna.must(409, "POST", "/api/plans/p1/group-choices/"+open[0].ID, `{"status":"applied"}`)
	// Übernommen, aber noch nicht in den Plänen: Die Seite zeigt die Wahl weiter.
	if page := visitor.must(200, "GET", link+"/lea", ""); !strings.Contains(page, "Band") || !strings.Contains(page, "kommt gleich") {
		t.Fatalf("Lea vor den neuen Plänen: %s", page)
	}
	plans.People[0].Group = "g-band"
	data, _ = json.Marshal(plans)
	anna.must(204, "PUT", "/api/plans/p1", string(data))
	if page := visitor.must(200, "GET", link+"/lea", ""); strings.Contains(page, "kommt gleich") || !strings.Contains(page, "Gruppe wechseln") {
		t.Fatalf("Lea nach den neuen Plänen: %s", page)
	}

	// Eine Gruppe, die nicht zur Wahl steht, nimmt der Server nicht an; ohne Gruppenwahl gibt es keine Seite.
	plans.People[1].Group = "g-fremd"
	data, _ = json.Marshal(plans)
	anna.must(400, "PUT", "/api/plans/p1", string(data))
	plans.People[1].Group, plans.People[0].Group, plans.GroupChoice = "", "", nil
	data, _ = json.Marshal(plans)
	anna.must(204, "PUT", "/api/plans/p1", string(data))
	visitor.must(404, "GET", link+"/lea/gruppe", "")
}
