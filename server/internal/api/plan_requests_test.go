package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/store"
)

// Person mit einem Termin; `day` vor heute ist vergangen.
func slotPerson(id, label, day, slot, teacher string) planPerson {
	return planPerson{
		ID: id, Label: label, ICS: calendarText, PDF: pdfBase64,
		Days: []planDay{{Day: day, Date: "Tag " + day, Entries: []planEntry{{
			Time: "10:00–10:45", Title: "Unterricht bei " + teacher, Slot: slot, Teacher: teacher, Swap: true, Join: true,
		}}}},
	}
}

// post schickt ein Formular und folgt der Weiterleitung auf die Seite der Person.
func post(t *testing.T, base, path string, form url.Values) (int, string) {
	t.Helper()
	res, err := http.Post(base+path, "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(data)
}

// Tauschen und Dazukommen ohne Lehrkraft: anfragen, annehmen, ablehnen, zurückziehen; die App übernimmt.
func TestPlanRequests(t *testing.T) {
	srv, base := setup(t)
	code, _, err := srv.NewCode(context.Background(), store.Invite, "")
	if err != nil {
		t.Fatal(err)
	}
	anna := &client{t: t, base: base}
	anna.session(anna.must(200, "POST", "/api/redeem", `{"code":"`+code+`","username":"anna","password":"geheim123","teacherId":"t-anna"}`))
	anna.must(200, "PUT", "/api/docs/berichtszeitraum_p1.json", period("p1", "t-anna"))
	link := planPath(t, anna.must(200, "POST", "/api/plans/p1/address", ""))
	future, past := "2099-12-01", "2000-01-01"
	plans := planContent{Title: "Lehrgang", People: []planPerson{
		slotPerson("lea", "Lea", future, "a-lea", "t-anna"),
		slotPerson("max", "Max", future, "a-max", "t-anna"),
		slotPerson("mia", "Mia", future, "a-mia", "t-anna"),
		slotPerson("tom", "Tom", future, "a-tom", "t-ben"),
		slotPerson("old", "Olga", past, "a-old", "t-anna"),
	}}
	data, _ := json.Marshal(plans)
	anna.must(204, "PUT", "/api/plans/p1", string(data))

	// Tauschen: nur künftige Termine bei derselben Lehrkraft
	swap := func(from, mine, to, theirs string) (int, string) {
		return post(t, base, link+"/"+from+"/anfragen", url.Values{"art": {"swap"}, "mein": {mine}, "an": {to}, "ziel": {theirs}})
	}
	page := (&client{t: t, base: base}).must(200, "GET", link+"/lea/tauschen?termin=a-lea", "")
	if !strings.Contains(page, "Max") || strings.Contains(page, "Tom") || strings.Contains(page, "Olga") {
		t.Fatalf("Tauschangebote: %s", page)
	}
	if status, text := swap("lea", "a-lea", "tom", "a-tom"); status != 400 || !strings.Contains(text, "derselben Lehrkraft") {
		t.Fatalf("Tausch mit anderer Lehrkraft: %d", status)
	}
	if status, _ := swap("olga", "a-old", "max", "a-max"); status != 404 {
		t.Fatalf("unbekannte Person: %d", status)
	}
	if status, _ := swap("lea", "a-lea", "old", "a-old"); status != 400 {
		t.Fatalf("Tausch mit vergangenem Termin: %d", status)
	}
	status, text := swap("lea", "a-lea", "max", "a-max")
	if status != 200 || !strings.Contains(text, "Wartet auf Max") {
		t.Fatalf("Tauschanfrage: %d %s", status, text)
	}
	// Lea soll Max Bescheid sagen: mit dem Link zu seiner Seite und einer Nachricht zum Teilen
	if !strings.Contains(text, "Sag <strong>Max</strong> Bescheid") || !strings.Contains(text, link+"/max") || !strings.Contains(text, "zum Tauschen unserer Termine") {
		t.Fatalf("Bescheid sagen: %s", text)
	}
	swap("lea", "a-lea", "max", "a-max") // doppelt: keine zweite Anfrage
	swap("mia", "a-mia", "max", "a-max")
	if names := (&client{t: t, base: base}).must(200, "GET", link, ""); !strings.Contains(names, "2 Anfragen") {
		t.Fatalf("Namensliste ohne offene Anfragen: %s", names)
	}
	res, err := http.Get(base + link + "/max")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if csp := res.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "script-src '"+pageScriptHash+"'") {
		t.Fatalf("Skript nicht erlaubt: %s", csp)
	}
	maxPage := (&client{t: t, base: base}).must(200, "GET", link+"/max", "")
	if strings.Count(maxPage, `value="ja"`) != 2 || !strings.Contains(maxPage, "Lea möchte mit dir tauschen") {
		t.Fatalf("Anfragen an Max: %s", maxPage)
	}

	// Max nimmt Leas Anfrage an; Mias geht dann nicht mehr.
	open, _ := srv.store.PlanRequests(context.Background(), "p1", store.RequestOpen)
	var leaID, miaID string
	for _, r := range open {
		if r.FromPerson == "lea" {
			leaID = r.ID
		} else {
			miaID = r.ID
		}
	}
	if status, _ := post(t, base, link+"/lea/antworten", url.Values{"anfrage": {leaID}, "antwort": {"ja"}}); status != 403 {
		t.Fatalf("Lea nimmt ihre eigene Anfrage an: %d", status)
	}
	if _, text := post(t, base, link+"/max/antworten", url.Values{"anfrage": {leaID}, "antwort": {"ja"}}); !strings.Contains(text, "Angenommen.") {
		t.Fatalf("Annehmen: %s", text)
	}
	if _, text := post(t, base, link+"/max/antworten", url.Values{"anfrage": {miaID}, "antwort": {"ja"}}); !strings.Contains(text, "nicht mehr offen") {
		t.Fatalf("zweites Annehmen: %s", text)
	}
	if page := (&client{t: t, base: base}).must(200, "GET", link+"/mia", ""); !strings.Contains(page, "Nicht mehr möglich") {
		t.Fatalf("Mias Anfrage: %s", page)
	}

	// Die App holt angenommene Anfragen und meldet sie als übernommen.
	var accepted []requestAnswer
	_ = json.Unmarshal([]byte(anna.must(200, "GET", "/api/plans/p1/requests", "")), &accepted)
	if len(accepted) != 1 || accepted[0].Kind != "swap" || accepted[0].FromSlot != "a-lea" || accepted[0].ToSlot != "a-max" {
		t.Fatalf("angenommen: %+v", accepted)
	}
	anna.must(400, "POST", "/api/plans/p1/requests/"+leaID, `{"status":"open"}`)
	anna.must(204, "POST", "/api/plans/p1/requests/"+leaID, `{"status":"applied"}`)
	anna.must(204, "POST", "/api/plans/p1/requests/"+leaID, `{"status":"applied"}`) // zweites Gerät
	if anna.must(200, "GET", "/api/plans/p1/requests", "") != "[]\n" {
		t.Fatal("übernommene Anfrage noch offen")
	}
	if page := (&client{t: t, base: base}).must(200, "GET", link+"/lea", ""); !strings.Contains(page, "Erledigt") {
		t.Fatalf("Leas Seite: %s", page)
	}

	// Dazukommen auch bei anderer Lehrkraft; ablehnen und zurückziehen
	join := func(from, to, theirs string) (int, string) {
		return post(t, base, link+"/"+from+"/anfragen", url.Values{"art": {"join"}, "an": {to}, "ziel": {theirs}})
	}
	if page := (&client{t: t, base: base}).must(200, "GET", link+"/lea/dazukommen", ""); !strings.Contains(page, "Tom") || strings.Contains(page, "Olga") {
		t.Fatalf("Angebote zum Dazukommen: %s", page)
	}
	if status, _ := join("lea", "tom", "a-tom"); status != 200 {
		t.Fatalf("Dazukommen: %d", status)
	}
	open, _ = srv.store.PlanRequests(context.Background(), "p1", store.RequestOpen)
	if _, text := post(t, base, link+"/tom/antworten", url.Values{"anfrage": {open[0].ID}, "antwort": {"nein"}}); !strings.Contains(text, "abgelehnt") {
		t.Fatalf("Ablehnen: %s", text)
	}
	join("max", "tom", "a-tom")
	open, _ = srv.store.PlanRequests(context.Background(), "p1", store.RequestOpen)
	post(t, base, link+"/max/antworten", url.Values{"anfrage": {open[0].ID}, "antwort": {"zurueck"}})
	if page := (&client{t: t, base: base}).must(200, "GET", link+"/tom", ""); strings.Contains(page, `value="ja"`) {
		t.Fatalf("zurückgezogene Anfrage noch offen: %s", page)
	}

	// Mit dem Link verschwinden auch die Anfragen.
	anna.must(204, "DELETE", "/api/plans/p1", "")
	if all, _ := srv.store.PlanRequests(context.Background(), "p1"); len(all) != 0 {
		t.Fatalf("Anfragen nach dem Löschen: %d", len(all))
	}
}
