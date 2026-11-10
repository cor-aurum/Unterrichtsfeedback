package api

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/auth"
	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/store"
)

// Größter Kalender; wöchentliche Termine stehen darin einzeln, bei zwei Jahren und vielen Personen einige MB.
const maxFeedBytes = 10 << 20

// Kalender, solange die App noch keinen geschickt hat; Kalender-Apps lehnen ein Abo sonst ab.
const emptyCalendar = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Unterrichtsfeedback//DE\r\nEND:VCALENDAR\r\n"

// feedAnswer: url ist leer, solange kein Abo eingerichtet ist.
type feedAnswer struct {
	URL       string `json:"url"`
	UpdatedAt string `json:"updatedAt"`
}

func (s *Server) feedURL(token string) string {
	if token == "" {
		return ""
	}
	return s.publicURL + "/api/kalender/" + token + ".ics"
}

func (s *Server) getFeed(w http.ResponseWriter, r *http.Request, account store.Account) {
	feed, err := s.store.Feed(r.Context(), account.ID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		internal(w, err)
		return
	}
	answer := feedAnswer{URL: s.feedURL(feed.Token)}
	if !feed.UpdatedAt.IsZero() {
		answer.UpdatedAt = feed.UpdatedAt.UTC().Format(time.RFC3339)
	}
	writeJSON(w, answer)
}

// putFeed nimmt den Kalender des angemeldeten Lehrers an, den seine App bei jedem Abgleich erzeugt.
func (s *Server) putFeed(w http.ResponseWriter, r *http.Request, account store.Account) {
	content, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxFeedBytes))
	if err != nil {
		fail(w, http.StatusRequestEntityTooLarge, "Der Kalender ist zu groß.")
		return
	}
	if !isCalendar(content) {
		fail(w, http.StatusBadRequest, "Das ist kein Kalender im iCalendar-Format.")
		return
	}
	if err := s.store.PutFeedContent(r.Context(), account.ID, content); err != nil {
		internal(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func isCalendar(content []byte) bool {
	return bytes.HasPrefix(content, []byte("BEGIN:VCALENDAR"))
}

// newFeedAddress richtet das Abo ein oder ersetzt seine Adresse; die alte gilt danach nicht mehr.
func (s *Server) newFeedAddress(w http.ResponseWriter, r *http.Request, account store.Account) {
	token := auth.NewToken()
	if err := s.store.SetFeedToken(r.Context(), account.ID, token); err != nil {
		internal(w, err)
		return
	}
	writeJSON(w, feedAnswer{URL: s.feedURL(token)})
}

func (s *Server) deleteFeedAddress(w http.ResponseWriter, r *http.Request, account store.Account) {
	if err := s.store.SetFeedToken(r.Context(), account.ID, ""); err != nil {
		internal(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// calendar liefert den Kalender ohne Anmeldung, denn Kalender-Apps können sich nicht anmelden. Die Adresse selbst
// ist der Schlüssel (256 Bit Zufall); Raten ist aussichtslos, deshalb gibt es hier keine Bremse.
func (s *Server) calendar(w http.ResponseWriter, r *http.Request) {
	token, ok := strings.CutSuffix(r.PathValue("file"), ".ics")
	if !ok || token == "" {
		http.NotFound(w, r)
		return
	}
	content, updated, err := s.store.FeedByToken(r.Context(), token)
	if errors.Is(err, store.ErrNotFound) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		internal(w, err)
		return
	}
	if len(content) == 0 {
		content = []byte(emptyCalendar)
	}
	h := w.Header()
	h.Set("Content-Type", "text/calendar; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	// Weder Suchmaschinen noch Verlauf brauchen die Adresse.
	h.Set("X-Robots-Tag", "noindex")
	h.Set("Referrer-Policy", "no-referrer")
	http.ServeContent(w, r, "kalender.ics", updated, bytes.NewReader(content))
}
