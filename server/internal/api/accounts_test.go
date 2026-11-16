package api

import (
	"context"
	"strings"
	"testing"

	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/store"
)

// Passwort ändern: nur mit dem bisherigen; dieses Gerät bleibt angemeldet, andere nicht.
func TestChangePassword(t *testing.T) {
	srv, base := setup(t)
	code, _, err := srv.NewCode(context.Background(), store.Invite, "")
	if err != nil {
		t.Fatal(err)
	}
	anna := &client{t: t, base: base}
	anna.session(anna.must(200, "POST", "/api/redeem", `{"code":"`+code+`","username":"anna","password":"geheim123","teacherId":"t-anna"}`))
	other := &client{t: t, base: base}
	other.session(other.must(200, "POST", "/api/login", `{"username":"anna","password":"geheim123"}`))

	anna.must(403, "POST", "/api/password", `{"current":"falsch","password":"neuesPasswort1"}`)
	anna.must(400, "POST", "/api/password", `{"current":"geheim123","password":"kurz"}`)
	anna.must(204, "POST", "/api/password", `{"current":"geheim123","password":"neuesPasswort1"}`)
	anna.must(200, "GET", "/api/me", "")
	other.must(401, "GET", "/api/me", "")
	(&client{t: t, base: base}).must(401, "POST", "/api/login", `{"username":"anna","password":"geheim123"}`)
	(&client{t: t, base: base}).must(200, "POST", "/api/login", `{"username":"anna","password":"neuesPasswort1"}`)
}

// Eine deaktivierte Lehrkraft kann sich nicht mehr anmelden; sperren darf, wer mit ihr in einem Zeitraum ist oder war.
func TestDisableAccount(t *testing.T) {
	srv, base := setup(t)
	redeem := func(username, teacherID string) *client {
		code, _, err := srv.NewCode(context.Background(), store.Invite, teacherID)
		if err != nil {
			t.Fatal(err)
		}
		c := &client{t: t, base: base}
		c.session(c.must(200, "POST", "/api/redeem", `{"code":"`+code+`","username":"`+username+`","password":"geheim123"}`))
		return c
	}
	anna := redeem("anna", "t-anna")
	ben := redeem("ben", "t-ben")
	anna.must(200, "PUT", "/api/docs/berichtszeitraum_p1.json", period("p1", "t-anna"))

	// Ohne gemeinsamen Zeitraum nicht; sich selbst nie
	anna.must(403, "POST", "/api/accounts/t-ben/disabled", `{"disabled":true}`)
	anna.must(403, "POST", "/api/accounts/t-anna/disabled", `{"disabled":true}`)

	anna.must(200, "PUT", "/api/docs/berichtszeitraum_p2.json", period("p2", "t-anna", "t-ben", "t-clara"))
	anna.must(404, "POST", "/api/accounts/t-clara/disabled", `{"disabled":true}`)
	anna.must(204, "POST", "/api/accounts/t-ben/disabled", `{"disabled":true}`)
	// Seine Anmeldungen sind gelöscht; den Grund erfährt er beim nächsten Anmelden.
	ben.must(401, "GET", "/api/me", "")
	if status, text := (&client{t: t, base: base}).do("POST", "/api/login", `{"username":"ben","password":"geheim123"}`); status != 403 || !strings.Contains(text, "gesperrt") {
		t.Fatalf("Anmeldung trotz Sperre: %d %s", status, text)
	}
	if !strings.Contains(anna.must(200, "GET", "/api/accounts", ""), `"disabled":true`) {
		t.Fatal("Kontenliste ohne Sperre")
	}

	anna.must(204, "POST", "/api/accounts/t-ben/disabled", `{"disabled":false}`)
	(&client{t: t, base: base}).must(200, "POST", "/api/login", `{"username":"ben","password":"geheim123"}`)
}
