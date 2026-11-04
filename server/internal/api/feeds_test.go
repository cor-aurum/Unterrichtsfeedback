package api

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/store"
)

const calendarText = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n"

// Die App schickt ihren Kalender; die Abo-Adresse liefert ihn ohne Anmeldung, bis sie ersetzt oder beendet wird.
func TestFeed(t *testing.T) {
	srv, base := setup(t)
	code, _, err := srv.NewCode(context.Background(), store.Invite, "")
	if err != nil {
		t.Fatal(err)
	}
	anna := &client{t: t, base: base}
	anna.session(anna.must(200, "POST", "/api/redeem", `{"code":"`+code+`","username":"anna","password":"geheim123","teacherId":"t-anna"}`))
	guest := &client{t: t, base: base}
	guest.must(401, "GET", "/api/feed", "")
	guest.must(401, "PUT", "/api/feed", calendarText)

	if feedOf(anna).URL != "" {
		t.Fatal("Abo ohne Einrichtung")
	}
	anna.must(400, "PUT", "/api/feed", "kein Kalender")
	anna.must(204, "PUT", "/api/feed", calendarText)

	first := addressPath(t, anna.must(200, "POST", "/api/feed/address", ""))
	if got := guest.must(200, "GET", first, ""); got != calendarText {
		t.Fatalf("Kalender: %q", got)
	}
	if feedOf(anna).UpdatedAt == "" {
		t.Fatal("ohne Zeitpunkt der letzten Änderung")
	}

	second := addressPath(t, anna.must(200, "POST", "/api/feed/address", ""))
	guest.must(404, "GET", first, "") // die alte Adresse gilt nicht mehr
	guest.must(200, "GET", second, "")

	anna.must(204, "DELETE", "/api/feed/address", "")
	guest.must(404, "GET", second, "")
	guest.must(404, "GET", "/api/kalender/.ics", "")
}

func feedOf(c *client) feedAnswer {
	c.t.Helper()
	var answer feedAnswer
	_ = json.Unmarshal([]byte(c.must(200, "GET", "/api/feed", "")), &answer)
	return answer
}

// Die Adresse enthält die öffentliche Adresse des Servers; der Test spricht ihn direkt an.
func addressPath(t *testing.T, text string) string {
	t.Helper()
	var answer feedAnswer
	_ = json.Unmarshal([]byte(text), &answer)
	path, ok := strings.CutPrefix(answer.URL, "https://feedback.example.de")
	if !ok || !strings.HasPrefix(path, "/api/kalender/") || !strings.HasSuffix(path, ".ics") {
		t.Fatalf("Abo-Adresse: %q", answer.URL)
	}
	return path
}
