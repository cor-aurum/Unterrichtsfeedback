package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// BoardLink ist der Aushang-Link eines Berichtszeitraums: eine Seite mit allen Terminen des Zeitraums für ein
// zentrales Tablet. Die Termine erzeugt die App; der Server zeigt sie nur an.
type BoardLink struct {
	PeriodID  string
	Token     string
	Content   []byte
	UpdatedAt time.Time
}

const boardsSchema = `
CREATE TABLE IF NOT EXISTS boards (
	period_id  TEXT PRIMARY KEY,
	-- Im Klartext, damit alle Lehrer des Zeitraums den Link wieder anzeigen können.
	token      TEXT NOT NULL UNIQUE,
	content    BLOB NOT NULL DEFAULT '',
	updated_at INTEGER NOT NULL DEFAULT 0
);
`

// Board liefert den Aushang-Link des Zeitraums ohne Inhalt; ErrNotFound, wenn es keinen gibt.
func (s *Store) Board(ctx context.Context, periodID string) (BoardLink, error) {
	var updated int64
	link := BoardLink{PeriodID: periodID}
	err := s.db.QueryRowContext(ctx, `SELECT token, updated_at FROM boards WHERE period_id = ?`, periodID).
		Scan(&link.Token, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return BoardLink{}, ErrNotFound
	}
	link.UpdatedAt = unixOrZero(updated)
	return link, err
}

// SetBoardToken richtet den Aushang-Link ein oder ersetzt ihn; der alte gilt damit nicht mehr, die Termine bleiben.
func (s *Store) SetBoardToken(ctx context.Context, periodID, token string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO boards (period_id, token) VALUES (?, ?)
		ON CONFLICT(period_id) DO UPDATE SET token = excluded.token`,
		periodID, token)
	return err
}

// DeleteBoard löscht Aushang-Link und Termine des Zeitraums.
func (s *Store) DeleteBoard(ctx context.Context, periodID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM boards WHERE period_id = ?`, periodID)
	return err
}

// PutBoardContent speichert die Termine; ErrNotFound, wenn es für den Zeitraum keinen Aushang-Link gibt.
func (s *Store) PutBoardContent(ctx context.Context, periodID string, content []byte) error {
	result, err := s.db.ExecContext(ctx, `UPDATE boards SET content = ?, updated_at = MAX(?, updated_at + 1) WHERE period_id = ?`,
		content, time.Now().Unix(), periodID)
	if err != nil {
		return err
	}
	if n, err := result.RowsAffected(); err != nil || n == 0 {
		return errors.Join(ErrNotFound, err)
	}
	return nil
}

// BoardByToken liefert Link und Termine zu einem Token; ErrNotFound bei unbekanntem oder ersetztem.
func (s *Store) BoardByToken(ctx context.Context, token string) (BoardLink, error) {
	var updated int64
	link := BoardLink{Token: token}
	err := s.db.QueryRowContext(ctx, `SELECT period_id, content, updated_at FROM boards WHERE token = ?`, token).
		Scan(&link.PeriodID, &link.Content, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return BoardLink{}, ErrNotFound
	}
	link.UpdatedAt = unixOrZero(updated)
	return link, err
}
