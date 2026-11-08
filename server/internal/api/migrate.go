package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"slices"

	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/access"
	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/store"
)

// Wer die Daten migriert: kein Konto, sondern der Server selbst
const migrationAccount = 0

type object = map[string]any

// Migrate bringt ältere Daten in die heutige Form: Früher standen die Berichtszeiträume in der für alle lesbaren
// Konfiguration, Unterrichtszeiten und Orte je Zeitraum in den Lehrerdokumenten und alle allgemeinen Termine in
// einem gemeinsamen Dokument. Jetzt bekommt jeder Zeitraum ein eigenes Dokument, das nur seine Lehrer lesen
// (`berichtszeitraum_<ID>.json`). Ohne Berichtszeiträume in der Konfiguration ist nichts zu tun.
func (s *Server) Migrate(ctx context.Context) error {
	configContent, _, err := s.store.Doc(ctx, access.ConfigName)
	if errors.Is(err, store.ErrNotFound) || (err == nil && !access.HasPeriods(configContent)) {
		return nil
	}
	if err != nil {
		return err
	}
	var config object
	if err := json.Unmarshal(configContent, &config); err != nil {
		return fmt.Errorf("Konfiguration: %w", err)
	}
	inner, _ := config["config"].(object)
	periods := objects(inner["reportPeriods"])

	reports := make(map[string]object, len(periods))
	for _, period := range periods {
		id, _ := period["id"].(string)
		if id == "" {
			return errors.New("ein Berichtszeitraum hat keine ID")
		}
		reports[id] = object{
			"format":             "unterricht-feedback/berichtszeitraum",
			"version":            1,
			"period":             period,
			"teachers":           object{},
			"sharedAppointments": []any{},
		}
	}

	teacherDocs, err := s.moveTeacherPeriodData(ctx, reports)
	if err != nil {
		return err
	}
	sharedDoc, err := s.moveSharedAppointments(ctx, periods, reports)
	if err != nil {
		return err
	}

	// Erst die neuen Dokumente, dann die alten ohne die verschobenen Teile
	for id, report := range reports {
		if err := s.putJSON(ctx, access.PeriodDocName(id), report); err != nil {
			return err
		}
	}
	for name, doc := range teacherDocs {
		if err := s.putJSON(ctx, name, doc); err != nil {
			return err
		}
	}
	if sharedDoc != nil {
		if err := s.putJSON(ctx, access.SharedName, sharedDoc); err != nil {
			return err
		}
	}
	delete(inner, "reportPeriods")
	if err := s.putJSON(ctx, access.ConfigName, config); err != nil {
		return err
	}
	log.Printf("Berichtszeiträume in eigene Dokumente verschoben: %d", len(reports))
	return nil
}

// moveTeacherPeriodData verschiebt Unterrichtszeiten und Orte je Zeitraum aus den Lehrerdokumenten in die Dokumente
// der Zeiträume und liefert die geänderten Lehrerdokumente.
func (s *Server) moveTeacherPeriodData(ctx context.Context, reports map[string]object) (map[string]object, error) {
	docs, err := s.store.Docs(ctx)
	if err != nil {
		return nil, err
	}
	changed := map[string]object{}
	for _, d := range docs {
		doc, err := access.Parse(d.Name)
		if err != nil || doc.Kind != access.Teacher {
			continue
		}
		content, _, err := s.store.Doc(ctx, d.Name)
		if err != nil {
			return nil, err
		}
		var file object
		if err := json.Unmarshal(content, &file); err != nil {
			return nil, fmt.Errorf("%s: %w", d.Name, err)
		}
		teacher, _ := file["teacher"].(object)
		if teacher == nil {
			continue
		}
		windows, _ := teacher["periodWindows"].(object)
		locations, _ := teacher["periodLocations"].(object)
		if len(windows) == 0 && len(locations) == 0 {
			continue
		}
		for periodID, report := range reports {
			entry := object{}
			if w, ok := windows[periodID]; ok {
				entry["windows"] = w
			}
			if l, ok := locations[periodID]; ok {
				entry["location"] = l
			}
			if len(entry) > 0 {
				report["teachers"].(object)[doc.TeacherID] = entry
			}
		}
		delete(teacher, "periodWindows")
		delete(teacher, "periodLocations")
		changed[d.Name] = file
	}
	return changed, nil
}

// moveSharedAppointments verschiebt allgemeine Termine in den Zeitraum, in dem ihr (erster) Tag liegt; bei mehreren
// in den, dessen Lehrer beteiligt sind. Termine außerhalb aller Zeiträume bleiben im gemeinsamen Dokument.
func (s *Server) moveSharedAppointments(ctx context.Context, periods []object, reports map[string]object) (object, error) {
	content, _, err := s.store.Doc(ctx, access.SharedName)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var file object
	if err := json.Unmarshal(content, &file); err != nil {
		return nil, fmt.Errorf("%s: %w", access.SharedName, err)
	}
	var rest []any
	for _, appointment := range objects(file["appointments"]) {
		periodID := sharedPeriod(appointment, periods)
		if periodID == "" {
			rest = append(rest, appointment)
			continue
		}
		report := reports[periodID]
		report["sharedAppointments"] = append(report["sharedAppointments"].([]any), appointment)
	}
	if rest == nil {
		rest = []any{}
	}
	file["appointments"] = rest
	return file, nil
}

func sharedPeriod(appointment object, periods []object) string {
	date, _ := appointment["date"].(string)
	teacherIDs := stringList(appointment["teacherIds"])
	found := ""
	for _, period := range periods {
		from, _ := period["from"].(string)
		to, _ := period["to"].(string)
		if date < from || date > to {
			continue
		}
		id, _ := period["id"].(string)
		if found == "" {
			found = id
		}
		if slices.ContainsFunc(stringList(period["teacherIds"]), func(t string) bool { return slices.Contains(teacherIDs, t) }) {
			return id
		}
	}
	return found
}

func (s *Server) putJSON(ctx context.Context, name string, value any) error {
	content, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	_, err = s.store.PutDoc(ctx, name, content, migrationAccount)
	return err
}

func objects(value any) []object {
	list, _ := value.([]any)
	result := make([]object, 0, len(list))
	for _, item := range list {
		if o, ok := item.(object); ok {
			result = append(result, o)
		}
	}
	return result
}

func stringList(value any) []string {
	list, _ := value.([]any)
	result := make([]string, 0, len(list))
	for _, item := range list {
		if s, ok := item.(string); ok {
			result = append(result, s)
		}
	}
	return result
}
