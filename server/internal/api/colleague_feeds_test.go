package api

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/store"
)

// invited legt ein Konto für den Lehrer an, eingeladen von `by`.
func invited(t *testing.T, base string, by *client, teacherID, username string) *client {
	t.Helper()
	var invite struct{ Code string }
	_ = json.Unmarshal([]byte(by.must(200, "POST", "/api/invites", `{"teacherId":"`+teacherID+`"}`)), &invite)
	c := &client{t: t, base: base}
	c.session(c.must(200, "POST", "/api/redeem", `{"code":"`+invite.Code+`","username":"`+username+`","password":"passwort1"}`))
	return c
}

// Apps schicken auch die Abo-Kalender ihrer Kolleg:innen – aber nur, wenn sie alle laufenden Zeiträume dieser
// Lehrkraft sehen.
func TestTeacherFeeds(t *testing.T) {
	srv, base := setup(t)
	code, _, err := srv.NewCode(context.Background(), store.Invite, "")
	if err != nil {
		t.Fatal(err)
	}
	anna := &client{t: t, base: base}
	anna.session(anna.must(200, "POST", "/api/redeem", `{"code":"`+code+`","username":"anna","password":"geheim123","teacherId":"t-anna"}`))
	ben := invited(t, base, anna, "t-ben", "ben")
	invited(t, base, anna, "t-carl", "carl")
	guest := &client{t: t, base: base}
	anna.must(200, "PUT", "/api/docs/berichtszeitraum_p1.json", period("p1", "t-anna", "t-ben"))
	updated := strings.Replace(calendarText, "VERSION:2.0", "VERSION:2.0\r\nX-WR-CALNAME:Ben", 1)

	// Ohne Abo gibt es nichts zu speichern; mit Abo kommt Annas Kalender für Ben an.
	anna.must(204, "PUT", "/api/feeds/t-ben", updated)
	benFeed := addressPath(t, ben.must(200, "POST", "/api/feed/address", ""))
	if got := guest.must(200, "GET", benFeed, ""); got != emptyCalendar {
		t.Fatalf("Kalender ohne Abo gespeichert: %q", got)
	}
	anna.must(400, "PUT", "/api/feeds/t-ben", "kein Kalender")
	anna.must(204, "PUT", "/api/feeds/t-ben", updated)
	if got := guest.must(200, "GET", benFeed, ""); got != updated {
		t.Fatalf("Bens Kalender: %q", got)
	}

	anna.must(403, "PUT", "/api/feeds/t-carl", calendarText) // kein gemeinsamer Zeitraum
	anna.must(404, "PUT", "/api/feeds/t-niemand", calendarText)
	anna.must(204, "PUT", "/api/feeds/t-anna", calendarText) // der eigene geht wie PUT /api/feed

	// Ben ist auch in p2, den Anna nicht sieht: Ihr fehlten dessen Termine.
	ben.must(200, "PUT", "/api/docs/berichtszeitraum_p2.json", period("p2", "t-ben", "t-carl"))
	anna.must(409, "PUT", "/api/feeds/t-ben", calendarText)
	// Ist p2 längst vorbei, zählt er nicht mehr.
	ben.must(200, "PUT", "/api/docs/berichtszeitraum_p2.json", strings.Replace(period("p2", "t-ben", "t-carl"), "2027-01-31", "2020-01-31", 1))
	anna.must(204, "PUT", "/api/feeds/t-ben", calendarText)
}
