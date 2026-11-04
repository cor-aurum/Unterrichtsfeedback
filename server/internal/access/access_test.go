package access

import "testing"

func TestParse(t *testing.T) {
	cases := map[string]Doc{
		"konfiguration.json":                  {Kind: Config},
		"allgemeine-termine.json":             {Kind: Shared},
		"lehrer-abc-123.json":                 {Kind: Teacher, TeacherID: "abc-123"},
		"zeitraum_p-1_t-2.json":               {Kind: Period, PeriodID: "p-1", TeacherID: "t-2"},
		"zeitraum__t-2.json":                  {Kind: Period, PeriodID: "", TeacherID: "t-2"},
		"zeitraum_halbjahr-2026-08-01_x.json": {Kind: Period, PeriodID: "halbjahr-2026-08-01", TeacherID: "x"},
	}
	for name, want := range cases {
		got, err := Parse(name)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got.Kind != want.Kind || got.PeriodID != want.PeriodID || got.TeacherID != want.TeacherID {
			t.Errorf("%s: %+v, erwartet %+v", name, got, want)
		}
	}
	for _, name := range []string{"../etc/passwd", "lehrer-.json", "zeitraum-alt-anna.json", "notizen.txt", "lehrer-a/b.json"} {
		if _, err := Parse(name); err == nil {
			t.Errorf("%s: sollte abgelehnt werden", name)
		}
	}
}

func TestReadAccess(t *testing.T) {
	members := Members{"p1": {"anna", "ben"}, "p2": {"clara"}}
	period := func(p, teacher string) Doc { return Doc{Kind: Period, PeriodID: p, TeacherID: teacher} }
	cases := []struct {
		doc     Doc
		teacher string
		want    bool
	}{
		{Doc{Kind: Config}, "dora", true},
		{Doc{Kind: Teacher, TeacherID: "anna"}, "dora", true},
		{period("p1", "anna"), "ben", true},
		{period("p1", "anna"), "clara", false},
		{period("p2", "clara"), "anna", false},
		{period("unbekannt", "anna"), "anna", false},
		{period("", "anna"), "anna", true},
		{period("", "anna"), "ben", false},
	}
	for _, c := range cases {
		if got := CanRead(c.doc, c.teacher, members); got != c.want {
			t.Errorf("%+v für %s: %v, erwartet %v", c.doc, c.teacher, got, c.want)
		}
	}
}

func TestCheckConfig(t *testing.T) {
	old := Members{"p1": {"anna", "ben"}, "p2": {"clara"}}
	cases := []struct {
		name    string
		next    Members
		teacher string
		ok      bool
	}{
		{"unverändert", Members{"p1": {"ben", "anna"}, "p2": {"clara"}}, "dora", true},
		{"Mitglied lädt ein", Members{"p1": {"anna", "ben", "dora"}, "p2": {"clara"}}, "anna", true},
		{"Fremder trägt sich ein", Members{"p1": {"anna", "ben"}, "p2": {"clara", "anna"}}, "anna", false},
		{"Fremder löscht", Members{"p1": {"anna", "ben"}}, "anna", false},
		{"Mitglied löscht", Members{"p1": {"anna", "ben"}}, "clara", true},
		{"neuer Zeitraum mit sich", Members{"p1": {"anna", "ben"}, "p2": {"clara"}, "p3": {"dora"}}, "dora", true},
		{"neuer Zeitraum ohne sich", Members{"p1": {"anna", "ben"}, "p2": {"clara"}, "p3": {"ben"}}, "dora", false},
	}
	for _, c := range cases {
		err := CheckConfig(old, c.next, c.teacher)
		if (err == nil) != c.ok {
			t.Errorf("%s: Fehler %v, erlaubt erwartet: %v", c.name, err, c.ok)
		}
	}
	if err := CheckConfig(Members{}, Members{"p1": {"anna"}}, "anna"); err != nil {
		t.Errorf("erste Konfiguration: %v", err)
	}
}

func TestMembersOf(t *testing.T) {
	m, err := MembersOf([]byte(`{"format":"unterricht-feedback/konfiguration","config":{"reportPeriods":[{"id":"p1","teacherIds":["anna"]}]}}`))
	if err != nil || !m.In("p1", "anna") || m.In("p1", "ben") {
		t.Fatalf("%v %v", m, err)
	}
	if _, err := MembersOf([]byte(`kein json`)); err == nil {
		t.Error("ungültige Konfiguration sollte ein Fehler sein")
	}
}
