package api

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/store"
)

func boardJSON(day string, entries ...boardEntry) string {
	board := boardContent{
		Title: "Herbstlehrgang", Dates: "1. August – 31. Januar 2027", Color: "#123456",
		From: "2026-08-01", To: "2027-01-31",
		Columns: []boardColumn{{ID: "all", Name: "Für alle"}, {ID: "t-anna", Name: "Anna"}},
		Days:    []boardDay{{Day: day, Date: "Montag, 9. November 2026", Entries: entries}},
	}
	data, _ := json.Marshal(board)
	return string(data)
}

var (
	singleEntry = boardEntry{Column: "t-anna", Start: 14 * 60, End: 14*60 + 45, Time: "14:00–14:45", Title: "Lea <b>B.</b>", Kind: "single", Location: "Raum 3", Teacher: "Anna", Lanes: 1}
	groupEntry  = boardEntry{Column: "t-anna", Start: 15 * 60, End: 16 * 60, Time: "15:00–16:00", Title: "Gruppe Chor", Kind: "group", Teacher: "Anna", Members: []string{"Ben K.", "Lea B."}, Lanes: 1}
	sharedEntry = boardEntry{Column: "all", Start: 8 * 60, End: 8*60 + 20, Time: "ab 08:00", Title: "Abfahrt", Kind: "shared", Location: "Parkplatz", Lanes: 1}
)

// Ein Aushang je Berichtszeitraum: verwalten dürfen ihn nur dessen Lehrer, ansehen jeder mit dem Link.
func TestBoards(t *testing.T) {
	srv, base := setup(t)
	code, _, err := srv.NewCode(context.Background(), store.Invite, "")
	if err != nil {
		t.Fatal(err)
	}
	anna := &client{t: t, base: base}
	anna.session(anna.must(200, "POST", "/api/redeem", `{"code":"`+code+`","username":"anna","password":"geheim123","teacherId":"t-anna"}`))
	var invite struct{ Code string }
	_ = json.Unmarshal([]byte(anna.must(200, "POST", "/api/invites", `{"teacherId":"t-ben"}`)), &invite)
	ben := &client{t: t, base: base}
	ben.session(ben.must(200, "POST", "/api/redeem", `{"code":"`+invite.Code+`","username":"ben","password":"passwort1"}`))
	guest := &client{t: t, base: base}

	anna.must(200, "PUT", "/api/docs/berichtszeitraum_p1.json", period("p1", "t-anna"))
	ben.must(403, "GET", "/api/boards/p1", "")
	ben.must(403, "POST", "/api/boards/p1/address", "")
	guest.must(401, "GET", "/api/boards/p1", "")

	day := "2026-11-09"
	anna.must(404, "PUT", "/api/boards/p1", boardJSON(day, singleEntry))
	first := boardPath(t, anna.must(200, "POST", "/api/boards/p1/address", ""))
	if page := guest.must(200, "GET", first, ""); !strings.Contains(page, "vorbereitet") {
		t.Fatalf("leerer Aushang: %s", page)
	}

	// Ungültig: unbekannte Spalte, Ende vor Beginn, Spur außerhalb, unbekannte Art
	broken := []boardEntry{singleEntry, singleEntry, singleEntry, singleEntry}
	broken[0].Column = "t-max"
	broken[1].End = broken[1].Start
	broken[2].Lane = 1
	broken[3].Kind = "blocker"
	for _, entry := range broken {
		anna.must(400, "PUT", "/api/boards/p1", boardJSON(day, entry))
	}
	anna.must(400, "PUT", "/api/boards/p1", boardJSON("9.11.2026", singleEntry))
	anna.must(204, "PUT", "/api/boards/p1", boardJSON(day, singleEntry, groupEntry, sharedEntry))

	// Der Tag zeigt Kurznamen (maskiert), Ort, Spalten und die Mitglieder im Fenster der Gruppe; nichts zum Ändern
	page := guest.must(200, "GET", first+"?tag="+day, "")
	for _, want := range []string{"Lea &lt;b&gt;B.&lt;/b&gt;", "Raum 3", "Gruppe Chor", "<li>Ben K.</li>", "Abfahrt", "ab 08:00", "Für alle", "#123456", `content="60;url=`} {
		if !strings.Contains(page, want) {
			t.Fatalf("Aushang ohne %q: %s", want, page)
		}
	}
	if strings.Contains(page, "<form") || strings.Contains(page, "<script") {
		t.Fatal("Aushang mit Formular oder Skript")
	}
	// Blättern: Tage ohne Termine sind leer, Tage außerhalb des Zeitraums gibt es nicht.
	if page := guest.must(200, "GET", first+"?tag=2026-11-10", ""); !strings.Contains(page, "keine Termine") || !strings.Contains(page, "Dienstag, 10. November 2026") {
		t.Fatalf("Tag ohne Termine: %s", page)
	}
	if page := guest.must(200, "GET", first+"?tag=2030-01-01", ""); !strings.Contains(page, "Sonntag, 31. Januar 2027") || strings.Contains(page, "?tag=2027-02-01") {
		t.Fatalf("nach dem Zeitraum: %s", page)
	}

	// Neuer Link: Der alte gilt nicht mehr, die Termine bleiben.
	second := boardPath(t, anna.must(200, "POST", "/api/boards/p1/address", ""))
	guest.must(404, "GET", first, "")
	guest.must(200, "GET", second, "")

	// Abgelaufen: 14 Tage nach dem Ende des Zeitraums
	anna.must(200, "PUT", "/api/docs/berichtszeitraum_p1.json", strings.Replace(period("p1", "t-anna"), "2027-01-31", "2026-01-31", 1))
	guest.must(410, "GET", second, "")

	anna.must(204, "DELETE", "/api/boards/p1", "")
	guest.must(404, "GET", second, "")
}

// Spalten ohne Termine fallen weg; die Uhrzeit von jetzt steht nur heute im Raster.
func TestBoardView(t *testing.T) {
	var board boardContent
	if err := json.Unmarshal([]byte(boardJSON("2026-11-09", singleEntry, groupEntry)), &board); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 9, 14, 30, 0, 0, time.Local)
	view := newBoardView(board, "https://x/api/aushang/t", "", now)
	if !view.Today || !view.ShowNow || len(view.Columns) != 1 || view.Columns[0].Name != "Anna" {
		t.Fatalf("heute: %+v", view)
	}
	if !view.Entries[0].Running || view.Entries[1].Running {
		t.Fatal("laufender Termin falsch erkannt")
	}
	if view.Hours[0].Label != "14:00" || len(view.Hours) != 4 {
		t.Fatalf("Stunden: %+v", view.Hours)
	}
	other := newBoardView(board, "https://x/api/aushang/t", "2026-11-09", now.AddDate(0, 0, 1))
	if other.Today || other.ShowNow || other.Entries[0].Running {
		t.Fatalf("anderer Tag: %+v", other)
	}
}

func boardPath(t *testing.T, text string) string {
	t.Helper()
	var answer planAnswer
	_ = json.Unmarshal([]byte(text), &answer)
	path, ok := strings.CutPrefix(answer.URL, "https://feedback.example.de")
	if !ok || !strings.HasPrefix(path, "/api/aushang/") {
		t.Fatalf("Aushang-Link: %q", answer.URL)
	}
	return path
}
