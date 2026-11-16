package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// PlanGroupChoice: Eine Person hat auf ihrer Seite des Download-Links eine Gruppe gewählt. Eine neue Wahl ersetzt
// eine noch offene ältere (`withdrawn`). Die App einer Lehrkraft des Zeitraums übernimmt offene Wahlen beim nächsten
// Abgleich und meldet `applied` oder `failed`. Die Zustände sind die der Anfragen.
type PlanGroupChoice struct {
	ID        string
	PeriodID  string
	Person    string
	Group     string
	Status    string
	Note      string
	CreatedAt time.Time
	UpdatedAt time.Time
}

const planGroupChoicesSchema = `
CREATE TABLE IF NOT EXISTS plan_group_choices (
	id         TEXT PRIMARY KEY,
	period_id  TEXT NOT NULL,
	person     TEXT NOT NULL,
	group_id   TEXT NOT NULL,
	status     TEXT NOT NULL,
	note       TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plan_group_choices_period ON plan_group_choices (period_id, status);
`

// PlanGroupChoices liefert alle Wahlen eines Zeitraums, die neuesten zuerst.
func (s *Store) PlanGroupChoices(ctx context.Context, periodID string) ([]PlanGroupChoice, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, period_id, person, group_id, status, note, created_at, updated_at
		FROM plan_group_choices WHERE period_id = ? ORDER BY created_at DESC, rowid DESC`, periodID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []PlanGroupChoice
	for rows.Next() {
		var c PlanGroupChoice
		var created, updated int64
		if err := rows.Scan(&c.ID, &c.PeriodID, &c.Person, &c.Group, &c.Status, &c.Note, &created, &updated); err != nil {
			return nil, err
		}
		c.CreatedAt, c.UpdatedAt = time.Unix(created, 0), time.Unix(updated, 0)
		list = append(list, c)
	}
	return list, rows.Err()
}

// AddPlanGroupChoice legt eine Wahl an; noch offene ältere Wahlen der Person gelten danach nicht mehr. ErrLimit,
// wenn der Zeitraum schon `limit` Wahlen hat.
func (s *Store) AddPlanGroupChoice(ctx context.Context, c PlanGroupChoice, limit int) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM plan_group_choices WHERE period_id = ?`, c.PeriodID).Scan(&count); err != nil {
		return err
	}
	if count >= limit {
		return ErrLimit
	}
	now := time.Now().Unix()
	if _, err := tx.ExecContext(ctx, `
		UPDATE plan_group_choices SET status = ?, updated_at = ? WHERE period_id = ? AND person = ? AND status = ?`,
		RequestWithdrawn, now, c.PeriodID, c.Person, RequestOpen); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO plan_group_choices (id, period_id, person, group_id, status, note, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, '', ?, ?)`, c.ID, c.PeriodID, c.Person, c.Group, RequestOpen, now, now); err != nil {
		return err
	}
	return tx.Commit()
}

// ErrLimit: Für den Zeitraum gibt es schon zu viele Einträge.
var ErrLimit = errors.New("zu viele Einträge")

// SetPlanGroupChoiceStatus ändert den Zustand nur, wenn die Wahl im Zeitraum liegt und noch `from` ist; sonst
// ErrStale bzw. ErrNotFound.
func (s *Store) SetPlanGroupChoiceStatus(ctx context.Context, periodID, id, from, to, note string) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE plan_group_choices SET status = ?, note = ?, updated_at = ? WHERE id = ? AND period_id = ? AND status = ?`,
		to, note, time.Now().Unix(), id, periodID, from)
	if err != nil {
		return err
	}
	if n, err := result.RowsAffected(); err != nil || n > 0 {
		return err
	}
	var exists int
	err = s.db.QueryRowContext(ctx, `SELECT 1 FROM plan_group_choices WHERE id = ? AND period_id = ?`, id, periodID).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return errors.Join(ErrStale, err)
}

func (s *Store) deletePlanGroupChoices(ctx context.Context, periodID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM plan_group_choices WHERE period_id = ?`, periodID)
	return err
}
