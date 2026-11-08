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

// Einen Berichtszeitraum lesen und ändern dürfen nur seine Lehrer; einen neuen anlegen darf jeder.
func TestPeriodConfigAccess(t *testing.T) {
	members := Members{"p1": {"anna", "ben"}}
	doc := func(p string) Doc { return Doc{Kind: PeriodConfig, PeriodID: p} }
	cases := []struct {
		doc               Doc
		teacher           string
		canRead, canWrite bool
	}{
		{doc("p1"), "anna", true, true},
		{doc("p1"), "clara", false, false},
		{doc("neu"), "clara", false, true},
	}
	for _, c := range cases {
		if got := CanRead(c.doc, c.teacher, members); got != c.canRead {
			t.Errorf("%s liest %s: %v", c.teacher, c.doc.PeriodID, got)
		}
		if got := CanWrite(c.doc, c.teacher, members); got != c.canWrite {
			t.Errorf("%s schreibt %s: %v", c.teacher, c.doc.PeriodID, got)
		}
	}
	if got, err := Parse("berichtszeitraum_p-1.json"); err != nil || got.Kind != PeriodConfig || got.PeriodID != "p-1" {
		t.Errorf("berichtszeitraum_p-1.json: %+v, %v", got, err)
	}
	id, teachers, err := PeriodOf([]byte(`{"period":{"id":"p1","teacherIds":["anna"]}}`))
	if err != nil || id != "p1" || len(teachers) != 1 {
		t.Errorf("PeriodOf: %s %v %v", id, teachers, err)
	}
	if !HasPeriods([]byte(`{"config":{"reportPeriods":[{"id":"p1"}]}}`)) || HasPeriods([]byte(`{"config":{}}`)) {
		t.Error("HasPeriods")
	}
}
