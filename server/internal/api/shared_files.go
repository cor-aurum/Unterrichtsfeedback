package api

import (
	"bytes"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/store"
)

// Bereitgestellte Dateien: Eine Lehrkraft stellt ein fertiges PDF (z. B. die Feedback-PDFs aller Personen) einzelnen
// Lehrkräften oder allen Lehrkräften eines Berichtszeitraums bereit, damit diese es drucken oder versenden. Die
// Empfängerinnen brauchen dafür keinen Zugriff auf die Daten des Zeitraums. Sehen kann eine Datei nur, wer sie
// bereitgestellt hat oder für wen sie bereitliegt; die Absenderin sieht, wer sie schon geöffnet hat. Nach 30 Tagen
// löscht der Server sie von selbst.

const (
	sharedFileDays = 30
	// Gegen versehentliche Massen; eine Datei je Export reicht meist.
	maxSentFiles = 200
)

var (
	sharedFileIDPattern = regexp.MustCompile(`^[0-9a-f]{24}$`)
	unsafeNameChars     = regexp.MustCompile(`[\x00-\x1f/\\:*?"<>|]+`)
)

type sharedFileEntry struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Size      int64             `json:"size"`
	PeriodID  string            `json:"periodId,omitempty"`
	CreatedAt string            `json:"createdAt"`
	ExpiresAt string            `json:"expiresAt"`
	From      string            `json:"from,omitempty"`
	OpenedAt  string            `json:"openedAt,omitempty"`
	To        []sharedRecipient `json:"to,omitempty"`
}

type sharedRecipient struct {
	TeacherID string `json:"teacherId"`
	OpenedAt  string `json:"openedAt,omitempty"`
	DoneAt    string `json:"doneAt,omitempty"`
}

// shareFile: Der Inhalt kommt als Base64-Text im Body (das PDF), damit ihn auch die Android-App schicken kann, deren
// HTTP nur Text überträgt. Name und Empfängerinnen stehen in den Parametern: `to` mit Lehrer-IDs (durch Komma
// getrennt) oder `period` für alle Lehrkräfte des Zeitraums außer der Absenderin.
func (s *Server) shareFile(w http.ResponseWriter, r *http.Request, account store.Account) {
	name := sharedFileName(r.URL.Query().Get("name"))
	if name == "" {
		fail(w, http.StatusBadRequest, "Der Dateiname fehlt.")
		return
	}
	text, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxDocBytes/3*4+4))
	if err != nil {
		fail(w, http.StatusRequestEntityTooLarge, "Die Datei ist zu groß (höchstens 25 MB).")
		return
	}
	content, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(text)))
	if err != nil || !bytes.HasPrefix(content, []byte("%PDF-")) {
		fail(w, http.StatusBadRequest, "Bereitstellen lassen sich nur PDF-Dateien.")
		return
	}
	periodID := r.URL.Query().Get("period")
	recipients, ok := s.shareRecipients(w, r, account, periodID)
	if !ok {
		return
	}
	ctx := r.Context()
	if err := s.purgeSharedFiles(r); err != nil {
		internal(w, err)
		return
	}
	if n, err := s.store.CountSentFiles(ctx, account.TeacherID); err != nil {
		internal(w, err)
		return
	} else if n >= maxSentFiles {
		fail(w, http.StatusTooManyRequests, "Du hast schon sehr viele Dateien bereitgestellt. Bitte zieh ältere zurück.")
		return
	}
	file := store.SharedFile{ID: newBookingID(), Sender: account.TeacherID, Name: name, PeriodID: periodID, CreatedAt: time.Now()}
	if err := s.store.AddSharedFile(ctx, file, content, recipients); err != nil {
		internal(w, err)
		return
	}
	writeJSON(w, map[string]any{"id": file.ID, "recipients": recipients})
}

// shareRecipients: Lehrkräfte mit (nicht gesperrtem) Konto; die Absenderin selbst nicht.
func (s *Server) shareRecipients(w http.ResponseWriter, r *http.Request, account store.Account, periodID string) ([]string, bool) {
	accounts, err := s.store.Accounts(r.Context())
	if err != nil {
		internal(w, err)
		return nil, false
	}
	reachable := map[string]bool{}
	for _, a := range accounts {
		if !a.Disabled && a.TeacherID != account.TeacherID {
			reachable[a.TeacherID] = true
		}
	}
	var wanted []string
	if periodID != "" {
		members, err := s.members(r.Context())
		if err != nil {
			internal(w, err)
			return nil, false
		}
		if !members.In(periodID, account.TeacherID) {
			fail(w, http.StatusForbidden, "An alle Lehrkräfte eines Zeitraums stellt nur bereit, wer selbst darin eingetragen ist.")
			return nil, false
		}
		wanted = members[periodID]
	} else {
		wanted = strings.Split(r.URL.Query().Get("to"), ",")
	}
	var recipients []string
	for _, id := range wanted {
		if reachable[id] && !slices.Contains(recipients, id) {
			recipients = append(recipients, id)
		}
	}
	if len(recipients) == 0 {
		fail(w, http.StatusBadRequest, "Keine der gewählten Lehrkräfte hat ein Konto auf dem Server.")
		return nil, false
	}
	return recipients, true
}

// sharedFiles: was für die Lehrkraft bereitliegt und was sie selbst bereitgestellt hat (mit „geöffnet“ je Empfängerin).
func (s *Server) sharedFiles(w http.ResponseWriter, r *http.Request, account store.Account) {
	if err := s.purgeSharedFiles(r); err != nil {
		internal(w, err)
		return
	}
	received, opened, err := s.store.ReceivedFiles(r.Context(), account.TeacherID)
	if err != nil {
		internal(w, err)
		return
	}
	sent, recipients, err := s.store.SentFiles(r.Context(), account.TeacherID)
	if err != nil {
		internal(w, err)
		return
	}
	answer := struct {
		Received []sharedFileEntry `json:"received"`
		Sent     []sharedFileEntry `json:"sent"`
	}{Received: []sharedFileEntry{}, Sent: []sharedFileEntry{}}
	for i, file := range received {
		entry := sharedFileOf(file)
		entry.From = file.Sender
		entry.OpenedAt = timeText(opened[i])
		answer.Received = append(answer.Received, entry)
	}
	for _, file := range sent {
		entry := sharedFileOf(file)
		entry.To = []sharedRecipient{}
		for _, recipient := range recipients[file.ID] {
			entry.To = append(entry.To, sharedRecipient{
				TeacherID: recipient.TeacherID,
				OpenedAt:  timeText(recipient.OpenedAt),
				DoneAt:    timeText(recipient.DoneAt),
			})
		}
		answer.Sent = append(answer.Sent, entry)
	}
	writeJSON(w, answer)
}

// sharedFile liefert den Inhalt; öffnet ihn eine Empfängerin, sieht die Absenderin das danach.
func (s *Server) sharedFile(w http.ResponseWriter, r *http.Request, account store.Account) {
	id := r.PathValue("id")
	if !sharedFileIDPattern.MatchString(id) {
		fail(w, http.StatusNotFound, "Diese Datei gibt es nicht (mehr).")
		return
	}
	if err := s.purgeSharedFiles(r); err != nil {
		internal(w, err)
		return
	}
	file, content, err := s.store.SharedFileContent(r.Context(), id, account.TeacherID)
	if errors.Is(err, store.ErrNotFound) {
		fail(w, http.StatusNotFound, "Diese Datei gibt es nicht (mehr).")
		return
	}
	if err != nil {
		internal(w, err)
		return
	}
	// Die App holt den Inhalt als Base64-Text (wie beim Hochladen), sonst kommt das PDF selbst.
	if r.URL.Query().Get("format") == "base64" {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		privateHeaders(w.Header())
		_, _ = io.WriteString(w, base64.StdEncoding.EncodeToString(content))
		return
	}
	serveFile(w, r, "application/pdf", file.Name, file.CreatedAt, content)
}

// deleteSharedFile: Die Absenderin zieht die Datei für alle zurück, eine Empfängerin markiert sie als erledigt.
func (s *Server) deleteSharedFile(w http.ResponseWriter, r *http.Request, account store.Account) {
	id := r.PathValue("id")
	err := s.store.RemoveSharedFile(r.Context(), id, account.TeacherID)
	if errors.Is(err, store.ErrNotFound) {
		fail(w, http.StatusNotFound, "Diese Datei gibt es nicht (mehr).")
		return
	}
	if err != nil {
		internal(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) purgeSharedFiles(r *http.Request) error {
	return s.store.PurgeSharedFiles(r.Context(), time.Now().AddDate(0, 0, -sharedFileDays))
}

func sharedFileOf(file store.SharedFile) sharedFileEntry {
	return sharedFileEntry{
		ID:        file.ID,
		Name:      file.Name,
		Size:      file.Size,
		PeriodID:  file.PeriodID,
		CreatedAt: timeText(file.CreatedAt),
		ExpiresAt: timeText(file.CreatedAt.AddDate(0, 0, sharedFileDays)),
	}
}

func timeText(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// sharedFileName: ein Dateiname ohne Pfad und Steuerzeichen, mit .pdf am Ende
func sharedFileName(name string) string {
	name = strings.TrimSpace(unsafeNameChars.ReplaceAllString(name, "_"))
	if name == "" {
		return ""
	}
	if runes := []rune(name); len(runes) > 120 {
		name = string(runes[:120])
	}
	if !strings.HasSuffix(strings.ToLower(name), ".pdf") {
		name += ".pdf"
	}
	return name
}
