// Package store speichert Konten, Anmeldungen, Codes, Dokumente und Zusammenführungen in einer SQLite-Datei.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// ErrNotFound: Den gesuchten Eintrag gibt es nicht.
var ErrNotFound = errors.New("nicht gefunden")

// ErrTaken: Benutzername oder Lehrer sind schon vergeben.
var ErrTaken = errors.New("schon vergeben")

// ErrStale: Das Dokument wurde inzwischen von jemand anderem geändert (oder angelegt bzw. gelöscht).
var ErrStale = errors.New("inzwischen geändert")

type Store struct {
	db *sql.DB
}

// Account ist das Konto eines Lehrers; TeacherID verbindet es mit dem Lehrer in den Daten der App.
type Account struct {
	ID           int64
	Username     string
	TeacherID    string
	PasswordHash string
	CreatedAt    time.Time
}

// CodeKind unterscheidet Einladungen (neues Konto) und Codes zum Zurücksetzen des Passworts.
type CodeKind string

const (
	Invite CodeKind = "invite"
	Reset  CodeKind = "reset"
)

type Code struct {
	Kind      CodeKind
	TeacherID string
	ExpiresAt time.Time
}

// DocInfo beschreibt ein Dokument ohne Inhalt; Revision steigt mit jeder Änderung.
type DocInfo struct {
	Name     string
	Revision int64
}

type Merge struct {
	From, Into string
}

const schema = `
CREATE TABLE IF NOT EXISTS accounts (
	id            INTEGER PRIMARY KEY,
	username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
	teacher_id    TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
	token_hash TEXT PRIMARY KEY,
	account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	used_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS codes (
	code_hash  TEXT PRIMARY KEY,
	kind       TEXT NOT NULL,
	teacher_id TEXT NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS docs (
	name       TEXT PRIMARY KEY,
	content    BLOB NOT NULL,
	revision   INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	updated_by INTEGER
);
CREATE TABLE IF NOT EXISTS merges (
	from_id    TEXT PRIMARY KEY,
	into_id    TEXT NOT NULL,
	created_by INTEGER,
	created_at INTEGER NOT NULL
);
`

// Open öffnet die Datenbank und legt fehlende Tabellen an.
func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	// SQLite verträgt nur einen Schreiber gleichzeitig; eine Verbindung vermeidet „database is locked“.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema + feedsSchema + plansSchema); err != nil {
		db.Close()
		return nil, fmt.Errorf("Datenbank %s: %w", path, err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// --- Konten ---

func (s *Store) CreateAccount(ctx context.Context, username, teacherID, passwordHash string) (Account, error) {
	now := time.Now()
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO accounts (username, teacher_id, password_hash, created_at) VALUES (?, ?, ?, ?)`,
		username, teacherID, passwordHash, now.Unix())
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return Account{}, ErrTaken
		}
		return Account{}, err
	}
	id, _ := res.LastInsertId()
	return Account{ID: id, Username: username, TeacherID: teacherID, PasswordHash: passwordHash, CreatedAt: now}, nil
}

func (s *Store) AccountByUsername(ctx context.Context, username string) (Account, error) {
	return s.account(ctx, `username = ?`, username)
}

func (s *Store) AccountByTeacher(ctx context.Context, teacherID string) (Account, error) {
	return s.account(ctx, `teacher_id = ?`, teacherID)
}

func (s *Store) account(ctx context.Context, where string, arg any) (Account, error) {
	var a Account
	var created int64
	err := s.db.QueryRowContext(ctx,
		`SELECT id, username, teacher_id, password_hash, created_at FROM accounts WHERE `+where, arg).
		Scan(&a.ID, &a.Username, &a.TeacherID, &a.PasswordHash, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return Account{}, ErrNotFound
	}
	a.CreatedAt = time.Unix(created, 0)
	return a, err
}

func (s *Store) Accounts(ctx context.Context) ([]Account, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, username, teacher_id, created_at FROM accounts ORDER BY username`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var accounts []Account
	for rows.Next() {
		var a Account
		var created int64
		if err := rows.Scan(&a.ID, &a.Username, &a.TeacherID, &created); err != nil {
			return nil, err
		}
		a.CreatedAt = time.Unix(created, 0)
		accounts = append(accounts, a)
	}
	return accounts, rows.Err()
}

// SetPassword setzt ein neues Passwort und meldet alle Geräte des Kontos ab.
func (s *Store) SetPassword(ctx context.Context, accountID int64, passwordHash string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `UPDATE accounts SET password_hash = ? WHERE id = ?`, passwordHash, accountID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE account_id = ?`, accountID); err != nil {
		return err
	}
	return tx.Commit()
}

// --- Anmeldungen ---

func (s *Store) CreateSession(ctx context.Context, tokenHash string, accountID int64) error {
	now := time.Now().Unix()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO sessions (token_hash, account_id, created_at, used_at) VALUES (?, ?, ?, ?)`,
		tokenHash, accountID, now, now)
	return err
}

// SessionAccount liefert das Konto zu einer Anmeldung und vermerkt die Nutzung. Anmeldungen, die länger als
// maxIdle nicht genutzt wurden, gelten nicht mehr.
func (s *Store) SessionAccount(ctx context.Context, tokenHash string, maxIdle time.Duration) (Account, error) {
	var accountID, usedAt int64
	err := s.db.QueryRowContext(ctx, `SELECT account_id, used_at FROM sessions WHERE token_hash = ?`, tokenHash).
		Scan(&accountID, &usedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Account{}, ErrNotFound
	}
	if err != nil {
		return Account{}, err
	}
	if time.Since(time.Unix(usedAt, 0)) > maxIdle {
		_, _ = s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, tokenHash)
		return Account{}, ErrNotFound
	}
	// Nur gelegentlich schreiben: Die Zeit muss nicht sekundengenau sein.
	if time.Since(time.Unix(usedAt, 0)) > time.Hour {
		_, _ = s.db.ExecContext(ctx, `UPDATE sessions SET used_at = ? WHERE token_hash = ?`, time.Now().Unix(), tokenHash)
	}
	return s.account(ctx, `id = ?`, accountID)
}

func (s *Store) DeleteSession(ctx context.Context, tokenHash string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, tokenHash)
	return err
}

// --- Codes ---

func (s *Store) CreateCode(ctx context.Context, codeHash string, code Code) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO codes (code_hash, kind, teacher_id, expires_at) VALUES (?, ?, ?, ?)`,
		codeHash, string(code.Kind), code.TeacherID, code.ExpiresAt.Unix())
	return err
}

// TakeCode liefert einen gültigen Code und löscht ihn; jeder Code gilt nur einmal.
func (s *Store) TakeCode(ctx context.Context, codeHash string, kind CodeKind) (Code, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Code{}, err
	}
	defer tx.Rollback()
	var c Code
	var k string
	var expires int64
	err = tx.QueryRowContext(ctx, `SELECT kind, teacher_id, expires_at FROM codes WHERE code_hash = ?`, codeHash).
		Scan(&k, &c.TeacherID, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return Code{}, ErrNotFound
	}
	if err != nil {
		return Code{}, err
	}
	c.Kind, c.ExpiresAt = CodeKind(k), time.Unix(expires, 0)
	if c.Kind != kind || time.Now().After(c.ExpiresAt) {
		return Code{}, ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM codes WHERE code_hash = ?`, codeHash); err != nil {
		return Code{}, err
	}
	return c, tx.Commit()
}

// PutCodeBack stellt einen genommenen Code wieder her, z. B. wenn der gewünschte Benutzername vergeben war.
func (s *Store) PutCodeBack(ctx context.Context, codeHash string, code Code) error {
	return s.CreateCode(ctx, codeHash, code)
}

// DeleteExpiredCodes räumt abgelaufene Codes und lange ungenutzte Anmeldungen auf.
func (s *Store) DeleteExpired(ctx context.Context, maxIdle time.Duration) error {
	now := time.Now()
	if _, err := s.db.ExecContext(ctx, `DELETE FROM codes WHERE expires_at < ?`, now.Unix()); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE used_at < ?`, now.Add(-maxIdle).Unix())
	return err
}

// --- Dokumente ---

func (s *Store) Docs(ctx context.Context) ([]DocInfo, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT name, revision FROM docs ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var docs []DocInfo
	for rows.Next() {
		var d DocInfo
		if err := rows.Scan(&d.Name, &d.Revision); err != nil {
			return nil, err
		}
		docs = append(docs, d)
	}
	return docs, rows.Err()
}

func (s *Store) Doc(ctx context.Context, name string) ([]byte, int64, error) {
	var content []byte
	var revision int64
	err := s.db.QueryRowContext(ctx, `SELECT content, revision FROM docs WHERE name = ?`, name).Scan(&content, &revision)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, 0, ErrNotFound
	}
	return content, revision, err
}

// PutDoc speichert ein Dokument und liefert seine neue Revision.
func (s *Store) PutDoc(ctx context.Context, name string, content []byte, accountID int64) (int64, error) {
	var revision int64
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO docs (name, content, revision, updated_at, updated_by) VALUES (?, ?, 1, ?, ?)
		ON CONFLICT(name) DO UPDATE SET content = excluded.content, revision = docs.revision + 1,
			updated_at = excluded.updated_at, updated_by = excluded.updated_by
		RETURNING revision`,
		name, content, time.Now().Unix(), accountID).Scan(&revision)
	return revision, err
}

// PutDocIf speichert ein Dokument nur, wenn es noch die Revision `expected` hat; 0 heißt: Es darf noch nicht
// existieren. So überschreibt niemand unbemerkt, was ein anderes Gerät seit dem eigenen Lesen geschrieben hat.
func (s *Store) PutDocIf(ctx context.Context, name string, content []byte, accountID, expected int64) (int64, error) {
	var revision int64
	var err error
	now := time.Now().Unix()
	if expected == 0 {
		err = s.db.QueryRowContext(ctx, `
			INSERT INTO docs (name, content, revision, updated_at, updated_by) VALUES (?, ?, 1, ?, ?)
			ON CONFLICT(name) DO NOTHING
			RETURNING revision`,
			name, content, now, accountID).Scan(&revision)
	} else {
		err = s.db.QueryRowContext(ctx, `
			UPDATE docs SET content = ?, revision = revision + 1, updated_at = ?, updated_by = ?
			WHERE name = ? AND revision = ?
			RETURNING revision`,
			content, now, accountID, name, expected).Scan(&revision)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrStale
	}
	return revision, err
}

func (s *Store) DeleteDoc(ctx context.Context, name string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM docs WHERE name = ?`, name)
	return err
}

// --- Zusammenführungen ---

func (s *Store) Merges(ctx context.Context) ([]Merge, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT from_id, into_id FROM merges ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var merges []Merge
	for rows.Next() {
		var m Merge
		if err := rows.Scan(&m.From, &m.Into); err != nil {
			return nil, err
		}
		merges = append(merges, m)
	}
	return merges, rows.Err()
}

// AddMerge vermerkt, dass `from` in `into` aufgegangen ist. Frühere Zusammenführungen in `from` zeigen danach
// ebenfalls auf `into`, damit keine Ketten entstehen.
func (s *Store) AddMerge(ctx context.Context, m Merge, accountID int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `UPDATE merges SET into_id = ? WHERE into_id = ?`, m.Into, m.From); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO merges (from_id, into_id, created_by, created_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(from_id) DO UPDATE SET into_id = excluded.into_id`,
		m.From, m.Into, accountID, time.Now().Unix()); err != nil {
		return err
	}
	return tx.Commit()
}
