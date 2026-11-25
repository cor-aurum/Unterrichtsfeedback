package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// SharedFile ist eine Datei (z. B. ein Feedback-PDF), die eine Lehrkraft anderen bereitstellt, damit diese sie drucken
// oder versenden. Der Inhalt liegt einmal vor, jede Empfängerin hat einen eigenen Eintrag mit „geöffnet“.
type SharedFile struct {
	ID        string
	Sender    string
	Name      string
	Size      int64
	PeriodID  string
	CreatedAt time.Time
}

// SharedRecipient ist eine Empfängerin einer Datei; OpenedAt ist null, solange sie die Datei nicht geöffnet hat,
// DoneAt, solange sie sie nicht als erledigt aus ihrer Liste genommen hat.
type SharedRecipient struct {
	TeacherID string
	OpenedAt  time.Time
	DoneAt    time.Time
}

const sharedFilesSchema = `
CREATE TABLE IF NOT EXISTS shared_files (
	id         TEXT PRIMARY KEY,
	sender     TEXT NOT NULL,
	name       TEXT NOT NULL,
	content    BLOB NOT NULL,
	size       INTEGER NOT NULL,
	-- Bereitgestellt für alle Lehrkräfte dieses Zeitraums; leer bei einzeln gewählten
	period_id  TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shared_file_recipients (
	file_id    TEXT NOT NULL REFERENCES shared_files(id) ON DELETE CASCADE,
	teacher_id TEXT NOT NULL,
	opened_at  INTEGER NOT NULL DEFAULT 0,
	-- Erledigt: Die Empfängerin sieht die Datei nicht mehr, die Absenderin weiter (mit „geöffnet“).
	done_at    INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (file_id, teacher_id)
);
CREATE INDEX IF NOT EXISTS shared_file_recipients_teacher ON shared_file_recipients(teacher_id);
`

// AddSharedFile legt die Datei mit ihren Empfängerinnen an.
func (s *Store) AddSharedFile(ctx context.Context, file SharedFile, content []byte, recipients []string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO shared_files (id, sender, name, content, size, period_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		file.ID, file.Sender, file.Name, content, len(content), file.PeriodID, file.CreatedAt.Unix()); err != nil {
		return err
	}
	for _, teacherID := range recipients {
		if _, err := tx.ExecContext(ctx, `INSERT INTO shared_file_recipients (file_id, teacher_id) VALUES (?, ?)`, file.ID, teacherID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// PurgeSharedFiles löscht Dateien, die vor `before` bereitgestellt wurden.
func (s *Store) PurgeSharedFiles(ctx context.Context, before time.Time) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM shared_files WHERE created_at < ?`, before.Unix())
	return err
}

// CountSentFiles zählt die noch liegenden Dateien einer Lehrkraft.
func (s *Store) CountSentFiles(ctx context.Context, sender string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM shared_files WHERE sender = ?`, sender).Scan(&n)
	return n, err
}

// ReceivedFiles liefert die Dateien, die für die Lehrkraft bereitliegen, die neuesten zuerst, mit ihrem „geöffnet“.
func (s *Store) ReceivedFiles(ctx context.Context, teacherID string) ([]SharedFile, []time.Time, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT f.id, f.sender, f.name, f.size, f.period_id, f.created_at, r.opened_at
		FROM shared_files f JOIN shared_file_recipients r ON r.file_id = f.id
		WHERE r.teacher_id = ? AND r.done_at = 0 ORDER BY f.created_at DESC, f.rowid DESC`, teacherID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var files []SharedFile
	var opened []time.Time
	for rows.Next() {
		var file SharedFile
		var created, openedAt int64
		if err := rows.Scan(&file.ID, &file.Sender, &file.Name, &file.Size, &file.PeriodID, &created, &openedAt); err != nil {
			return nil, nil, err
		}
		file.CreatedAt = time.Unix(created, 0)
		files = append(files, file)
		opened = append(opened, unixOrZero(openedAt))
	}
	return files, opened, rows.Err()
}

// SentFiles liefert die Dateien, die die Lehrkraft bereitgestellt hat, mit ihren Empfängerinnen.
func (s *Store) SentFiles(ctx context.Context, sender string) ([]SharedFile, map[string][]SharedRecipient, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, name, size, period_id, created_at FROM shared_files WHERE sender = ? ORDER BY created_at DESC, rowid DESC`, sender)
	if err != nil {
		return nil, nil, err
	}
	var files []SharedFile
	for rows.Next() {
		file := SharedFile{Sender: sender}
		var created int64
		if err := rows.Scan(&file.ID, &file.Name, &file.Size, &file.PeriodID, &created); err != nil {
			rows.Close()
			return nil, nil, err
		}
		file.CreatedAt = time.Unix(created, 0)
		files = append(files, file)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	recipients := map[string][]SharedRecipient{}
	rows, err = s.db.QueryContext(ctx, `
		SELECT r.file_id, r.teacher_id, r.opened_at, r.done_at FROM shared_file_recipients r
		JOIN shared_files f ON f.id = r.file_id WHERE f.sender = ? ORDER BY r.teacher_id`, sender)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var fileID string
		var recipient SharedRecipient
		var opened, done int64
		if err := rows.Scan(&fileID, &recipient.TeacherID, &opened, &done); err != nil {
			return nil, nil, err
		}
		recipient.OpenedAt = unixOrZero(opened)
		recipient.DoneAt = unixOrZero(done)
		recipients[fileID] = append(recipients[fileID], recipient)
	}
	return files, recipients, rows.Err()
}

// SharedFileContent liefert Datei und Inhalt, wenn die Lehrkraft sie bereitgestellt hat oder sie für sie bereitliegt;
// sonst ErrNotFound. Öffnet sie eine Empfängerin zum ersten Mal, wird das vermerkt.
func (s *Store) SharedFileContent(ctx context.Context, id, teacherID string) (SharedFile, []byte, error) {
	var file SharedFile
	var content []byte
	var created int64
	err := s.db.QueryRowContext(ctx, `
		SELECT id, sender, name, size, period_id, created_at, content FROM shared_files
		WHERE id = ? AND (sender = ? OR id IN (SELECT file_id FROM shared_file_recipients WHERE teacher_id = ? AND done_at = 0))`,
		id, teacherID, teacherID).
		Scan(&file.ID, &file.Sender, &file.Name, &file.Size, &file.PeriodID, &created, &content)
	if errors.Is(err, sql.ErrNoRows) {
		return SharedFile{}, nil, ErrNotFound
	}
	if err != nil {
		return SharedFile{}, nil, err
	}
	file.CreatedAt = time.Unix(created, 0)
	_, err = s.db.ExecContext(ctx,
		`UPDATE shared_file_recipients SET opened_at = ? WHERE file_id = ? AND teacher_id = ? AND opened_at = 0`,
		time.Now().Unix(), id, teacherID)
	return file, content, err
}

// RemoveSharedFile: Die Absenderin zieht die Datei für alle zurück, eine Empfängerin markiert sie für sich als
// erledigt (die Absenderin sieht das). ErrNotFound, wenn sie keins von beiden ist.
func (s *Store) RemoveSharedFile(ctx context.Context, id, teacherID string) error {
	result, err := s.db.ExecContext(ctx, `DELETE FROM shared_files WHERE id = ? AND sender = ?`, id, teacherID)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n > 0 {
		return nil
	}
	result, err = s.db.ExecContext(ctx,
		`UPDATE shared_file_recipients SET done_at = ? WHERE file_id = ? AND teacher_id = ? AND done_at = 0`,
		time.Now().Unix(), id, teacherID)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
