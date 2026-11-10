package store

import (
	"context"
	"database/sql"
	"errors"
	"slices"
	"time"
)

// Arten und Zustände einer Anfrage auf der Download-Seite. Angenommene Anfragen übernimmt die App einer Lehrkraft
// des Zeitraums beim nächsten Abgleich in die Daten und meldet `applied` oder `failed`.
const (
	RequestSwap = "swap" // zwei Personen tauschen ihre Termine
	RequestJoin = "join" // eine Person kommt zum Unterricht einer anderen dazu

	RequestOpen      = "open"
	RequestAccepted  = "accepted"
	RequestDeclined  = "declined"
	RequestWithdrawn = "withdrawn"
	RequestApplied   = "applied"
	RequestFailed    = "failed"
)

// PlanRequest ist eine Anfrage von FromPerson an ToPerson. ToSlot ist der Termin von ToPerson; FromSlot beim Tausch
// der eigene Termin, beim Dazukommen leer. Die Texte der Termine werden beim Anfragen festgehalten, damit die Seite
// sie auch nach dem Tausch noch zeigen kann.
type PlanRequest struct {
	ID         string
	PeriodID   string
	Kind       string
	FromPerson string
	ToPerson   string
	FromSlot   string
	ToSlot     string
	FromLabel  string
	ToLabel    string
	Status     string
	Note       string
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

const planRequestsSchema = `
CREATE TABLE IF NOT EXISTS plan_requests (
	id          TEXT PRIMARY KEY,
	period_id   TEXT NOT NULL,
	kind        TEXT NOT NULL,
	from_person TEXT NOT NULL,
	to_person   TEXT NOT NULL,
	from_slot   TEXT NOT NULL DEFAULT '',
	to_slot     TEXT NOT NULL,
	from_label  TEXT NOT NULL DEFAULT '',
	to_label    TEXT NOT NULL DEFAULT '',
	status      TEXT NOT NULL,
	note        TEXT NOT NULL DEFAULT '',
	created_at  INTEGER NOT NULL,
	updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plan_requests_period ON plan_requests (period_id, status);
`

func (s *Store) AddPlanRequest(ctx context.Context, r PlanRequest) error {
	now := time.Now().Unix()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO plan_requests (id, period_id, kind, from_person, to_person, from_slot, to_slot, from_label, to_label,
			status, note, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
		r.ID, r.PeriodID, r.Kind, r.FromPerson, r.ToPerson, r.FromSlot, r.ToSlot, r.FromLabel, r.ToLabel, RequestOpen, now, now)
	return err
}

// PlanRequests liefert die Anfragen eines Zeitraums, die neuesten zuerst; ohne Zustände alle.
func (s *Store) PlanRequests(ctx context.Context, periodID string, statuses ...string) ([]PlanRequest, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, period_id, kind, from_person, to_person, from_slot, to_slot, from_label, to_label, status, note,
			created_at, updated_at
		FROM plan_requests WHERE period_id = ? ORDER BY created_at DESC, id`, periodID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []PlanRequest
	for rows.Next() {
		var r PlanRequest
		var created, updated int64
		if err := rows.Scan(&r.ID, &r.PeriodID, &r.Kind, &r.FromPerson, &r.ToPerson, &r.FromSlot, &r.ToSlot,
			&r.FromLabel, &r.ToLabel, &r.Status, &r.Note, &created, &updated); err != nil {
			return nil, err
		}
		r.CreatedAt, r.UpdatedAt = time.Unix(created, 0), time.Unix(updated, 0)
		if len(statuses) == 0 || slices.Contains(statuses, r.Status) {
			list = append(list, r)
		}
	}
	return list, rows.Err()
}

// SetPlanRequestStatus ändert den Zustand nur, wenn die Anfrage im Zeitraum liegt und noch `from` ist; sonst
// ErrStale (z. B. schon beantwortet) bzw. ErrNotFound.
func (s *Store) SetPlanRequestStatus(ctx context.Context, periodID, id, from, to, note string) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE plan_requests SET status = ?, note = ?, updated_at = ? WHERE id = ? AND period_id = ? AND status = ?`,
		to, note, time.Now().Unix(), id, periodID, from)
	if err != nil {
		return err
	}
	if n, err := result.RowsAffected(); err != nil || n > 0 {
		return err
	}
	var exists int
	err = s.db.QueryRowContext(ctx, `SELECT 1 FROM plan_requests WHERE id = ? AND period_id = ?`, id, periodID).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return errors.Join(ErrStale, err)
}

// AcceptPlanRequest nimmt eine offene Anfrage an. Andere offene Anfragen, die damit nicht mehr gehen, werden
// abgelehnt: beim Tausch alle zu den beiden Terminen, beim Dazukommen die Tauschanfragen zum Termin (weitere
// Personen dürfen dazukommen).
func (s *Store) AcceptPlanRequest(ctx context.Context, r PlanRequest, note string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := time.Now().Unix()
	result, err := tx.ExecContext(ctx, `
		UPDATE plan_requests SET status = ?, updated_at = ? WHERE id = ? AND period_id = ? AND status = ?`,
		RequestAccepted, now, r.ID, r.PeriodID, RequestOpen)
	if err != nil {
		return err
	}
	if n, err := result.RowsAffected(); err != nil || n == 0 {
		return errors.Join(ErrStale, err)
	}
	slots := []string{r.ToSlot}
	if r.FromSlot != "" {
		slots = append(slots, r.FromSlot)
	}
	for _, slot := range slots {
		query := `UPDATE plan_requests SET status = ?, note = ?, updated_at = ?
			WHERE period_id = ? AND status = ? AND id <> ? AND (to_slot = ? OR from_slot = ?)`
		if r.Kind == RequestJoin {
			query += ` AND kind = '` + RequestSwap + `'`
		}
		if _, err := tx.ExecContext(ctx, query, RequestDeclined, note, now, r.PeriodID, RequestOpen, r.ID, slot, slot); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) deletePlanRequests(ctx context.Context, periodID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM plan_requests WHERE period_id = ?`, periodID)
	return err
}
