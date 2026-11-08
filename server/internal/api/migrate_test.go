package api

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/access"
)

// Ältere Daten: Zeiträume in der Konfiguration, Zeiten und Orte je Zeitraum beim Lehrer, alle allgemeinen Termine
// zusammen. Danach hat jeder Zeitraum sein Dokument, und in den für alle lesbaren steht nichts mehr davon.
func TestMigrate(t *testing.T) {
	srv, _ := setup(t)
	ctx := context.Background()
	put := func(name, content string) {
		if _, err := srv.store.PutDoc(ctx, name, []byte(content), 0); err != nil {
			t.Fatal(err)
		}
	}
	put(access.ConfigName, `{"format":"unterricht-feedback/konfiguration","config":{"title":"T","reportPeriods":[
		{"id":"p1","name":"Herbst","from":"2026-08-01","to":"2027-01-31","teacherIds":["anna"]},
		{"id":"p2","name":"Frühjahr","from":"2027-02-01","to":"2027-07-31","teacherIds":["ben"]}]}}`)
	put("lehrer-anna.json", `{"teacher":{"id":"anna","periodWindows":{"p1":[{"weekday":0}]},"periodLocations":{"p1":"Raum 1"}}}`)
	put(access.SharedName, `{"appointments":[
		{"id":"a1","date":"2026-09-01","teacherIds":["anna"]},
		{"id":"a2","date":"2027-03-01","teacherIds":["ben"]},
		{"id":"a3","date":"2025-01-01","teacherIds":["anna"]}]}`)

	if err := srv.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	read := func(name string) string {
		content, _, err := srv.store.Doc(ctx, name)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		return string(content)
	}
	if c := read(access.ConfigName); strings.Contains(c, "reportPeriods") || !strings.Contains(c, `"title": "T"`) {
		t.Errorf("Konfiguration: %s", c)
	}
	if c := read("lehrer-anna.json"); strings.Contains(c, "Raum 1") || strings.Contains(c, "periodWindows") {
		t.Errorf("Lehrer: %s", c)
	}
	if c := read(access.SharedName); !strings.Contains(c, "a3") || strings.Contains(c, `"a1"`) || strings.Contains(c, `"a2"`) {
		t.Errorf("Allgemeine Termine: %s", c)
	}
	var p1 struct {
		Period             struct{ Name string }
		Teachers           map[string]struct{ Location string }
		SharedAppointments []struct{ ID string }
	}
	_ = json.Unmarshal([]byte(read("berichtszeitraum_p1.json")), &p1)
	if p1.Period.Name != "Herbst" || p1.Teachers["anna"].Location != "Raum 1" || len(p1.SharedAppointments) != 1 || p1.SharedAppointments[0].ID != "a1" {
		t.Errorf("p1: %+v", p1)
	}
	if c := read("berichtszeitraum_p2.json"); !strings.Contains(c, `"a2"`) {
		t.Errorf("p2: %s", c)
	}
	// Ein zweiter Lauf ändert nichts mehr.
	if err := srv.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	members, err := srv.members(ctx)
	if err != nil || !members.In("p1", "anna") || members.In("p1", "ben") || !members.In("p2", "ben") {
		t.Errorf("Mitglieder: %v %v", members, err)
	}
}
