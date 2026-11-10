package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/store"
)

func plansJSON(label, pdf string) string {
	plans := planContent{
		Title: "Herbstlehrgang", Dates: "1. August – 31. Januar 2027", Color: "#123456",
		People: []planPerson{{
			ID: "s-lea", Label: label, ICS: calendarText, PDF: pdf,
			Days: []planDay{{Date: "Montag, 9. November 2026", Entries: []planEntry{{Time: "14:00–14:45", Title: "Unterricht bei Anna", Location: "Raum 3"}}}},
		}},
	}
	data, _ := json.Marshal(plans)
	return string(data)
}

var pdfBase64 = base64.StdEncoding.EncodeToString([]byte("%PDF-1.3 Plan"))

// Ein Download-Link je Berichtszeitraum: verwalten dürfen ihn nur dessen Lehrer, ansehen jeder mit dem Link.
func TestPlans(t *testing.T) {
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

	anna.must(403, "GET", "/api/plans/p1", "") // Zeitraum noch nicht auf dem Server
	anna.must(200, "PUT", "/api/docs/berichtszeitraum_p1.json", period("p1", "t-anna"))
	ben.must(403, "GET", "/api/plans/p1", "")
	ben.must(403, "POST", "/api/plans/p1/address", "")
	guest.must(401, "GET", "/api/plans/p1", "")

	// Ohne Link: keine Adresse, und Pläne werden nicht angenommen
	if answer := planOf(anna); answer.URL != "" || answer.ExpiresAt != "2027-02-14" {
		t.Fatalf("ohne Link: %+v", answer)
	}
	anna.must(404, "PUT", "/api/plans/p1", plansJSON("Lea", pdfBase64))

	first := planPath(t, anna.must(200, "POST", "/api/plans/p1/address", ""))
	if page := guest.must(200, "GET", first, ""); !strings.Contains(page, "vorbereitet") {
		t.Fatalf("leerer Link: %s", page)
	}
	anna.must(400, "PUT", "/api/plans/p1", plansJSON("Lea", "kein PDF"))
	anna.must(400, "PUT", "/api/plans/p1", strings.Replace(plansJSON("Lea", pdfBase64), "s-lea", "../x", 1))
	anna.must(400, "PUT", "/api/plans/p1", plansJSON(" ", pdfBase64))
	anna.must(204, "PUT", "/api/plans/p1", plansJSON("Lea <b>B.</b>", pdfBase64))
	if planOf(anna).UpdatedAt == "" {
		t.Fatal("ohne Zeitpunkt der letzten Änderung")
	}

	// Namensliste, Seite der Person, PDF und Kalender; Namen werden maskiert
	list := guest.must(200, "GET", first, "")
	if !strings.Contains(list, "Lea &lt;b&gt;B.&lt;/b&gt;") || !strings.Contains(list, "Herbstlehrgang") || !strings.Contains(list, "#123456") {
		t.Fatalf("Namensliste: %s", list)
	}
	person := guest.must(200, "GET", first+"/s-lea", "")
	if !strings.Contains(person, "Raum 3") || !strings.Contains(person, "webcal://feedback.example.de/api/plan/") {
		t.Fatalf("Seite der Person: %s", person)
	}
	if pdf := guest.must(200, "GET", first+"/s-lea.pdf", ""); !strings.HasPrefix(pdf, "%PDF") {
		t.Fatalf("PDF: %q", pdf)
	}
	if ics := guest.must(200, "GET", first+"/s-lea.ics", ""); ics != calendarText {
		t.Fatalf("Kalender: %q", ics)
	}
	guest.must(404, "GET", first+"/s-max", "")
	guest.must(404, "GET", first+"/s-lea.txt", "")

	// Neuer Link: Der alte gilt nicht mehr, die Pläne bleiben.
	second := planPath(t, anna.must(200, "POST", "/api/plans/p1/address", ""))
	guest.must(404, "GET", first, "")
	guest.must(200, "GET", second+"/s-lea.pdf", "")

	// Abgelaufen: 14 Tage nach dem Ende des Zeitraums
	anna.must(200, "PUT", "/api/docs/berichtszeitraum_p1.json", strings.Replace(period("p1", "t-anna"), "2027-01-31", "2026-01-31", 1))
	guest.must(410, "GET", second, "")

	anna.must(204, "DELETE", "/api/plans/p1", "")
	guest.must(404, "GET", second, "")
	if planOf(anna).URL != "" {
		t.Fatal("Link nach dem Löschen")
	}
}

func planOf(c *client) planAnswer {
	c.t.Helper()
	var answer planAnswer
	_ = json.Unmarshal([]byte(c.must(200, "GET", "/api/plans/p1", "")), &answer)
	return answer
}

func planPath(t *testing.T, text string) string {
	t.Helper()
	var answer planAnswer
	_ = json.Unmarshal([]byte(text), &answer)
	path, ok := strings.CutPrefix(answer.URL, "https://feedback.example.de")
	if !ok || !strings.HasPrefix(path, "/api/plan/") {
		t.Fatalf("Download-Link: %q", answer.URL)
	}
	return path
}
