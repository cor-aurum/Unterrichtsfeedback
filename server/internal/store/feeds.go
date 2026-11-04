package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Feed ist das Kalender-Abo eines Kontos. Den Inhalt (iCalendar) erzeugt die App; der Server liefert ihn nur aus.
// Token ist der geheime Teil der Abo-Adresse; leer, solange kein Abo eingerichtet ist.
type Feed struct {
	Token     string
	UpdatedAt time.Time
}

const feedsSchema = `
CREATE TABLE IF NOT EXISTS feeds (
	account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
	-- Im Klartext, damit jedes Gerät des Lehrers die Adresse wieder anzeigen kann. Wer die Datenbank liest, kennt die
	-- Termine ohnehin.
	token      TEXT UNIQUE,
	content    BLOB NOT NULL DEFAULT '',
	updated_at INTEGER NOT NULL DEFAULT 0
);
`

// Feed liefert das Abo des Kontos; ErrNotFound, wenn es noch keins gibt.
func (s *Store) Feed(ctx context.Context, accountID int64) (Feed, error) {
	var token sql.NullString
	var updated int64
	err := s.db.QueryRowContext(ctx, `SELECT token, updated_at FROM feeds WHERE account_id = ?`, accountID).
		Scan(&token, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return Feed{}, ErrNotFound
	}
	return Feed{Token: token.String, UpdatedAt: unixOrZero(updated)}, err
}

// PutFeedContent speichert den Kalender des Kontos, mit oder ohne Abo-Adresse.
func (s *Store) PutFeedContent(ctx context.Context, accountID int64, content []byte) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO feeds (account_id, content, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(account_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
		accountID, content, time.Now().Unix())
	return err
}

// SetFeedToken setzt eine neue Abo-Adresse; die alte gilt damit nicht mehr. Leer beendet das Abo.
func (s *Store) SetFeedToken(ctx context.Context, accountID int64, token string) error {
	value := sql.NullString{String: token, Valid: token != ""}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO feeds (account_id, token) VALUES (?, ?)
		ON CONFLICT(account_id) DO UPDATE SET token = excluded.token`,
		accountID, value)
	return err
}

// FeedByToken liefert den Kalender zu einer Abo-Adresse; ErrNotFound bei unbekannter oder beendeter.
func (s *Store) FeedByToken(ctx context.Context, token string) ([]byte, time.Time, error) {
	var content []byte
	var updated int64
	err := s.db.QueryRowContext(ctx, `SELECT content, updated_at FROM feeds WHERE token = ?`, token).
		Scan(&content, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, time.Time{}, ErrNotFound
	}
	return content, unixOrZero(updated), err
}

func unixOrZero(seconds int64) time.Time {
	if seconds == 0 {
		return time.Time{}
	}
	return time.Unix(seconds, 0)
}
