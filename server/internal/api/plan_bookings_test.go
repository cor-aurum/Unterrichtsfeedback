package api

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"
	"testing"

	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/store"
)

// Selbsteintragung über den Link: wählen, vergeben, Höchstzahl, Lehrkraft wählen, zurücknehmen, austragen; die App
// übernimmt.
func TestPlanBookings(t *testing.T) {
	srv, base := setup(t)
	code, _, err := srv.NewCode(context.Background(), store.Invite, "")
	if err != nil {
		t.Fatal(err)
	}
	anna := &client{t: t, base: base}
	anna.session(anna.must(200, "POST", "/api/redeem", `{"code":"`+code+`","username":"anna","password":"geheim123","teacherId":"t-anna"}`))
	anna.must(200, "PUT", "/api/docs/berichtszeitraum_p1.json", period("p1", "t-anna"))
	link := planPath(t, anna.must(200, "POST", "/api/plans/p1/address", ""))

	slot := func(date, clock string) bookingSlot { return bookingSlot{Date: date, Time: clock, Minutes: 45} }
	plans := planContent{
		Title: "Halbjahr",
		Booking: &planBooking{From: "2099-12-01", To: "2099-12-10", Max: 2, Teachers: []bookingTeacher{
			{ID: "t-anna", Name: "Anna", Instrument: "Klavier", Slots: []bookingSlot{
				slot("2099-12-01", "10:00"), slot("2099-12-01", "11:00"), slot("2099-12-02", "10:00"), slot("2099-12-01", "12:00"),
			}},
			{ID: "t-ben", Name: "Ben", Instrument: "Geige", Slots: []bookingSlot{slot("2099-12-01", "10:00")}},
		}},
		People: []planPerson{
			{ID: "lea", Label: "Lea", ICS: calendarText, PDF: pdfBase64, Booking: &personBooking{
				Teacher: "t-anna", Count: 1,
				Own:   []ownLesson{{Slot: "a-lea", Teacher: "t-anna", Date: "2099-12-03", Time: "10:00", Minutes: 45, Removable: true}},
				Skip:  map[string][]int{"t-anna": {2}},
				Clash: map[string][]slotClash{"t-anna": {{I: 1, Group: "Gruppe Chor"}}},
			}},
			{ID: "max", Label: "Max", ICS: calendarText, PDF: pdfBase64, Booking: &personBooking{}},
			{ID: "tom", Label: "Tom", ICS: calendarText, PDF: pdfBase64},
		},
	}
	data, _ := json.Marshal(plans)
	anna.must(204, "PUT", "/api/plans/p1", string(data))
	visitor := &client{t: t, base: base}
	book := func(person, teacher, value string) (int, string) {
		return post(t, base, link+"/"+person+"/eintragen", url.Values{"lehrkraft": {teacher}, "zeit": {value}})
	}

	// Lea sieht die freien Zeiten ihrer Lehrkraft ohne die für sie gesperrte, mit Gruppenunterricht markiert.
	page := visitor.must(200, "GET", link+"/lea/termine", "")
	if !strings.Contains(page, `value="2099-12-01 10:00"`) || strings.Contains(page, `value="2099-12-02 10:00"`) ||
		!strings.Contains(page, "⚠ Gruppe Chor") || !strings.Contains(page, "noch <strong>1</strong> Termin wählen") {
		t.Fatalf("Zeiten für Lea: %s", page)
	}
	if !strings.Contains(visitor.must(200, "GET", link+"/lea", ""), "Termine selbst eintragen") {
		t.Fatal("Hinweis auf der Seite der Person fehlt")
	}
	visitor.must(404, "GET", link+"/tom/termine", "")
	if status, _ := book("tom", "t-anna", "2099-12-01 10:00"); status != 404 {
		t.Fatalf("Tom ist nicht dabei: %d", status)
	}

	// Max wählt erst seine Lehrkraft; mit der ersten Eintragung steht sie fest.
	if page := visitor.must(200, "GET", link+"/max/termine", ""); !strings.Contains(page, "Bei wem möchtest du") || !strings.Contains(page, "Ben") {
		t.Fatalf("Lehrkraft wählen: %s", page)
	}
	if status, text := book("max", "t-anna", "2099-12-01 10:00"); status != 200 || !strings.Contains(text, "Eingetragen.") {
		t.Fatalf("Max trägt sich ein: %d %s", status, text)
	}
	if page := visitor.must(200, "GET", link+"/max/termine", ""); strings.Contains(page, "Bei wem") || !strings.Contains(page, "Vorgemerkt") {
		t.Fatalf("Max nach der Eintragung: %s", page)
	}
	if status, _ := book("max", "t-ben", "2099-12-01 10:00"); status != 409 {
		t.Fatalf("Max bei einer anderen Lehrkraft: %d", status)
	}
	// Am selben Tag nur ein Termin
	if _, text := book("max", "t-anna", "2099-12-01 12:00"); strings.Contains(text, "Eingetragen.") {
		t.Fatal("zweiter Termin am selben Tag")
	}

	// Die Zeit von Max ist vergeben; gesperrte Zeiten gehen nicht, mehr als die Höchstzahl auch nicht.
	if _, text := book("lea", "t-anna", "2099-12-01 10:00"); !strings.Contains(text, "gerade vergeben") {
		t.Fatalf("vergebene Zeit: %s", text)
	}
	if status, _ := book("lea", "t-anna", "2099-12-02 10:00"); status != 409 {
		t.Fatalf("gesperrte Zeit: %d", status)
	}
	if _, text := book("lea", "t-anna", "2099-12-01 11:00"); !strings.Contains(text, "Eingetragen.") || !strings.Contains(text, "alle Termine gewählt") {
		t.Fatalf("Lea trägt sich ein: %s", text)
	}
	if _, text := book("lea", "t-anna", "2099-12-01 12:00"); !strings.Contains(text, "schon alle Termine") {
		t.Fatalf("über der Höchstzahl: %s", text)
	}

	// Die App holt die offenen Eintragungen, die ältesten zuerst, und meldet zuerst, bevor sie etwas ändert.
	var open []bookingAnswer
	_ = json.Unmarshal([]byte(anna.must(200, "GET", "/api/plans/p1/bookings", "")), &open)
	if len(open) != 2 || open[0].Person != "max" || open[1].Person != "lea" || open[0].Minutes != 45 {
		t.Fatalf("offene Eintragungen: %+v", open)
	}
	anna.must(204, "POST", "/api/plans/p1/bookings/"+open[0].ID, `{"status":"applied"}`)
	anna.must(409, "POST", "/api/plans/p1/bookings/"+open[0].ID, `{"status":"applied"}`)
	anna.must(204, "POST", "/api/plans/p1/bookings/"+open[1].ID, `{"status":"failed","note":"Die Zeit ist inzwischen belegt."}`)
	anna.must(400, "POST", "/api/plans/p1/bookings/"+open[1].ID, `{"status":"open"}`)
	// Übernommen, aber noch nicht in den Plänen: Die Zeit bleibt vergeben.
	if _, text := book("lea", "t-anna", "2099-12-01 10:00"); !strings.Contains(text, "gerade vergeben") {
		t.Fatalf("übernommene Zeit: %s", text)
	}
	// Neuere Pläne ohne den Termin (ein Gerät, das noch nicht abgeglichen hat) geben die Zeit nicht frei …
	anna.must(204, "PUT", "/api/plans/p1", string(data))
	if _, text := book("lea", "t-anna", "2099-12-01 10:00"); !strings.Contains(text, "gerade vergeben") {
		t.Fatalf("übernommene Zeit nach älteren Plänen: %s", text)
	}
	if page := visitor.must(200, "GET", link+"/max/termine", ""); !strings.Contains(page, "Eingetragen – erscheint gleich") {
		t.Fatalf("Max vor den neuen Plänen: %s", page)
	}
	// … erst Pläne mit dem Termin; sie sind sofort zu sehen, auch in derselben Sekunde.
	withMax := plans
	withMax.People = append([]planPerson(nil), plans.People...)
	withMax.People[1].Days = []planDay{{Day: "2099-12-01", Date: "1. Dezember", Entries: []planEntry{{Time: "10:00–10:45", Title: "Unterricht bei Anna", Slot: BookingAppointmentID(open[0].ID)}}}}
	withMax.People[1].Booking = &personBooking{Teacher: "t-anna", Count: 1}
	updated, _ := json.Marshal(withMax)
	anna.must(204, "PUT", "/api/plans/p1", string(updated))
	if page := visitor.must(200, "GET", link+"/max/termine", ""); strings.Contains(page, "Eingetragen – erscheint gleich") || !strings.Contains(page, "noch <strong>1</strong> Termin") {
		t.Fatalf("Max nach den neuen Plänen: %s", page)
	}
	page = visitor.must(200, "GET", link+"/lea/termine", "")
	if !strings.Contains(page, "Hat nicht geklappt: Die Zeit ist inzwischen belegt.") {
		t.Fatalf("gescheiterte Eintragung: %s", page)
	}
	if !strings.Contains(visitor.must(200, "GET", link+"/lea", ""), "Eine Eintragung hat nicht geklappt") {
		t.Fatal("Hinweis auf gescheiterte Eintragung fehlt")
	}

	// Zurücknehmen geht, solange die App nicht übernommen hat.
	if _, text := book("lea", "t-anna", "2099-12-01 12:00"); !strings.Contains(text, "Eingetragen.") {
		t.Fatalf("Lea trägt sich erneut ein: %s", text)
	}
	_ = json.Unmarshal([]byte(anna.must(200, "GET", "/api/plans/p1/bookings", "")), &open)
	if _, text := post(t, base, link+"/max/austragen", url.Values{"eintragung": {open[0].ID}}); !strings.Contains(text, "geht nicht mehr") {
		t.Fatalf("Max nimmt Leas Eintragung zurück: %s", text)
	}
	if _, text := post(t, base, link+"/lea/austragen", url.Values{"eintragung": {open[0].ID}}); !strings.Contains(text, "zurückgenommen") {
		t.Fatalf("Zurücknehmen: %s", text)
	}

	// Austragen eines eigenen Termins geht über die App; doppelt zählt nicht doppelt.
	for range 2 {
		if _, text := post(t, base, link+"/lea/austragen", url.Values{"termin": {"a-lea"}}); !strings.Contains(text, "Wird ausgetragen") {
			t.Fatalf("Austragen: %s", text)
		}
	}
	_ = json.Unmarshal([]byte(anna.must(200, "GET", "/api/plans/p1/bookings", "")), &open)
	if len(open) != 1 || open[0].Kind != store.BookingCancel || open[0].Slot != "a-lea" {
		t.Fatalf("Austragen für die App: %+v", open)
	}
	if _, text := post(t, base, link+"/lea/austragen", url.Values{"termin": {"a-fremd"}}); !strings.Contains(text, "geht nicht mehr") {
		t.Fatalf("fremden Termin austragen: %s", text)
	}

	// Ungültige Selbsteintragung nimmt der Server nicht an.
	plans.Booking.Teachers[0].ID = "t_anna?"
	data, _ = json.Marshal(plans)
	anna.must(400, "PUT", "/api/plans/p1", string(data))
	// Mit dem Link verschwinden auch die Eintragungen.
	anna.must(204, "DELETE", "/api/plans/p1", "")
	if all, _ := srv.store.PlanBookings(context.Background(), "p1"); len(all) != 0 {
		t.Fatalf("Eintragungen nach dem Löschen: %d", len(all))
	}
}
