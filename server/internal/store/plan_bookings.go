package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Arten einer Eintragung auf der Download-Seite. Eine Person trägt sich selbst für einen freien Termin ein (`book`)
// oder trägt einen eigenen wieder aus (`cancel`). Der Server vergibt die Zeiten; die App einer Lehrkraft des
// Zeitraums übernimmt offene Eintragungen beim nächsten Abgleich in die Daten und meldet `applied` oder `failed`.
// Die Zustände sind die der Anfragen (RequestOpen, RequestApplied, RequestFailed, RequestWithdrawn).
const (
	BookingNew    = "book"
	BookingCancel = "cancel"
)

// PlanBooking ist eine Eintragung von Person bei Teacher am Date um Time (JJJJ-MM-TT, HH:MM). Slot ist beim
// Austragen der Termin in der App; beim Eintragen leer.
type PlanBooking struct {
	ID        string
	PeriodID  string
	Person    string
	Kind      string
	Teacher   string
	Date      string
	Time      string
	Minutes   int
	Slot      string
	Status    string
	Note      string
	CreatedAt time.Time
	UpdatedAt time.Time
}

const planBookingsSchema = `
CREATE TABLE IF NOT EXISTS plan_bookings (
	id         TEXT PRIMARY KEY,
	period_id  TEXT NOT NULL,
	person     TEXT NOT NULL,
	kind       TEXT NOT NULL,
	teacher    TEXT NOT NULL,
	date       TEXT NOT NULL,
	time       TEXT NOT NULL,
	minutes    INTEGER NOT NULL,
	slot       TEXT NOT NULL DEFAULT '',
	status     TEXT NOT NULL,
	note       TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plan_bookings_period ON plan_bookings (period_id, status);
`

// PlanBookings liefert alle Eintragungen eines Zeitraums, die neuesten zuerst.
func (s *Store) PlanBookings(ctx context.Context, periodID string) ([]PlanBooking, error) {
	return planBookings(ctx, s.db, periodID)
}

type querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

func planBookings(ctx context.Context, db querier, periodID string) ([]PlanBooking, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT id, period_id, person, kind, teacher, date, time, minutes, slot, status, note, created_at, updated_at
		FROM plan_bookings WHERE period_id = ? ORDER BY created_at DESC, rowid DESC`, periodID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []PlanBooking
	for rows.Next() {
		var b PlanBooking
		var created, updated int64
		if err := rows.Scan(&b.ID, &b.PeriodID, &b.Person, &b.Kind, &b.Teacher, &b.Date, &b.Time, &b.Minutes, &b.Slot,
			&b.Status, &b.Note, &created, &updated); err != nil {
			return nil, err
		}
		b.CreatedAt, b.UpdatedAt = time.Unix(created, 0), time.Unix(updated, 0)
		list = append(list, b)
	}
	return list, rows.Err()
}

// AddPlanBooking legt eine Eintragung an, wenn `check` sie gegen alle bisherigen Eintragungen des Zeitraums erlaubt.
// Prüfen und Anlegen geschehen in einer Transaktion: Zwei Personen bekommen nie dieselbe Zeit.
func (s *Store) AddPlanBooking(ctx context.Context, b PlanBooking, check func(existing []PlanBooking) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	existing, err := planBookings(ctx, tx, b.PeriodID)
	if err != nil {
		return err
	}
	if err := check(existing); err != nil {
		return err
	}
	now := time.Now().Unix()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO plan_bookings (id, period_id, person, kind, teacher, date, time, minutes, slot, status, note,
			created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
		b.ID, b.PeriodID, b.Person, b.Kind, b.Teacher, b.Date, b.Time, b.Minutes, b.Slot, RequestOpen, now, now); err != nil {
		return err
	}
	return tx.Commit()
}

// SetPlanBookingStatus ändert den Zustand nur, wenn die Eintragung im Zeitraum liegt und noch `from` ist; sonst
// ErrStale bzw. ErrNotFound.
func (s *Store) SetPlanBookingStatus(ctx context.Context, periodID, id, from, to, note string) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE plan_bookings SET status = ?, note = ?, updated_at = ? WHERE id = ? AND period_id = ? AND status = ?`,
		to, note, time.Now().Unix(), id, periodID, from)
	if err != nil {
		return err
	}
	if n, err := result.RowsAffected(); err != nil || n > 0 {
		return err
	}
	var exists int
	err = s.db.QueryRowContext(ctx, `SELECT 1 FROM plan_bookings WHERE id = ? AND period_id = ?`, id, periodID).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return errors.Join(ErrStale, err)
}

func (s *Store) deletePlanBookings(ctx context.Context, periodID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM plan_bookings WHERE period_id = ?`, periodID)
	return err
}
