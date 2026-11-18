package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"math"
	"net/http"
	"time"

	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/auth"
	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/store"
)

const (
	// Termine eines ganzen Berichtszeitraums als Text; ohne PDFs bleibt das klein.
	maxBoardBytes = 16 << 20
	// Höhe einer Minute im Raster des Aushangs
	boardPxPerMinute = 1.3
	// Nach so vielen Sekunden lädt der Aushang neu und springt zurück auf heute.
	boardRefreshSeconds = 60
)

// boardContent sind die Termine eines Zeitraums für den Aushang, wie die App sie schickt. Personen stehen nur mit
// ihrem Kurznamen darin, z. B. „Anna B.“; Zeiten und Daten hat die App schon lesbar gemacht.
type boardContent struct {
	Title string `json:"title"`
	Dates string `json:"dates"`
	Color string `json:"color"`
	// Erster und letzter Tag, durch den man blättern kann (JJJJ-MM-TT)
	From string `json:"from"`
	To   string `json:"to"`
	// Spalten in ihrer Reihenfolge: „Für alle“ und die Lehrkräfte des Zeitraums
	Columns []boardColumn `json:"columns"`
	// Nur Tage mit Terminen
	Days []boardDay `json:"days"`
}

type boardColumn struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type boardDay struct {
	// Tag als JJJJ-MM-TT und lesbar, z. B. „Mittwoch, 18. November 2026“
	Day     string       `json:"day"`
	Date    string       `json:"date"`
	Entries []boardEntry `json:"entries"`
}

type boardEntry struct {
	Column string `json:"column"`
	// Minuten seit Mitternacht; bei Terminen ohne Ende reicht `end` nur für eine Zeile.
	Start int `json:"start"`
	End   int `json:"end"`
	// z. B. „15:00–15:45“ oder „ab 8:00“
	Time  string `json:"time"`
	Title string `json:"title"`
	// `single` (Einzelunterricht), `group` oder `shared` (allgemeiner Termin)
	Kind     string `json:"kind"`
	Location string `json:"location,omitempty"`
	Teacher  string `json:"teacher,omitempty"`
	// Kurznamen der Gruppenmitglieder; erscheinen erst nach Antippen
	Members []string `json:"members,omitempty"`
	// Spur nebeneinanderliegender Termine in der Spalte, wie im Kalender der App
	Lane  int `json:"lane"`
	Lanes int `json:"lanes"`
}

var boardKinds = map[string]string{"single": "Einzelunterricht", "group": "Gruppe", "shared": "Allgemeiner Termin"}

func (s *Server) boardURL(token string) string {
	return s.publicURL + "/api/aushang/" + token
}

// --- Verwalten (nur Lehrer des Zeitraums) ---

// boardPeriod prüft wie beim Download-Link, ob der Lehrer im Zeitraum eingetragen ist, und liefert den letzten Tag,
// an dem der Aushang gilt.
func (s *Server) boardPeriod(w http.ResponseWriter, r *http.Request, account store.Account) (string, time.Time, bool) {
	periodID, _, ok := s.planPeriod(w, r, account)
	if !ok {
		return "", time.Time{}, false
	}
	lastDay, err := s.boardLastDay(r.Context(), periodID)
	if err != nil {
		internal(w, err)
		return "", time.Time{}, false
	}
	return periodID, lastDay, true
}

// boardLastDay: wie beim Download-Link 14 Tage nach dem Ende des Zeitraums, im Demomodus drei Tage nach der letzten
// Aktualisierung des Aushangs.
func (s *Server) boardLastDay(ctx context.Context, periodID string) (time.Time, error) {
	if !isDemoPlan(periodID) {
		return s.planLastDay(ctx, periodID)
	}
	since := time.Now()
	link, err := s.store.Board(ctx, periodID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return time.Time{}, err
	}
	if err == nil && !link.UpdatedAt.IsZero() {
		since = link.UpdatedAt
	}
	day := time.Date(since.Year(), since.Month(), since.Day(), 0, 0, 0, 0, time.Local)
	return day.AddDate(0, 0, DemoPlanDays), nil
}

func (s *Server) getBoard(w http.ResponseWriter, r *http.Request, account store.Account) {
	periodID, lastDay, ok := s.boardPeriod(w, r, account)
	if !ok {
		return
	}
	answer := planAnswer{ExpiresAt: lastDay.Format(time.DateOnly)}
	link, err := s.store.Board(r.Context(), periodID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		internal(w, err)
		return
	}
	if err == nil {
		answer.URL = s.boardURL(link.Token)
		if !link.UpdatedAt.IsZero() {
			answer.UpdatedAt = link.UpdatedAt.UTC().Format(time.RFC3339)
		}
	}
	writeJSON(w, answer)
}

// newBoardAddress richtet den Aushang-Link ein oder ersetzt ihn; der alte gilt danach nicht mehr.
func (s *Server) newBoardAddress(w http.ResponseWriter, r *http.Request, account store.Account) {
	periodID, lastDay, ok := s.boardPeriod(w, r, account)
	if !ok {
		return
	}
	token := auth.NewToken()
	if err := s.store.SetBoardToken(r.Context(), periodID, token); err != nil {
		internal(w, err)
		return
	}
	writeJSON(w, planAnswer{URL: s.boardURL(token), ExpiresAt: lastDay.Format(time.DateOnly)})
}

func (s *Server) deleteBoard(w http.ResponseWriter, r *http.Request, account store.Account) {
	periodID, _, ok := s.boardPeriod(w, r, account)
	if !ok {
		return
	}
	if err := s.store.DeleteBoard(r.Context(), periodID); err != nil {
		internal(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// putBoard nimmt die Termine an, die die App bei Änderungen erzeugt; ohne Link gibt es nichts zu speichern (404).
func (s *Server) putBoard(w http.ResponseWriter, r *http.Request, account store.Account) {
	periodID, _, ok := s.boardPeriod(w, r, account)
	if !ok {
		return
	}
	content, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBoardBytes))
	if err != nil {
		fail(w, http.StatusRequestEntityTooLarge, "Die Termine für den Aushang sind zu groß.")
		return
	}
	if _, err := parseBoard(content); err != nil {
		fail(w, http.StatusBadRequest, "Die Termine für den Aushang sind ungültig: "+err.Error())
		return
	}
	err = s.store.PutBoardContent(r.Context(), periodID, content)
	if errors.Is(err, store.ErrNotFound) {
		fail(w, http.StatusNotFound, "Für diesen Berichtszeitraum gibt es keinen Aushang-Link.")
		return
	}
	if err != nil {
		internal(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// parseBoard liest die Termine und prüft, was die Seite braucht: gültige Tage, bekannte Spalten, Zeiten innerhalb
// des Tages und Spuren, die nebeneinander passen.
func parseBoard(content []byte) (boardContent, error) {
	var board boardContent
	if err := json.Unmarshal(content, &board); err != nil {
		return board, errors.New("kein gültiges JSON")
	}
	if !isDate(board.From) || !isDate(board.To) || board.From > board.To {
		return board, fmt.Errorf("ungültiger Zeitraum %q bis %q", board.From, board.To)
	}
	columns := map[string]bool{}
	for _, column := range board.Columns {
		if !personIDPattern.MatchString(column.ID) || columns[column.ID] {
			return board, fmt.Errorf("ungültige oder doppelte Spalte %q", column.ID)
		}
		columns[column.ID] = true
	}
	for _, day := range board.Days {
		if !isDate(day.Day) {
			return board, fmt.Errorf("ungültiger Tag %q", day.Day)
		}
		for _, entry := range day.Entries {
			if err := checkBoardEntry(entry, columns); err != nil {
				return board, fmt.Errorf("%s: %w", day.Day, err)
			}
		}
	}
	return board, nil
}

func checkBoardEntry(entry boardEntry, columns map[string]bool) error {
	switch {
	case !columns[entry.Column]:
		return fmt.Errorf("unbekannte Spalte %q", entry.Column)
	case entry.Start < 0 || entry.End <= entry.Start || entry.End > 24*60:
		return fmt.Errorf("ungültige Zeit %d–%d", entry.Start, entry.End)
	case entry.Lanes < 1 || entry.Lanes > 20 || entry.Lane < 0 || entry.Lane >= entry.Lanes:
		return fmt.Errorf("ungültige Spur %d/%d", entry.Lane, entry.Lanes)
	case boardKinds[entry.Kind] == "":
		return fmt.Errorf("unbekannte Art %q", entry.Kind)
	case entry.Title == "":
		return errors.New("Termin ohne Bezeichnung")
	}
	return nil
}

func isDate(text string) bool {
	_, err := time.Parse(time.DateOnly, text)
	return err == nil
}

// --- Öffentliche Seite (ohne Anmeldung) ---

// publicBoard zeigt die Termine eines Tages, je Lehrkraft eine Spalte; `?tag=JJJJ-MM-TT` blättert. Wie beim
// Download-Link ist der Link selbst der Schlüssel. Die Seite braucht kein JavaScript: Gruppenmitglieder zeigt ein
// Fenster über den Anker des Termins (`:target`), und nach einer Minute lädt sie neu und springt zurück auf heute.
func (s *Server) publicBoard(w http.ResponseWriter, r *http.Request) {
	link, err := s.store.BoardByToken(r.Context(), r.PathValue("token"))
	if err == nil {
		err = s.checkBoardValid(r.Context(), link.PeriodID)
	}
	switch {
	case errors.Is(err, store.ErrNotFound):
		renderPage(w, http.StatusNotFound, messagePage, pageData{Message: "Diesen Aushang gibt es nicht (mehr)."})
		return
	case errors.Is(err, errPlanExpired):
		renderPage(w, http.StatusGone, messagePage, pageData{Message: "Dieser Aushang ist abgelaufen."})
		return
	case err != nil:
		internal(w, err)
		return
	}
	if len(link.Content) == 0 {
		renderPage(w, http.StatusOK, messagePage, pageData{Message: "Die Termine werden gerade vorbereitet. Bitte versuch es gleich noch einmal."})
		return
	}
	board, err := parseBoard(link.Content)
	if err != nil {
		internal(w, err)
		return
	}
	view := newBoardView(board, s.boardURL(link.Token), r.URL.Query().Get("tag"), time.Now())
	view.Updated = updatedText(store.PlanLink{UpdatedAt: link.UpdatedAt})
	renderBoard(w, view)
}

func (s *Server) checkBoardValid(ctx context.Context, periodID string) error {
	lastDay, err := s.boardLastDay(ctx, periodID)
	if err != nil {
		return err
	}
	if time.Now().After(lastDay.AddDate(0, 0, 1)) {
		return errPlanExpired
	}
	return nil
}

// boardView ist ein Tag des Aushangs, fertig zum Zeichnen.
type boardView struct {
	Title, Dates, Base, Updated string
	// Lesbares Datum des Tages, z. B. „Mittwoch, 18. November 2026“
	Date  string
	Today bool
	// Der Tag, auf den die Seite ohne `tag` springt: heute, vor dem Zeitraum sein erster, danach sein letzter Tag
	Home    bool
	Prev    string
	Next    string
	Columns []boardColumnView
	Hours   []boardHour
	Height  int
	NowTop  int
	ShowNow bool
	Entries []*boardEntryView
	color   string
	refresh int
}

type boardColumnView struct {
	Name    string
	Entries []*boardEntryView
}

type boardHour struct {
	Label string
	Top   int
}

type boardEntryView struct {
	boardEntry
	ID        string
	KindLabel string
	Top       int
	Height    int
	Left      float64
	Width     float64
	Running   bool
	OneLine   bool
}

// Color ist die Themenfarbe der App; nur geprüfte Werte landen im CSS.
func (v boardView) Color() template.CSS {
	if colorPattern.MatchString(v.color) {
		return template.CSS(v.color)
	}
	return "#2f6f9f"
}

// Refresh: Nach einer Minute neu laden, immer mit dem heutigen Tag.
func (v boardView) Refresh() string {
	return fmt.Sprintf("%d;url=%s", v.refresh, v.Base)
}

// newBoardView wählt den Tag (ohne oder mit ungültigem `tag` heute, begrenzt auf den Zeitraum) und legt die Termine
// der Spalten ins Raster. Spalten ohne Termine an dem Tag fallen weg.
func newBoardView(board boardContent, base, tag string, now time.Time) boardView {
	today := now.Format(time.DateOnly)
	day := today
	if isDate(tag) {
		day = tag
	}
	day = max(board.From, min(board.To, day))
	home := max(board.From, min(board.To, today))
	view := boardView{Title: board.Title, Dates: board.Dates, Base: base, Today: day == today, Home: day == home, color: board.Color, refresh: boardRefreshSeconds}
	view.Date = readableDay(day)
	if day > board.From {
		view.Prev = base + "?tag=" + shiftDay(day, -1)
	}
	if day < board.To {
		view.Next = base + "?tag=" + shiftDay(day, 1)
	}
	var entries []boardEntry
	for _, d := range board.Days {
		if d.Day == day {
			entries = d.Entries
			view.Date = d.Date
		}
	}
	if len(entries) == 0 {
		return view
	}
	first, last := hourRange(entries)
	view.Height = int(math.Round(float64((last-first)*60) * boardPxPerMinute))
	for hour := first; hour < last; hour++ {
		view.Hours = append(view.Hours, boardHour{Label: fmt.Sprintf("%d:00", hour), Top: px((hour - first) * 60)})
	}
	minutes := now.Hour()*60 + now.Minute()
	if view.Today && minutes >= first*60 && minutes < last*60 {
		view.ShowNow, view.NowTop = true, px(minutes-first*60)
	}
	for _, column := range board.Columns {
		columnView := boardColumnView{Name: column.Name}
		for _, entry := range entries {
			if entry.Column != column.ID {
				continue
			}
			e := &boardEntryView{
				boardEntry: entry,
				ID:         fmt.Sprintf("t%d", len(view.Entries)+1),
				KindLabel:  boardKinds[entry.Kind],
				Top:        px(entry.Start - first*60),
				Height:     max(px(entry.End-entry.Start)-2, 18),
				Left:       100 * float64(entry.Lane) / float64(entry.Lanes),
				Width:      100 / float64(entry.Lanes),
				Running:    view.Today && entry.Start <= minutes && minutes < entry.End,
			}
			e.OneLine = e.Height < 44
			columnView.Entries = append(columnView.Entries, e)
			view.Entries = append(view.Entries, e)
		}
		if len(columnView.Entries) > 0 {
			view.Columns = append(view.Columns, columnView)
		}
	}
	return view
}

// hourRange: ganze Stunden, die alle Termine des Tages umfassen, mindestens vier.
func hourRange(entries []boardEntry) (int, int) {
	first, last := 24, 0
	for _, entry := range entries {
		first = min(first, entry.Start/60)
		last = max(last, (entry.End+59)/60)
	}
	if last-first < 4 {
		last = min(24, first+4)
		first = last - 4
	}
	return first, last
}

func px(minutes int) int {
	return int(math.Round(float64(minutes) * boardPxPerMinute))
}

func shiftDay(day string, days int) string {
	date, _ := time.Parse(time.DateOnly, day)
	return date.AddDate(0, 0, days).Format(time.DateOnly)
}

var (
	weekdayNames = []string{"Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"}
	monthNames   = []string{"Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"}
)

// readableDay: „Mittwoch, 18. November 2026“ für Tage, die die App nicht mitschickt (ohne Termine)
func readableDay(day string) string {
	date, _ := time.Parse(time.DateOnly, day)
	return fmt.Sprintf("%s, %d. %s %d", weekdayNames[date.Weekday()], date.Day(), monthNames[date.Month()-1], date.Year())
}

func renderBoard(w http.ResponseWriter, view boardView) {
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'")
	privateHeaders(h)
	var out bytes.Buffer
	if err := boardPage.Execute(&out, view); err != nil {
		internal(w, err)
		return
	}
	_, _ = w.Write(out.Bytes())
}

var boardPage = template.Must(template.New("board").Parse(`<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta http-equiv="refresh" content="{{.Refresh}}">
<title>{{.Title}} – Aushang</title>
<style>
:root { --accent: {{.Color}}; color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; font: 18px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f2933; background: #f4f6f8; }
main { padding: 16px; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; border-top: 6px solid var(--accent); background: #fff; border-radius: 12px; padding: 14px 18px; margin-bottom: 14px; box-shadow: 0 1px 3px #0001; }
h1 { flex: 1 1 18rem; margin: 0; font-size: 1.7rem; line-height: 1.2; }
h1 small { display: block; font-size: 1rem; font-weight: 400; color: #66727f; }
nav { display: flex; gap: 10px; }
nav a, nav span { display: inline-block; min-width: 3.2rem; padding: 14px 18px; border-radius: 12px; border: 1px solid #c3ccd5; background: #fff; color: inherit; font-weight: 600; text-align: center; text-decoration: none; }
nav a.today { background: var(--accent); border-color: var(--accent); color: #fff; }
nav span { color: #b8c1ca; }
.grid { display: flex; overflow-x: auto; background: #fff; border-radius: 12px; padding: 0 8px 8px 0; box-shadow: 0 1px 3px #0001; }
.hours { flex: 0 0 3.4rem; }
.col { flex: 1 0 9.5rem; border-left: 1px solid #e3e8ec; }
.head { position: sticky; top: 0; height: 2.6rem; padding: 8px; font-weight: 700; font-size: .95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: #fff; z-index: 2; }
.area { position: relative; }
.hour { position: absolute; left: 0; right: 0; border-top: 1px solid #eef1f4; }
.hours .hour { border: 0; padding-right: 6px; text-align: right; font-size: .8rem; color: #66727f; transform: translateY(-.55em); }
.now { position: absolute; left: 0; right: 0; border-top: 2px solid #d64545; z-index: 3; }
.entry { position: absolute; display: block; overflow: hidden; padding: 4px 6px; border-radius: 6px; border-left: 4px solid var(--accent); background: #eef4fb; color: inherit; text-decoration: none; font-size: .85rem; line-height: 1.25; }
.entry.group { border-left-style: dashed; background: #f4effa; }
.entry.shared { border: 1px solid #44505c; border-left: 4px double #44505c; background: #fff; }
.entry.running { box-shadow: 0 0 0 3px var(--accent); }
.entry b { display: block; }
.entry.one-line { white-space: nowrap; text-overflow: ellipsis; padding-block: 1px; }
.entry.one-line b { display: inline; }
.entry .time { font-variant-numeric: tabular-nums; }
.empty { background: #fff; border-radius: 12px; padding: 24px; text-align: center; color: #66727f; }
.pop { display: none; position: fixed; inset: 0; z-index: 10; align-items: center; justify-content: center; padding: 16px; background: #0007; }
.pop:target { display: flex; }
.card { width: min(30rem, 100%); max-height: 90vh; overflow: auto; background: #fff; border-radius: 14px; padding: 18px 22px; }
.card h2 { margin: 0 0 4px; font-size: 1.4rem; }
.card p { margin: 6px 0; }
.card ul { columns: 2; margin: 8px 0; padding-left: 1.2rem; }
.close { display: block; margin-top: 14px; padding: 14px; border-radius: 12px; background: var(--accent); color: #fff; font-weight: 600; text-align: center; text-decoration: none; }
.muted { color: #66727f; font-size: .9rem; }
footer { margin-top: 10px; }
</style>
</head>
<body><main>
<header>
  <h1>{{.Date}}<small>{{.Title}}{{if not .Home}} · <a href="{{.Base}}">zurück zu heute</a>{{end}}</small></h1>
  <nav>
    {{if .Prev}}<a href="{{.Prev}}" aria-label="Vorheriger Tag">‹</a>{{else}}<span>‹</span>{{end}}
    <a class="today" href="{{.Base}}">Heute</a>
    {{if .Next}}<a href="{{.Next}}" aria-label="Nächster Tag">›</a>{{else}}<span>›</span>{{end}}
  </nav>
</header>
{{if .Columns}}
<div class="grid">
  <div class="hours"><div class="head"></div><div class="area" style="height: {{.Height}}px">{{range .Hours}}<div class="hour" style="top: {{.Top}}px">{{.Label}}</div>{{end}}</div></div>
  {{range .Columns}}
  <div class="col">
    <div class="head">{{.Name}}</div>
    <div class="area" style="height: {{$.Height}}px">
      {{range $.Hours}}<div class="hour" style="top: {{.Top}}px"></div>{{end}}
      {{if $.ShowNow}}<div class="now" style="top: {{$.NowTop}}px"></div>{{end}}
      {{range .Entries}}<a href="#{{.ID}}" class="entry {{.Kind}}{{if .Running}} running{{end}}{{if .OneLine}} one-line{{end}}" style="top: {{.Top}}px; height: {{.Height}}px; left: {{.Left}}%; width: {{.Width}}%"><span class="time">{{.Time}}</span> <b>{{.Title}}</b>{{if and .Location (not .OneLine)}} {{.Location}}{{end}}</a>{{end}}
    </div>
  </div>
  {{end}}
</div>
{{else}}
<p class="empty">An diesem Tag gibt es keine Termine.</p>
{{end}}
{{range .Entries}}
<div class="pop" id="{{.ID}}"><div class="card">
  <p class="muted">{{.KindLabel}}</p>
  <h2>{{.Title}}</h2>
  <p><strong>{{.Time}}</strong>{{if .Location}} · {{.Location}}{{end}}</p>
  {{if .Teacher}}<p>Lehrkraft: {{.Teacher}}</p>{{end}}
  {{if .Members}}<p>Mitglieder:</p><ul>{{range .Members}}<li>{{.}}</li>{{end}}</ul>{{end}}
  <a class="close" href="#">Schließen</a>
</div></div>
{{end}}
<footer><p class="muted">{{.Dates}}{{if .Updated}} · Stand: {{.Updated}}{{end}} · Tippe auf einen Termin für mehr.</p></footer>
</main></body>
</html>`))
