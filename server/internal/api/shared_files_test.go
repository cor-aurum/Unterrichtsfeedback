package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/store"
)

type sharedList struct {
	Received []sharedFileEntry
	Sent     []sharedFileEntry
}

func listShared(t *testing.T, c *client) sharedList {
	t.Helper()
	var list sharedList
	if err := json.Unmarshal([]byte(c.must(200, "GET", "/api/shared-files", "")), &list); err != nil {
		t.Fatal(err)
	}
	return list
}

func sharedID(t *testing.T, text string) string {
	t.Helper()
	var answer struct{ ID string }
	if err := json.Unmarshal([]byte(text), &answer); err != nil || answer.ID == "" {
		t.Fatalf("keine Datei: %s", text)
	}
	return answer.ID
}

// Bereitgestellte PDFs: nur Absenderin und Empfängerinnen sehen sie, „geöffnet“ sieht die Absenderin, nach 30 Tagen
// sind sie weg.
func TestSharedFiles(t *testing.T) {
	srv, base := setup(t)
	code, _, err := srv.NewCode(context.Background(), store.Invite, "")
	if err != nil {
		t.Fatal(err)
	}
	anna := &client{t: t, base: base}
	anna.session(anna.must(200, "POST", "/api/redeem", `{"code":"`+code+`","username":"anna","password":"geheim123","teacherId":"t-anna"}`))
	join := func(username, teacherID string) *client {
		var invite struct{ Code string }
		_ = json.Unmarshal([]byte(anna.must(200, "POST", "/api/invites", `{"teacherId":"`+teacherID+`"}`)), &invite)
		c := &client{t: t, base: base}
		c.session(c.must(200, "POST", "/api/redeem", `{"code":"`+invite.Code+`","username":"`+username+`","password":"passwort1"}`))
		return c
	}
	ben, cleo := join("ben", "t-ben"), join("cleo", "t-cleo")
	anna.must(200, "PUT", "/api/docs/berichtszeitraum_p1.json", period("p1", "t-anna", "t-ben", "t-cleo"))

	raw := "%PDF-1.4 Feedback"
	pdf := base64.StdEncoding.EncodeToString([]byte(raw))
	anna.must(400, "POST", "/api/shared-files?name=x.pdf&to=t-ben", base64.StdEncoding.EncodeToString([]byte("kein PDF")))
	anna.must(400, "POST", "/api/shared-files?name=x.pdf&to=t-ben", "kein Base64!")
	anna.must(400, "POST", "/api/shared-files?name=x.pdf&to=t-unbekannt", pdf)
	anna.must(400, "POST", "/api/shared-files?name=x.pdf&to=t-anna", pdf) // nicht an sich selbst
	cleo.must(403, "POST", "/api/shared-files?name=x.pdf&period=p2", pdf)

	// An Ben allein: Cleo sieht nichts, Ben öffnet, Anna sieht es.
	single := sharedID(t, anna.must(200, "POST", "/api/shared-files?name=../Feedback%20Anna.pdf&to=t-ben", pdf))
	if list := listShared(t, cleo); len(list.Received) != 0 {
		t.Fatalf("Cleo sieht fremde Datei: %+v", list)
	}
	cleo.must(404, "GET", "/api/shared-files/"+single, "")
	if got := ben.must(200, "GET", "/api/shared-files/"+single+"?format=base64", ""); got != pdf {
		t.Fatalf("Inhalt: %q", got)
	}
	if got := ben.must(200, "GET", "/api/shared-files/"+single, ""); got != raw {
		t.Fatalf("PDF: %q", got)
	}
	sent := listShared(t, anna).Sent
	if len(sent) != 1 || sent[0].Name != ".._Feedback Anna.pdf" || len(sent[0].To) != 1 || sent[0].To[0].OpenedAt == "" {
		t.Fatalf("gesendet: %+v", sent)
	}

	// An alle des Zeitraums: Ben und Cleo, nicht Anna selbst; Cleo hat noch nicht geöffnet.
	all := sharedID(t, anna.must(200, "POST", "/api/shared-files?name=Gruppen.pdf&period=p1", pdf))
	received := listShared(t, cleo).Received
	if len(received) != 1 || received[0].ID != all || received[0].From != "t-anna" || received[0].OpenedAt != "" || received[0].PeriodID != "p1" {
		t.Fatalf("Cleo: %+v", received)
	}
	if to := listShared(t, anna).Sent[0].To; len(to) != 2 {
		t.Fatalf("Empfängerinnen: %+v", to)
	}

	// Ben erledigt sie für sich, Cleo behält sie, Anna sieht „erledigt“; zieht Anna zurück, ist sie für alle weg.
	ben.must(204, "DELETE", "/api/shared-files/"+all, "")
	ben.must(404, "GET", "/api/shared-files/"+all, "")
	ben.must(404, "DELETE", "/api/shared-files/"+all, "")
	if list := listShared(t, ben); len(list.Received) != 1 || list.Received[0].ID != single {
		t.Fatalf("Ben nach Erledigt: %+v", list.Received)
	}
	if to := listShared(t, anna).Sent[0].To; to[0].TeacherID != "t-ben" || to[0].DoneAt == "" || to[1].DoneAt != "" {
		t.Fatalf("Erledigt bei Anna: %+v", to)
	}
	cleo.must(200, "GET", "/api/shared-files/"+all, "")
	cleo.must(404, "DELETE", "/api/shared-files/"+single, "")
	anna.must(204, "DELETE", "/api/shared-files/"+all, "")
	cleo.must(404, "GET", "/api/shared-files/"+all, "")

	// Nach 30 Tagen räumt der Server auf.
	if err := srv.store.PurgeSharedFiles(context.Background(), time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	ben.must(404, "GET", "/api/shared-files/"+single, "")
	if list := listShared(t, anna); len(list.Sent) != 0 {
		t.Fatalf("nicht aufgeräumt: %+v", list)
	}
}

func TestSharedFileName(t *testing.T) {
	for in, want := range map[string]string{
		"Feedback.pdf":           "Feedback.pdf",
		"a/b\\c:d":               "a_b_c_d.pdf",
		"  ":                     "",
		strings.Repeat("x", 200): strings.Repeat("x", 120) + ".pdf",
	} {
		if got := sharedFileName(in); got != want {
			t.Errorf("%q: %q, erwartet %q", in, got, want)
		}
	}
}
