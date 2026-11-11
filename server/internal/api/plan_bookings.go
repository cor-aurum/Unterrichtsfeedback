package api

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/store"
)

// Selbsteintragung über den Download-Link: Wie am Tablet trägt sich jede Person auf ihrer Seite für freie
// Einzeltermine ein, nur ohne Lehrkraft daneben. Welche Zeiten frei sind und welche für die Person passen, rechnet die
// App aus und schickt es mit den Plänen. Der Server vergibt die Zeiten der Reihe nach: Wer zuerst kommt, bekommt sie.
// Die App einer Lehrkraft des Zeitraums übernimmt die Eintragungen beim nächsten Abgleich und schickt danach neue
// Pläne. Bis dahin zählt der Server sie selbst mit.

const (
	// Gegen versehentliche oder mutwillige Massen von Eintragungen (auch zurückgenommene zählen)
	maxBookingsPerPeriod = 5000
	// So lange zählt eine übernommene Eintragung höchstens, bis die Pläne sie zeigen.
	appliedHold = time.Hour
)

var (
	datePattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	timePattern = regexp.MustCompile(`^\d{2}:\d{2}$`)

	errSlotTaken    = errors.New("Diese Zeit ist gerade vergeben worden. Bitte wähle eine andere.")
	errNoneLeft     = errors.New("Du hast schon alle Termine gewählt.")
	errBookingLimit = errors.New("Gerade sind zu viele Eintragungen offen. Bitte versuch es später noch einmal.")
	errNotBookable  = errors.New("Diese Zeit kannst du nicht wählen.")
)

// Hinweise nach dem Ein- und Austragen; die Seite zeigt nur diese festen Texte.
var bookingNotices = map[string]string{
	"eingetragen":     "Eingetragen. Der Termin steht in deinem Plan, sobald eine Lehrkraft-App ihn übernommen hat – meist nach wenigen Minuten.",
	"vergeben":        errSlotTaken.Error(),
	"voll":            errNoneLeft.Error(),
	"zurueckgenommen": "Deine Eintragung ist zurückgenommen.",
	"austragen":       "Der Termin wird ausgetragen, sobald eine Lehrkraft-App das übernommen hat – meist nach wenigen Minuten.",
	"veraltet":        "Das geht nicht mehr. Die Seite zeigt den aktuellen Stand.",
}

// planBooking ist die Selbsteintragung, wie die App sie mitschickt: Zeitraum, Höchstzahl je Person und je
// Lehrkraft ihre freien Zeiten ab dem Tag, an dem die Pläne entstanden.
type planBooking struct {
	From     string           `json:"from"`
	To       string           `json:"to"`
	Max      int              `json:"max"`
	Teachers []bookingTeacher `json:"teachers"`
}

type bookingTeacher struct {
	ID         string        `json:"id"`
	Name       string        `json:"name"`
	Instrument string        `json:"instrument"`
	Slots      []bookingSlot `json:"slots"`
}

type bookingSlot struct {
	Date    string `json:"date"`
	Time    string `json:"time"`
	Minutes int    `json:"minutes"`
}

// personBooking: was für eine Person gilt. Skip und Clash nennen Zeiten einer Lehrkraft über ihren Index in deren
// Slots: Skip fällt für die Person weg (anderer Einzelunterricht, schon ein Termin am Tag), Clash überschneidet
// sich mit ihrem Gruppenunterricht.
type personBooking struct {
	// Lehrkraft der Person im Zeitraum; leer, solange sie sie mit dem ersten Termin noch wählt
	Teacher string `json:"teacher"`
	// Einzeltermine bei den Lehrkräften der Eintragung im Zeitraum, auch vergangene
	Count int                    `json:"count"`
	Own   []ownLesson            `json:"own"`
	Skip  map[string][]int       `json:"skip"`
	Clash map[string][]slotClash `json:"clash"`
}

// ownLesson ist ein künftiger eigener Einzeltermin; einmalige ohne erfasste Stunde lassen sich austragen.
type ownLesson struct {
	Slot      string `json:"slot"`
	Teacher   string `json:"teacher"`
	Date      string `json:"date"`
	Time      string `json:"time"`
	Minutes   int    `json:"minutes"`
	Removable bool   `json:"removable"`
}

type slotClash struct {
	I     int    `json:"i"`
	Group string `json:"group"`
}

func (b *planBooking) teacher(id string) *bookingTeacher {
	for i := range b.Teachers {
		if b.Teachers[i].ID == id {
			return &b.Teachers[i]
		}
	}
	return nil
}

func (t *bookingTeacher) slot(date, clock string) (bookingSlot, bool) {
	for _, slot := range t.Slots {
		if slot.Date == date && slot.Time == clock {
			return slot, true
		}
	}
	return bookingSlot{}, false
}

// checkBooking prüft, was die Seite von der Selbsteintragung braucht: gültige IDs, Tage und Uhrzeiten.
func checkBooking(plans planContent) error {
	booking := plans.Booking
	if booking == nil {
		return nil
	}
	if !datePattern.MatchString(booking.From) || !datePattern.MatchString(booking.To) || booking.Max < 0 {
		return errors.New("Selbsteintragung ohne gültigen Zeitraum")
	}
	seen := map[string]bool{}
	for _, teacher := range booking.Teachers {
		if !personIDPattern.MatchString(teacher.ID) || seen[teacher.ID] {
			return fmt.Errorf("ungültige oder doppelte Lehrkraft %q", teacher.ID)
		}
		seen[teacher.ID] = true
		for _, slot := range teacher.Slots {
			if !validTime(slot.Date, slot.Time, slot.Minutes) {
				return fmt.Errorf("ungültige Zeit %s %s", slot.Date, slot.Time)
			}
		}
	}
	for _, person := range plans.People {
		mine := person.Booking
		if mine == nil {
			continue
		}
		if mine.Teacher != "" && !seen[mine.Teacher] {
			return fmt.Errorf("Lehrkraft von %s fehlt in der Selbsteintragung", person.ID)
		}
		for _, own := range mine.Own {
			if !personIDPattern.MatchString(own.Slot) || !validTime(own.Date, own.Time, own.Minutes) {
				return fmt.Errorf("ungültiger Termin %q", own.Slot)
			}
		}
	}
	return nil
}

func validTime(date, clock string, minutes int) bool {
	return datePattern.MatchString(date) && timePattern.MatchString(clock) && minutes > 0
}

// --- Was eine Person wählen kann ---

// bookingDesk ist alles, was zur Selbsteintragung einer Person gehört.
type bookingDesk struct {
	booking *planBooking
	person  *planPerson
	mine    *personBooking
	// Alle Eintragungen des Zeitraums
	all []store.PlanBooking
	// Termine (IDs der App), die in den Plänen stehen
	inPlans map[string]bool
	now     time.Time
}

// occupies: Eine Eintragung zählt, solange sie offen ist oder die App sie übernommen hat, die Pläne es aber noch
// nicht zeigen: beim Eintragen, solange ihr Termin fehlt, beim Austragen, solange er noch dasteht. Auf den Stand der
// Pläne allein ist kein Verlass, denn ein anderes Gerät kann neuere Pläne ohne die Änderung schicken, wenn es noch
// nicht abgeglichen hat. Nach appliedHold zählt sie nicht mehr (z. B. hat die Lehrkraft den Termin inzwischen
// selbst gelöscht).
func (d bookingDesk) occupies(b store.PlanBooking) bool {
	switch {
	case b.Status == store.RequestOpen:
		return true
	case b.Status != store.RequestApplied || d.now.Sub(b.UpdatedAt) > appliedHold:
		return false
	case b.Kind == store.BookingNew:
		return !d.inPlans[BookingAppointmentID(b.ID)]
	default:
		return d.inPlans[b.Slot]
	}
}

// BookingAppointmentID ist die ID des Termins, den die App für eine Eintragung anlegt (wie `bookingAppointmentId`
// in src/app/plans/plan-bookings.ts).
func BookingAppointmentID(bookingID string) string {
	return "buchung-" + bookingID
}

// slotIDs sammelt alle Termine, die in den Plänen stehen.
func (p planContent) slotIDs() map[string]bool {
	ids := map[string]bool{}
	for _, person := range p.People {
		for _, day := range person.Days {
			for _, entry := range day.Entries {
				if entry.Slot != "" {
					ids[entry.Slot] = true
				}
			}
		}
		if person.Booking != nil {
			for _, own := range person.Booking.Own {
				ids[own.Slot] = true
			}
		}
	}
	return ids
}

// own liefert die zählenden Eintragungen der Person einer Art.
func (d bookingDesk) own(kind string) []store.PlanBooking {
	var list []store.PlanBooking
	for _, b := range d.all {
		if b.Person == d.person.ID && b.Kind == kind && d.occupies(b) {
			list = append(list, b)
		}
	}
	return list
}

// teacherID ist die Lehrkraft der Person; leer, solange sie wählt. Mit der ersten Eintragung steht sie fest.
func (d bookingDesk) teacherID() string {
	if d.mine.Teacher != "" {
		return d.mine.Teacher
	}
	if booked := d.own(store.BookingNew); len(booked) > 0 {
		return booked[0].Teacher
	}
	if len(d.booking.Teachers) == 1 {
		return d.booking.Teachers[0].ID
	}
	return ""
}

func (d bookingDesk) remaining() int {
	left := d.booking.Max - d.mine.Count - len(d.own(store.BookingNew)) + len(d.own(store.BookingCancel))
	return max(0, left)
}

// choices sind die Zeiten der Lehrkraft, die die Person jetzt wählen kann, nach Tag und Uhrzeit.
func (d bookingDesk) choices(teacher *bookingTeacher) []slotChoice {
	skip := map[int]bool{}
	for _, i := range d.mine.Skip[teacher.ID] {
		skip[i] = true
	}
	clash := map[int]string{}
	for _, c := range d.mine.Clash[teacher.ID] {
		clash[c.I] = c.Group
	}
	taken, busyDays := map[string]bool{}, map[string]bool{}
	for _, b := range d.all {
		if b.Kind != store.BookingNew || !d.occupies(b) {
			continue
		}
		if b.Teacher == teacher.ID {
			taken[b.Date+" "+b.Time] = true
		}
		if b.Person == d.person.ID {
			busyDays[b.Date] = true
		}
	}
	day, clock := d.now.Format(time.DateOnly), d.now.Format("15:04")
	var list []slotChoice
	for i, slot := range teacher.Slots {
		value := slot.Date + " " + slot.Time
		past := slot.Date < day || (slot.Date == day && slot.Time <= clock)
		outside := slot.Date < d.booking.From || slot.Date > d.booking.To
		if skip[i] || taken[value] || busyDays[slot.Date] || past || outside {
			continue
		}
		list = append(list, slotChoice{Value: value, Date: slot.Date, Time: slot.Time, Clash: clash[i]})
	}
	return list
}

// checkBook prüft eine neue Eintragung gegen den aktuellen Stand.
func (d bookingDesk) checkBook(teacherID, value string) error {
	if len(d.all) >= maxBookingsPerPeriod {
		return errBookingLimit
	}
	if fixed := d.teacherID(); fixed != "" && fixed != teacherID {
		return errNotBookable
	}
	teacher := d.booking.teacher(teacherID)
	if teacher == nil {
		return errNotBookable
	}
	if d.remaining() == 0 {
		return errNoneLeft
	}
	if !slices.ContainsFunc(d.choices(teacher), func(c slotChoice) bool { return c.Value == value }) {
		// Lag die Zeit im Angebot, hat sie inzwischen jemand anderes.
		if date, clock, _ := strings.Cut(value, " "); d.offered(teacher, date, clock) {
			return errSlotTaken
		}
		return errNotBookable
	}
	return nil
}

// offered: Stand die Zeit überhaupt für die Person zur Wahl (ohne andere Eintragungen)?
func (d bookingDesk) offered(teacher *bookingTeacher, date, clock string) bool {
	without := d
	without.all = nil
	return slices.ContainsFunc(without.choices(teacher), func(c slotChoice) bool { return c.Date == date && c.Time == clock })
}

// cancelling: Wird der eigene Termin gerade ausgetragen?
func (d bookingDesk) cancelling(slot string) bool {
	return slices.ContainsFunc(d.own(store.BookingCancel), func(b store.PlanBooking) bool { return b.Slot == slot })
}

// --- Seiten ---

type slotChoice struct {
	// „JJJJ-MM-TT HH:MM“ für das Formular
	Value string
	Date  string
	Time  string
	// Name der Gruppe, deren Unterricht sich überschneidet
	Clash string
}

type choiceDay struct {
	Label string
	Slots []slotChoice
}

type teacherChoice struct {
	ID         string
	Name       string
	Instrument string
	Free       int
}

type ownView struct {
	Label      string
	Slot       string
	Removable  bool
	Cancelling bool
}

type bookingEntry struct {
	ID       string
	Text     string
	Status   string
	Withdraw bool
}

type bookingView struct {
	Period    string
	Max       int
	Remaining int
	// Lehrkraft, deren Zeiten zu sehen sind; fehlt, solange die Person erst wählt
	Teacher  *bookingTeacher
	Choosing bool
	Teachers []teacherChoice
	Days     []choiceDay
	HasClash bool
	Own      []ownView
	Entries  []bookingEntry
	// Hinweis, warum es gerade nichts zu wählen gibt
	Closed string
}

// bookingSummary steht auf der Seite der Person: wie viele Termine sie noch wählen kann.
type bookingSummary struct {
	Remaining int
	Failed    int
}

// desk lädt die Eintragungen; ohne Selbsteintragung für die Person liefert es false.
func (s *Server) desk(r *http.Request, plans planContent, link store.PlanLink, person *planPerson) (bookingDesk, bool, error) {
	if plans.Booking == nil || person.Booking == nil {
		return bookingDesk{}, false, nil
	}
	all, err := s.store.PlanBookings(r.Context(), link.PeriodID)
	if err != nil {
		return bookingDesk{}, false, err
	}
	return bookingDesk{booking: plans.Booking, person: person, mine: person.Booking, all: all, inPlans: plans.slotIDs(), now: time.Now()}, true, nil
}

// summary für die Seite der Person; nil ohne Selbsteintragung.
func (d bookingDesk) summary() *bookingSummary {
	failed := 0
	for _, b := range d.all {
		if b.Person == d.person.ID && b.Status == store.RequestFailed && time.Since(b.UpdatedAt) <= requestHistory {
			failed++
		}
	}
	return &bookingSummary{Remaining: d.remaining(), Failed: failed}
}

// bookingPage zeigt die freien Zeiten zum Wählen, die eigenen Termine zum Austragen und den Stand der Eintragungen.
func (s *Server) bookingPage(w http.ResponseWriter, r *http.Request) {
	plans, link, person, ok := s.requester(w, r)
	if !ok {
		return
	}
	desk, ok, err := s.desk(r, plans, link, person)
	if err != nil {
		internal(w, err)
		return
	}
	base := s.planURL(link.Token)
	if !ok {
		renderPage(w, http.StatusNotFound, messagePage, pageData{Message: "Hier kannst du dich gerade nicht selbst eintragen.", Back: base + "/" + person.ID})
		return
	}
	query := r.URL.Query()
	view := desk.view(query.Get("lehrkraft"))
	data := pageData{Plans: plans, Person: person, Base: base, Updated: updatedText(link), Notice: bookingNotices[query.Get("hinweis")], Booking: view}
	renderPage(w, http.StatusOK, bookingPageTemplate, data)
}

func (d bookingDesk) view(browsing string) *bookingView {
	view := &bookingView{Period: dateText(d.booking.From) + " – " + dateText(d.booking.To), Max: d.booking.Max, Remaining: d.remaining()}
	switch fixed := d.teacherID(); {
	case fixed != "":
		view.Teacher = d.booking.teacher(fixed)
	case d.booking.teacher(browsing) != nil:
		view.Teacher, view.Choosing = d.booking.teacher(browsing), true
	default:
		for i := range d.booking.Teachers {
			t := &d.booking.Teachers[i]
			view.Teachers = append(view.Teachers, teacherChoice{ID: t.ID, Name: t.Name, Instrument: t.Instrument, Free: len(d.choices(t))})
		}
	}
	if view.Teacher != nil {
		view.Days = groupChoices(d.choices(view.Teacher))
		view.HasClash = slices.ContainsFunc(view.Days, func(day choiceDay) bool {
			return slices.ContainsFunc(day.Slots, func(c slotChoice) bool { return c.Clash != "" })
		})
	} else if len(view.Teachers) == 0 {
		view.Closed = "Bei deiner Lehrkraft kannst du dich gerade nicht selbst eintragen."
	}
	day := d.now.Format(time.DateOnly)
	for _, own := range d.mine.Own {
		if own.Date >= day {
			view.Own = append(view.Own, ownView{Label: d.slotLabel(own.Teacher, own.Date, own.Time), Slot: own.Slot, Removable: own.Removable, Cancelling: d.cancelling(own.Slot)})
		}
	}
	view.Entries = d.entries()
	return view
}

// entries: Eintragungen der Person, die noch nicht im Plan stehen, und solche, die nicht geklappt haben
func (d bookingDesk) entries() []bookingEntry {
	var list []bookingEntry
	for _, b := range d.all {
		if b.Person != d.person.ID {
			continue
		}
		text := d.slotLabel(b.Teacher, b.Date, b.Time)
		if b.Kind == store.BookingCancel {
			text = "Austragen: " + text
		}
		switch {
		case b.Status == store.RequestFailed && time.Since(b.UpdatedAt) <= requestHistory:
			list = append(list, bookingEntry{ID: b.ID, Text: text, Status: "Hat nicht geklappt: " + b.Note})
		case b.Kind == store.BookingNew && b.Status == store.RequestOpen:
			list = append(list, bookingEntry{ID: b.ID, Text: text, Status: "Vorgemerkt – kommt gleich in deinen Plan.", Withdraw: true})
		case b.Kind == store.BookingNew && d.occupies(b):
			list = append(list, bookingEntry{ID: b.ID, Text: text, Status: "Eingetragen – erscheint gleich in deinem Plan."})
		}
	}
	return list
}

// slotLabel: „Dienstag, 17. November, 14:00 bei Clara“
func (d bookingDesk) slotLabel(teacherID, date, clock string) string {
	label := dayText(date) + ", " + clock
	if teacher := d.booking.teacher(teacherID); teacher != nil && len(d.booking.Teachers) > 1 {
		label += " bei " + teacher.Name
	}
	return label
}

func groupChoices(choices []slotChoice) []choiceDay {
	var days []choiceDay
	for _, choice := range choices {
		if len(days) == 0 || days[len(days)-1].Slots[0].Date != choice.Date {
			days = append(days, choiceDay{Label: dayText(choice.Date)})
		}
		days[len(days)-1].Slots = append(days[len(days)-1].Slots, choice)
	}
	return days
}

// book trägt die Person für eine Zeit ein, wenn sie noch frei ist und die Person noch wählen darf.
func (s *Server) book(w http.ResponseWriter, r *http.Request) {
	plans, link, person, ok := s.requester(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	teacherID, value := r.PostFormValue("lehrkraft"), r.PostFormValue("zeit")
	desk, ok, err := s.desk(r, plans, link, person)
	if err != nil {
		internal(w, err)
		return
	}
	back := s.planURL(link.Token) + "/" + person.ID + "/termine"
	if !ok {
		renderPage(w, http.StatusNotFound, messagePage, pageData{Message: "Hier kannst du dich gerade nicht selbst eintragen.", Back: back})
		return
	}
	date, clock, _ := strings.Cut(value, " ")
	var slot bookingSlot
	if teacher := plans.Booking.teacher(teacherID); teacher != nil {
		slot, ok = teacher.slot(date, clock)
	}
	if !ok {
		renderPage(w, http.StatusBadRequest, messagePage, pageData{Message: errNotBookable.Error(), Back: back})
		return
	}
	booking := store.PlanBooking{ID: newBookingID(), PeriodID: link.PeriodID, Person: person.ID, Kind: store.BookingNew,
		Teacher: teacherID, Date: date, Time: clock, Minutes: slot.Minutes}
	err = s.store.AddPlanBooking(r.Context(), booking, func(existing []store.PlanBooking) error {
		desk.all = existing
		return desk.checkBook(teacherID, value)
	})
	switch {
	case errors.Is(err, errSlotTaken):
		bookingBack(w, r, "vergeben", teacherID)
	case errors.Is(err, errNoneLeft):
		bookingBack(w, r, "voll", teacherID)
	case errors.Is(err, errNotBookable), errors.Is(err, errBookingLimit):
		renderPage(w, http.StatusConflict, messagePage, pageData{Message: err.Error(), Back: back})
	case err != nil:
		internal(w, err)
	default:
		bookingBack(w, r, "eingetragen", teacherID)
	}
}

// unbook nimmt eine noch offene Eintragung zurück (`eintragung`) oder trägt einen eigenen Termin aus (`termin`).
func (s *Server) unbook(w http.ResponseWriter, r *http.Request) {
	plans, link, person, ok := s.requester(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	desk, ok, err := s.desk(r, plans, link, person)
	if err != nil {
		internal(w, err)
		return
	}
	if !ok {
		bookingBack(w, r, "veraltet", "")
		return
	}
	if id := r.PostFormValue("eintragung"); id != "" {
		s.withdrawBooking(w, r, desk, id)
		return
	}
	slot := r.PostFormValue("termin")
	i := slices.IndexFunc(desk.mine.Own, func(o ownLesson) bool { return o.Slot == slot })
	if i < 0 || !desk.mine.Own[i].Removable || desk.mine.Own[i].Date < desk.now.Format(time.DateOnly) {
		bookingBack(w, r, "veraltet", "")
		return
	}
	own := desk.mine.Own[i]
	cancel := store.PlanBooking{ID: newBookingID(), PeriodID: link.PeriodID, Person: person.ID, Kind: store.BookingCancel,
		Teacher: own.Teacher, Date: own.Date, Time: own.Time, Minutes: own.Minutes, Slot: own.Slot}
	err = s.store.AddPlanBooking(r.Context(), cancel, func(existing []store.PlanBooking) error {
		desk.all = existing
		switch {
		case desk.cancelling(slot):
			return errAlreadyCancelling
		case len(existing) >= maxBookingsPerPeriod:
			return errBookingLimit
		}
		return nil
	})
	switch {
	case err == nil, errors.Is(err, errAlreadyCancelling):
		bookingBack(w, r, "austragen", "")
	case errors.Is(err, errBookingLimit):
		renderPage(w, http.StatusConflict, messagePage, pageData{Message: err.Error(), Back: s.planURL(link.Token) + "/" + person.ID + "/termine"})
	default:
		internal(w, err)
	}
}

var errAlreadyCancelling = errors.New("wird schon ausgetragen")

func (s *Server) withdrawBooking(w http.ResponseWriter, r *http.Request, desk bookingDesk, id string) {
	i := slices.IndexFunc(desk.all, func(b store.PlanBooking) bool {
		return b.ID == id && b.Person == desk.person.ID && b.Kind == store.BookingNew
	})
	if i < 0 {
		bookingBack(w, r, "veraltet", "")
		return
	}
	err := s.store.SetPlanBookingStatus(r.Context(), desk.all[i].PeriodID, id, store.RequestOpen, store.RequestWithdrawn, "")
	switch {
	case errors.Is(err, store.ErrStale), errors.Is(err, store.ErrNotFound):
		bookingBack(w, r, "veraltet", "")
	case err != nil:
		internal(w, err)
	default:
		bookingBack(w, r, "zurueckgenommen", "")
	}
}

// bookingBack leitet zurück auf die Seite zum Wählen (…/<Person>/eintragen → …/<Person>/termine).
func bookingBack(w http.ResponseWriter, r *http.Request, notice, teacherID string) {
	query := url.Values{"hinweis": {notice}}
	if teacherID != "" {
		query.Set("lehrkraft", teacherID)
	}
	http.Redirect(w, r, "termine?"+query.Encode(), http.StatusSeeOther)
}

// Für Termine in der App (`buchung-<ID>`): nur Zeichen, die in IDs der Pläne erlaubt sind
func newBookingID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

var (
	weekdays = []string{"Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"}
	months   = []string{"Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"}
)

// dayText: „Dienstag, 17. November“
func dayText(date string) string {
	day, err := time.Parse(time.DateOnly, date)
	if err != nil {
		return date
	}
	return fmt.Sprintf("%s, %d. %s", weekdays[day.Weekday()], day.Day(), months[day.Month()-1])
}

// dateText: „17.11.2026“
func dateText(date string) string {
	day, err := time.Parse(time.DateOnly, date)
	if err != nil {
		return date
	}
	return day.Format("02.01.2006")
}

// --- Für die Apps der Lehrkräfte ---

type bookingAnswer struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Person  string `json:"person"`
	Teacher string `json:"teacher"`
	Date    string `json:"date"`
	Time    string `json:"time"`
	Minutes int    `json:"minutes"`
	Slot    string `json:"slot"`
}

// openBookings liefert die Eintragungen, die die App in die Daten übernehmen soll, die ältesten zuerst.
func (s *Server) openBookings(w http.ResponseWriter, r *http.Request, account store.Account) {
	periodID, _, ok := s.planPeriod(w, r, account)
	if !ok {
		return
	}
	all, err := s.store.PlanBookings(r.Context(), periodID)
	if err != nil {
		internal(w, err)
		return
	}
	list := []bookingAnswer{}
	for _, b := range slices.Backward(all) {
		if b.Status == store.RequestOpen {
			list = append(list, bookingAnswer{ID: b.ID, Kind: b.Kind, Person: b.Person, Teacher: b.Teacher, Date: b.Date, Time: b.Time, Minutes: b.Minutes, Slot: b.Slot})
		}
	}
	writeJSON(w, list)
}

// bookingDone: Die App übernimmt eine Eintragung (`applied`) oder kann es nicht (`failed`, mit Grund). Beim
// Übernehmen meldet sie zuerst und ändert erst danach ihre Daten: 409 heißt, die Eintragung ist nicht mehr offen
// (zurückgenommen oder von einem anderen Gerät übernommen), dann ändert sie nichts.
func (s *Server) bookingDone(w http.ResponseWriter, r *http.Request, account store.Account) {
	periodID, _, ok := s.planPeriod(w, r, account)
	if !ok {
		return
	}
	var body struct{ Status, Note string }
	if !readJSON(w, r, &body) {
		return
	}
	if body.Status != store.RequestApplied && body.Status != store.RequestFailed {
		fail(w, http.StatusBadRequest, "Zustand muss applied oder failed sein.")
		return
	}
	note := strings.TrimSpace(body.Note)
	if len(note) > 300 {
		note = note[:300]
	}
	err := s.store.SetPlanBookingStatus(r.Context(), periodID, r.PathValue("id"), store.RequestOpen, body.Status, note)
	switch {
	case errors.Is(err, store.ErrNotFound):
		fail(w, http.StatusNotFound, "Diese Eintragung gibt es nicht.")
	case errors.Is(err, store.ErrStale):
		fail(w, http.StatusConflict, "Diese Eintragung ist nicht mehr offen.")
	case err != nil:
		internal(w, err)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}
