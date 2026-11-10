// Package access legt fest, welche Dokumente ein Lehrer lesen und schreiben darf.
//
// Die App speichert ihre Daten in denselben Dokumenten wie früher im Sync-Ordner:
//
//	konfiguration.json                  gemeinsame Konfiguration (ohne Berichtszeiträume)
//	allgemeine-termine.json             Termine für mehrere Lehrer außerhalb der Berichtszeiträume
//	lehrer-<Lehrer-ID>.json             ein Lehrer mit Textvarianten und Blockern
//	berichtszeitraum_<Zeitraum-ID>.json ein Berichtszeitraum: Name, Daten, Lehrer, Unterrichtszeiten und Orte der
//	                                    Lehrer darin, seine allgemeinen Termine
//	zeitraum_<Zeitraum-ID>_<Lehrer-ID>.json
//	                                    Personen, Gruppen, Stunden und Termine eines Lehrers in einem Zeitraum
//	                                    (ohne Zeitraum-ID: Personen ohne bekannten Zeitraum)
//
// Alles, was zu einem Berichtszeitraum gehört, sieht nur, wer in ihm als Lehrer eingetragen ist; die anderen
// erfahren nur, dass es ihn gibt. Wer eingetragen ist, steht im Dokument des Zeitraums; ändern dürfen das nur die
// Lehrer, die schon eingetragen sind.
package access

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
)

// Kind ist die Art eines Dokuments.
type Kind int

const (
	Config Kind = iota
	Shared
	Teacher
	Period
	PeriodConfig
)

const (
	ConfigName = "konfiguration.json"
	SharedName = "allgemeine-termine.json"
)

var (
	teacherName = regexp.MustCompile(`^lehrer-([A-Za-z0-9-]+)\.json$`)
	periodName  = regexp.MustCompile(`^zeitraum_([A-Za-z0-9-]*)_([A-Za-z0-9-]+)\.json$`)
	reportName  = regexp.MustCompile(`^berichtszeitraum_([A-Za-z0-9-]+)\.json$`)
)

// Doc ist ein Dokumentname mit dem, was sich aus ihm ablesen lässt.
type Doc struct {
	Name      string
	Kind      Kind
	PeriodID  string
	TeacherID string
}

// ErrUnknownName steht für einen Namen, den die App nicht schreibt.
var ErrUnknownName = errors.New("unbekannter Dokumentname")

// Parse ordnet einen Dokumentnamen ein.
func Parse(name string) (Doc, error) {
	switch {
	case name == ConfigName:
		return Doc{Name: name, Kind: Config}, nil
	case name == SharedName:
		return Doc{Name: name, Kind: Shared}, nil
	}
	if m := teacherName.FindStringSubmatch(name); m != nil {
		return Doc{Name: name, Kind: Teacher, TeacherID: m[1]}, nil
	}
	if m := periodName.FindStringSubmatch(name); m != nil {
		return Doc{Name: name, Kind: Period, PeriodID: m[1], TeacherID: m[2]}, nil
	}
	if m := reportName.FindStringSubmatch(name); m != nil {
		return Doc{Name: name, Kind: PeriodConfig, PeriodID: m[1]}, nil
	}
	return Doc{}, ErrUnknownName
}

// PeriodDocName ist der Name des Dokuments eines Berichtszeitraums.
func PeriodDocName(periodID string) string {
	return "berichtszeitraum_" + periodID + ".json"
}

// PeriodOf liest ID und Lehrer aus dem Dokument eines Berichtszeitraums.
func PeriodOf(content []byte) (string, []string, error) {
	var file struct {
		Period struct {
			ID         string   `json:"id"`
			TeacherIDs []string `json:"teacherIds"`
		} `json:"period"`
	}
	if err := json.Unmarshal(content, &file); err != nil {
		return "", nil, fmt.Errorf("Berichtszeitraum lässt sich nicht lesen: %w", err)
	}
	if file.Period.ID == "" {
		return "", nil, errors.New("der Berichtszeitraum hat keine ID")
	}
	return file.Period.ID, file.Period.TeacherIDs, nil
}

// PeriodEnd liest den letzten Tag (JJJJ-MM-TT) aus dem Dokument eines Berichtszeitraums.
func PeriodEnd(content []byte) (string, error) {
	var file struct {
		Period struct {
			To string `json:"to"`
		} `json:"period"`
	}
	if err := json.Unmarshal(content, &file); err != nil {
		return "", fmt.Errorf("Berichtszeitraum lässt sich nicht lesen: %w", err)
	}
	if file.Period.To == "" {
		return "", errors.New("der Berichtszeitraum hat kein Ende")
	}
	return file.Period.To, nil
}

// HasPeriods ist wahr, wenn eine Konfiguration noch Berichtszeiträume enthält (ältere App-Versionen).
func HasPeriods(config []byte) bool {
	var file struct {
		Config struct {
			ReportPeriods []json.RawMessage `json:"reportPeriods"`
		} `json:"config"`
	}
	return json.Unmarshal(config, &file) == nil && len(file.Config.ReportPeriods) > 0
}

// Members ordnet jedem Berichtszeitraum die Lehrer zu, die in ihm eingetragen sind.
type Members map[string][]string

// MembersOf liest die Berichtszeiträume aus einer älteren Konfiguration, die sie noch enthält; ohne gibt es keine.
func MembersOf(config []byte) (Members, error) {
	members := Members{}
	if len(config) == 0 {
		return members, nil
	}
	var file struct {
		Config struct {
			ReportPeriods []struct {
				ID         string   `json:"id"`
				TeacherIDs []string `json:"teacherIds"`
			} `json:"reportPeriods"`
		} `json:"config"`
	}
	if err := json.Unmarshal(config, &file); err != nil {
		return nil, fmt.Errorf("Konfiguration lässt sich nicht lesen: %w", err)
	}
	for _, period := range file.Config.ReportPeriods {
		if period.ID == "" {
			return nil, errors.New("ein Berichtszeitraum hat keine ID")
		}
		members[period.ID] = period.TeacherIDs
	}
	return members, nil
}

// In ist wahr, wenn der Lehrer im Zeitraum eingetragen ist.
func (m Members) In(periodID, teacherID string) bool {
	return slices.Contains(m[periodID], teacherID)
}

// CanRead sagt, ob der Lehrer das Dokument sehen darf.
func CanRead(doc Doc, teacherID string, members Members) bool {
	if doc.Kind == PeriodConfig {
		return members.In(doc.PeriodID, teacherID)
	}
	if doc.Kind != Period {
		return true
	}
	if doc.PeriodID == "" {
		// Personen ohne bekannten Zeitraum sieht nur ihr Lehrer.
		return doc.TeacherID == teacherID
	}
	return members.In(doc.PeriodID, teacherID)
}

// CanWrite sagt, ob der Lehrer das Dokument ändern oder löschen darf. Einen neuen Berichtszeitraum darf jeder
// anlegen; dass er sich dabei selbst einträgt, prüft der Server am Inhalt.
func CanWrite(doc Doc, teacherID string, members Members) bool {
	if doc.Kind == PeriodConfig {
		_, exists := members[doc.PeriodID]
		return !exists || members.In(doc.PeriodID, teacherID)
	}
	return CanRead(doc, teacherID, members)
}

// StudentIDs liest die IDs der Personen aus einem Zeitraum-Dokument, z. B. um eine Zusammenführung zu prüfen.
func StudentIDs(content []byte) ([]string, error) {
	var file struct {
		Students []struct {
			ID string `json:"id"`
		} `json:"students"`
	}
	if err := json.Unmarshal(content, &file); err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(file.Students))
	for _, student := range file.Students {
		ids = append(ids, student.ID)
	}
	return ids, nil
}
