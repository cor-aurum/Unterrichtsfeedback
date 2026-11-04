// Package access legt fest, welche Dokumente ein Lehrer lesen und schreiben darf.
//
// Die App speichert ihre Daten in denselben Dokumenten wie früher im Sync-Ordner:
//
//	konfiguration.json                  gemeinsame Konfiguration, darin die Berichtszeiträume mit ihren Lehrern
//	allgemeine-termine.json             Termine für mehrere Lehrer
//	lehrer-<Lehrer-ID>.json             ein Lehrer mit Textvarianten und Blockern
//	zeitraum_<Zeitraum-ID>_<Lehrer-ID>.json
//	                                    Personen, Gruppen, Stunden und Termine eines Lehrers in einem Zeitraum
//	                                    (ohne Zeitraum-ID: Personen ohne bekannten Zeitraum)
//
// Personen und ihre Stunden sieht nur, wer in dem Berichtszeitraum als Lehrer eingetragen ist. Wer das ist, steht
// in der Konfiguration; ändern dürfen das nur die Lehrer, die schon eingetragen sind.
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
)

const (
	ConfigName = "konfiguration.json"
	SharedName = "allgemeine-termine.json"
)

var (
	teacherName = regexp.MustCompile(`^lehrer-([A-Za-z0-9-]+)\.json$`)
	periodName  = regexp.MustCompile(`^zeitraum_([A-Za-z0-9-]*)_([A-Za-z0-9-]+)\.json$`)
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
	return Doc{}, ErrUnknownName
}

// Members ordnet jedem Berichtszeitraum die Lehrer zu, die in ihm eingetragen sind.
type Members map[string][]string

// MembersOf liest die Berichtszeiträume aus der Konfiguration; ohne Konfiguration gibt es keine.
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
	if doc.Kind != Period {
		return true
	}
	if doc.PeriodID == "" {
		// Personen ohne bekannten Zeitraum sieht nur ihr Lehrer.
		return doc.TeacherID == teacherID
	}
	return members.In(doc.PeriodID, teacherID)
}

// CanWrite sagt, ob der Lehrer das Dokument ändern oder löschen darf. Für die Konfiguration prüft CheckConfig
// zusätzlich, welche Zeiträume sich ändern.
func CanWrite(doc Doc, teacherID string, members Members) bool {
	return CanRead(doc, teacherID, members)
}

// CheckConfig prüft eine neue Konfiguration gegen die bisherige: Die Lehrer eines Zeitraums ändern oder ihn
// löschen darf nur, wer in ihm eingetragen ist; einen neuen Zeitraum anlegen darf jeder, der sich selbst einträgt.
func CheckConfig(old, next Members, teacherID string) error {
	for id, before := range old {
		after, kept := next[id]
		if kept && sameSet(before, after) {
			continue
		}
		if !slices.Contains(before, teacherID) {
			if !kept {
				return fmt.Errorf("Berichtszeitraum %q: nur eingetragene Lehrer dürfen ihn löschen", id)
			}
			return fmt.Errorf("Berichtszeitraum %q: nur eingetragene Lehrer dürfen seine Lehrer ändern", id)
		}
	}
	for id, after := range next {
		if _, existed := old[id]; !existed && !slices.Contains(after, teacherID) {
			return fmt.Errorf("Berichtszeitraum %q: wer ihn anlegt, muss selbst eingetragen sein", id)
		}
	}
	return nil
}

func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for _, x := range a {
		if !slices.Contains(b, x) {
			return false
		}
	}
	return true
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
