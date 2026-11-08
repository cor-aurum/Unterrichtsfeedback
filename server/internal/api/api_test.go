package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/auth"
	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/store"
)

type client struct {
	t     *testing.T
	base  string
	token string
}

func (c *client) do(method, path, body string) (int, string) {
	c.t.Helper()
	req, _ := http.NewRequest(method, c.base+path, strings.NewReader(body))
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(data)
}

func (c *client) must(status int, method, path, body string) string {
	c.t.Helper()
	got, text := c.do(method, path, body)
	if got != status {
		c.t.Fatalf("%s %s: Status %d, erwartet %d: %s", method, path, got, status, text)
	}
	return text
}

func (c *client) session(text string) (teacherID string) {
	c.t.Helper()
	var s session
	if err := json.Unmarshal([]byte(text), &s); err != nil || s.Token == "" {
		c.t.Fatalf("keine Anmeldung: %s", text)
	}
	c.token = s.Token
	return s.TeacherID
}

func (c *client) docNames() []string {
	c.t.Helper()
	var list []struct{ Name string }
	_ = json.Unmarshal([]byte(c.must(200, "GET", "/api/docs", "")), &list)
	names := make([]string, len(list))
	for i, d := range list {
		names[i] = d.Name
	}
	return names
}

// period ist das Dokument eines Berichtszeitraums mit seinen Lehrern.
func period(id string, teachers ...string) string {
	ids, _ := json.Marshal(teachers)
	return fmt.Sprintf(`{"format":"unterricht-feedback/berichtszeitraum","version":1,"period":{"id":%q,"name":"Zeitraum","from":"2026-08-01","to":"2027-01-31","teacherIds":%s}}`, id, ids)
}

func setup(t *testing.T) (*Server, string) {
	st, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	srv := New(st, "https://feedback.example.de", "*")
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return srv, ts.URL
}

func TestScenario(t *testing.T) {
	srv, base := setup(t)
	anna := &client{t: t, base: base}
	ben := &client{t: t, base: base}

	// Erste Lehrerin über die Kommandozeile
	code, _, err := srv.NewCode(context.Background(), store.Invite, "")
	if err != nil {
		t.Fatal(err)
	}
	packed, _ := auth.Unpack(code)
	if packed.Server != "https://feedback.example.de" || packed.Kind != "invite" {
		t.Fatalf("Code enthält nicht die Serveradresse: %+v", packed)
	}
	anna.must(400, "POST", "/api/redeem", `{"code":"`+code+`","username":"anna","password":"kurz","teacherId":"t-anna"}`)
	anna.must(400, "POST", "/api/redeem", `{"code":"`+code+`","username":"anna","password":"geheim123","teacherId":"../x"}`)
	// Einladung von der Kommandozeile: Es gilt der Lehrer der App.
	annaID := anna.session(anna.must(200, "POST", "/api/redeem", `{"code":"`+code+`","username":"anna","password":"geheim123","teacherId":"t-anna"}`))
	if annaID != "t-anna" {
		t.Fatalf("Lehrer-ID %s", annaID)
	}
	anna.must(404, "POST", "/api/redeem", `{"code":"`+code+`","username":"anna2","password":"geheim123"}`) // nur einmal

	// Konfiguration und Daten des ersten Zeitraums
	anna.must(200, "PUT", "/api/docs/konfiguration.json", `{"format":"unterricht-feedback/konfiguration","config":{}}`)
	anna.must(403, "PUT", "/api/docs/berichtszeitraum_p1.json", period("p1", "t-ben"))  // ohne sich selbst
	anna.must(400, "PUT", "/api/docs/berichtszeitraum_p1.json", period("p9", "t-anna")) // falsche ID
	anna.must(200, "PUT", "/api/docs/berichtszeitraum_p1.json", period("p1", "t-anna"))
	// Ältere Apps mit Zeiträumen in der Konfiguration werden abgewiesen.
	anna.must(409, "PUT", "/api/docs/konfiguration.json", `{"config":{"reportPeriods":[{"id":"p1","teacherIds":["t-anna"]}]}}`)
	anna.must(200, "PUT", "/api/docs/zeitraum_p1_t-anna.json", `{"students":[{"id":"s-lea"}]}`)
	anna.must(200, "PUT", "/api/docs/lehrer-t-anna.json", `{"teacher":{"id":"t-anna"}}`)
	anna.must(400, "PUT", "/api/docs/notizen.txt", `{}`)
	anna.must(400, "PUT", "/api/docs/lehrer-t-anna.json", `kein json`)

	// Anna lädt Ben ein (noch ohne Zeitraum)
	var invite struct{ Code string }
	_ = json.Unmarshal([]byte(anna.must(200, "POST", "/api/invites", `{"teacherId":"t-ben"}`)), &invite)
	anna.must(409, "POST", "/api/invites", `{"teacherId":"t-anna"}`)
	// Belegter Benutzername: Der Code bleibt gültig. Eine Einladung aus der App gilt für ihren Lehrer, egal was
	// die App mitschickt.
	ben.must(409, "POST", "/api/redeem", `{"code":"`+invite.Code+`","username":"Anna","password":"passwort1"}`)
	benID := ben.session(ben.must(200, "POST", "/api/redeem", `{"code":"`+invite.Code+`","username":"ben","password":"passwort1","teacherId":"t-anna"}`))
	if benID != "t-ben" {
		t.Fatalf("Ben hat die Lehrer-ID %s", benID)
	}

	// Ben sieht Konfiguration und Lehrer, von p1 aber nur, dass es ihn gibt
	names := strings.Join(ben.docNames(), " ")
	if strings.Contains(names, "zeitraum_p1") || !strings.Contains(names, "konfiguration.json") {
		t.Fatalf("Ben sieht: %s", names)
	}
	if me := ben.must(200, "GET", "/api/me", ""); !strings.Contains(me, `"foreignPeriods":1`) {
		t.Fatalf("Ben erfährt nicht, dass es p1 gibt: %s", me)
	}
	ben.must(403, "GET", "/api/docs/berichtszeitraum_p1.json", "")
	ben.must(403, "GET", "/api/docs/zeitraum_p1_t-anna.json", "")
	ben.must(403, "PUT", "/api/docs/zeitraum_p1_t-ben.json", `{"students":[]}`)
	// … und kann sich nicht selbst eintragen
	ben.must(403, "PUT", "/api/docs/berichtszeitraum_p1.json", period("p1", "t-anna", "t-ben"))
	// … oder den Zeitraum löschen
	ben.must(403, "DELETE", "/api/docs/berichtszeitraum_p1.json", "")

	// Anna nimmt Ben in p1 auf; Ben legt p2 an
	anna.must(200, "PUT", "/api/docs/berichtszeitraum_p1.json", period("p1", "t-anna", "t-ben"))
	ben.must(200, "GET", "/api/docs/zeitraum_p1_t-anna.json", "")
	ben.must(200, "GET", "/api/docs/berichtszeitraum_p1.json", "")
	ben.must(200, "PUT", "/api/docs/berichtszeitraum_p2.json", period("p2", "t-ben"))
	ben.must(200, "PUT", "/api/docs/zeitraum_p2_t-ben.json", `{"students":[{"id":"s-lea-2"}]}`)
	anna.must(403, "GET", "/api/docs/zeitraum_p2_t-ben.json", "")
	anna.must(403, "GET", "/api/docs/berichtszeitraum_p2.json", "")

	// Zusammenführen nur, wer beide sieht
	anna.must(403, "POST", "/api/merges", `{"from":"s-lea-2","into":"s-lea"}`)
	ben.must(204, "POST", "/api/merges", `{"from":"s-lea-2","into":"s-lea"}`)
	if merges := anna.must(200, "GET", "/api/merges", ""); !strings.Contains(merges, `"from":"s-lea-2"`) {
		t.Fatalf("Zusammenführung fehlt: %s", merges)
	}

	// Passwort vergessen: Reset-Code von der Kommandozeile, alte Anmeldung verfällt
	reset, _, _ := srv.NewCode(context.Background(), store.Reset, "t-ben")
	old := ben.token
	ben.must(200, "POST", "/api/reset", `{"code":"`+reset+`","password":"neuespasswort"}`)
	ben.session(ben.must(200, "POST", "/api/login", `{"username":"BEN","password":"neuespasswort"}`))
	if code, _ := (&client{t: t, base: base, token: old}).do("GET", "/api/me", ""); code != 401 {
		t.Fatalf("alte Anmeldung gilt noch: %d", code)
	}

	// Fehlversuche werden gebremst
	guest := &client{t: t, base: base}
	for i := 0; i < freeFailures; i++ {
		guest.must(401, "POST", "/api/login", `{"username":"anna","password":"falsch"}`)
	}
	guest.must(429, "POST", "/api/login", `{"username":"anna","password":"geheim123"}`)

	// Ohne Anmeldung nichts
	guest.must(401, "GET", "/api/docs", "")
	anna.must(403, "DELETE", "/api/docs/konfiguration.json", "")
}

func TestPersonsWithoutPeriodOnlyForOwner(t *testing.T) {
	srv, base := setup(t)
	anna := &client{t: t, base: base}
	code, _, _ := srv.NewCode(context.Background(), store.Invite, "")
	anna.must(400, "POST", "/api/redeem", `{"code":"`+code+`","username":"anna","password":"geheim123"}`)
	anna.session(anna.must(200, "POST", "/api/redeem", `{"code":"`+code+`","username":"anna","password":"geheim123","teacherId":"t-anna"}`))
	anna.must(200, "PUT", "/api/docs/zeitraum__t-anna.json", `{"students":[]}`)
	anna.must(403, "PUT", "/api/docs/zeitraum__t-ben.json", `{"students":[]}`)
}

// Der Absender kann vorne in X-Forwarded-For beliebige Adressen mitschicken; die Bremse richtet sich nach dem Eintrag,
// den der Proxy anhängt.
func TestBrakeIgnoresSpoofedForwardedFor(t *testing.T) {
	_, base := setup(t)
	login := func(spoofed, real string) int {
		t.Helper()
		req, _ := http.NewRequest("POST", base+"/api/login", strings.NewReader(`{"username":"anna","password":"falsch"}`))
		req.Header.Set("X-Forwarded-For", spoofed+", "+real)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	for i := 0; i < freeFailures; i++ {
		if code := login(fmt.Sprintf("10.0.0.%d", i), "203.0.113.7"); code != 401 {
			t.Fatalf("Versuch %d: Status %d", i+1, code)
		}
	}
	if code := login("10.0.0.99", "203.0.113.7"); code != 429 {
		t.Fatalf("gefälschte Adresse umgeht die Bremse: Status %d", code)
	}
	if code := login("10.0.0.99", "203.0.113.8"); code != 401 {
		t.Fatalf("ein anderer Absender ist mitgebremst: Status %d", code)
	}
}

func TestClientIP(t *testing.T) {
	cases := []struct{ remote, forwarded, want string }{
		{"198.51.100.4:5000", "10.0.0.1", "198.51.100.4"},           // ohne Proxy zählt der Header nicht
		{"127.0.0.1:5000", "10.0.0.1, 203.0.113.7", "203.0.113.7"},  // der Proxy hängt hinten an
		{"127.0.0.1:5000", "203.0.113.7, 127.0.0.1", "203.0.113.7"}, // ein zweiter lokaler Proxy
		{"[::1]:5000", "203.0.113.7", "203.0.113.7"},
		{"127.0.0.1:5000", "", "127.0.0.1"},
	}
	for _, c := range cases {
		req := httptest.NewRequest("POST", "/api/login", nil)
		req.RemoteAddr = c.remote
		if c.forwarded != "" {
			req.Header.Set("X-Forwarded-For", c.forwarded)
		}
		if got := clientIP(req); got != c.want {
			t.Errorf("%s mit %q: %s, erwartet %s", c.remote, c.forwarded, got, c.want)
		}
	}
}
