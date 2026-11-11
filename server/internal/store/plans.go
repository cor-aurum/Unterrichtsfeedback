package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// PlanLink ist der Download-Link eines Berichtszeitraums, unter dem sich jede Person ihren Plan holt. Die Pläne
// (Namen, Termine, PDFs, Kalender) erzeugt die App; der Server liefert sie nur aus.
type PlanLink struct {
	PeriodID  string
	Token     string
	Content   []byte
	UpdatedAt time.Time
}

const plansSchema = `
CREATE TABLE IF NOT EXISTS plans (
	period_id  TEXT PRIMARY KEY,
	-- Im Klartext, damit alle Lehrer des Zeitraums den Link wieder anzeigen können.
	token      TEXT NOT NULL UNIQUE,
	content    BLOB NOT NULL DEFAULT '',
	updated_at INTEGER NOT NULL DEFAULT 0
);
`

// Plan liefert den Link des Zeitraums ohne Inhalt; ErrNotFound, wenn es keinen gibt.
func (s *Store) Plan(ctx context.Context, periodID string) (PlanLink, error) {
	var updated int64
	link := PlanLink{PeriodID: periodID}
	err := s.db.QueryRowContext(ctx, `SELECT token, updated_at FROM plans WHERE period_id = ?`, periodID).
		Scan(&link.Token, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return PlanLink{}, ErrNotFound
	}
	link.UpdatedAt = unixOrZero(updated)
	return link, err
}

// SetPlanToken richtet den Link ein oder ersetzt ihn; der alte gilt damit nicht mehr, die Pläne bleiben.
func (s *Store) SetPlanToken(ctx context.Context, periodID, token string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO plans (period_id, token) VALUES (?, ?)
		ON CONFLICT(period_id) DO UPDATE SET token = excluded.token`,
		periodID, token)
	return err
}

// DeletePlan löscht Link, Pläne, Anfragen und Eintragungen des Zeitraums.
func (s *Store) DeletePlan(ctx context.Context, periodID string) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM plans WHERE period_id = ?`, periodID); err != nil {
		return err
	}
	if err := s.deletePlanRequests(ctx, periodID); err != nil {
		return err
	}
	return s.deletePlanBookings(ctx, periodID)
}

// PutPlanContent speichert die Pläne; ErrNotFound, wenn es für den Zeitraum keinen Link gibt. Der Stand wird mit
// jeder Fassung größer, auch bei mehreren in derselben Sekunde: Der Server erkennt daran, ob seine zwischengespeicherte
// Fassung noch gilt.
func (s *Store) PutPlanContent(ctx context.Context, periodID string, content []byte) error {
	result, err := s.db.ExecContext(ctx, `UPDATE plans SET content = ?, updated_at = MAX(?, updated_at + 1) WHERE period_id = ?`,
		content, time.Now().Unix(), periodID)
	if err != nil {
		return err
	}
	if n, err := result.RowsAffected(); err != nil || n == 0 {
		return errors.Join(ErrNotFound, err)
	}
	return nil
}

// PlanStampByToken liefert Zeitraum und Stand zu einem Token, ohne die Pläne zu lesen; ErrNotFound bei unbekanntem
// oder ersetztem.
func (s *Store) PlanStampByToken(ctx context.Context, token string) (PlanLink, error) {
	var updated int64
	link := PlanLink{Token: token}
	err := s.db.QueryRowContext(ctx, `SELECT period_id, updated_at FROM plans WHERE token = ?`, token).
		Scan(&link.PeriodID, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return PlanLink{}, ErrNotFound
	}
	link.UpdatedAt = unixOrZero(updated)
	return link, err
}

// PlanByToken liefert Link und Pläne zu einem Token; ErrNotFound bei unbekanntem oder ersetztem.
func (s *Store) PlanByToken(ctx context.Context, token string) (PlanLink, error) {
	var updated int64
	link := PlanLink{Token: token}
	err := s.db.QueryRowContext(ctx, `SELECT period_id, content, updated_at FROM plans WHERE token = ?`, token).
		Scan(&link.PeriodID, &link.Content, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return PlanLink{}, ErrNotFound
	}
	link.UpdatedAt = unixOrZero(updated)
	return link, err
}
