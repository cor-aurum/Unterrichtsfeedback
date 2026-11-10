package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"slices"
	"time"

	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/access"
	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/store"
)

// So weit reicht das Kalender-Abo zurück (wie in der App); ältere Zeiträume spielen für den Kalender keine Rolle.
const FeedDaysBack = 28

var (
	errNoSharedPeriod = errors.New("kein gemeinsamer Berichtszeitraum")
	errPartialView    = errors.New("nicht alle Berichtszeiträume sichtbar")
)

// putTeacherFeed nimmt den Abo-Kalender einer Lehrkraft an, auch von den Apps ihrer Kolleg:innen. So ist ihr Abo
// aktuell, sobald irgendein Gerät abgleicht – etwa nach einer Eintragung am Tablet oder einem Tausch auf der
// Download-Seite –, nicht erst, wenn sie selbst ihre App öffnet.
//
// Eine fremde App darf das nur, wenn sie alle laufenden Berichtszeiträume dieser Lehrkraft sieht; sonst fehlten im
// Kalender die Termine aus den anderen Zeiträumen. Hat die Lehrkraft kein Abo, gibt es nichts zu speichern.
func (s *Server) putTeacherFeed(w http.ResponseWriter, r *http.Request, account store.Account) {
	teacherID := r.PathValue("teacher")
	if teacherID == account.TeacherID {
		s.putFeed(w, r, account)
		return
	}
	target, err := s.store.AccountByTeacher(r.Context(), teacherID)
	if err != nil {
		fail(w, http.StatusNotFound, "Diese Lehrkraft hat kein Konto.")
		return
	}
	err = s.seesAllPeriodsOf(r.Context(), account.TeacherID, teacherID)
	switch {
	case errors.Is(err, errNoSharedPeriod):
		fail(w, http.StatusForbidden, "Den Kalender schicken nur Lehrkräfte aus denselben Berichtszeiträumen.")
		return
	case errors.Is(err, errPartialView):
		fail(w, http.StatusConflict, "Diese Lehrkraft ist auch in Berichtszeiträumen, die du nicht siehst; ihren Kalender schickt ihre eigene App.")
		return
	case err != nil:
		internal(w, err)
		return
	}
	content, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxFeedBytes))
	if err != nil {
		fail(w, http.StatusRequestEntityTooLarge, "Der Kalender ist zu groß.")
		return
	}
	if !isCalendar(content) {
		fail(w, http.StatusBadRequest, "Das ist kein Kalender im iCalendar-Format.")
		return
	}
	feed, err := s.store.Feed(r.Context(), target.ID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && feed.Token == "") {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err == nil {
		err = s.store.PutFeedContent(r.Context(), target.ID, content)
	}
	if err != nil {
		internal(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// seesAllPeriodsOf prüft, ob `sender` in jedem Berichtszeitraum von `teacher` eingetragen ist, der für das Abo noch
// zählt (Ende nicht länger als FeedDaysBack her). Zeiträume aus einer älteren Konfiguration ohne bekanntes Ende
// zählen immer.
func (s *Server) seesAllPeriodsOf(ctx context.Context, sender, teacher string) error {
	members, err := s.members(ctx)
	if err != nil {
		return err
	}
	cutoff := time.Now().AddDate(0, 0, -FeedDaysBack).Format(time.DateOnly)
	shared := false
	for periodID, teachers := range members {
		if !slices.Contains(teachers, teacher) {
			continue
		}
		if end, known := s.periodEnd(ctx, periodID); known && end < cutoff {
			continue
		}
		if !slices.Contains(teachers, sender) {
			return errPartialView
		}
		shared = true
	}
	if !shared {
		return errNoSharedPeriod
	}
	return nil
}

func (s *Server) periodEnd(ctx context.Context, periodID string) (string, bool) {
	content, _, err := s.store.Doc(ctx, access.PeriodDocName(periodID))
	if err != nil {
		return "", false
	}
	end, err := access.PeriodEnd(content)
	return end, err == nil
}
