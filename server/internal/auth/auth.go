// Package auth erzeugt und prüft Passwörter, Anmelde-Token und Codes zum Einladen oder Zurücksetzen.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
)

// MinPasswordLength ist die kürzeste erlaubte Passwortlänge in Zeichen.
const MinPasswordLength = 8

var ErrWeakPassword = fmt.Errorf("das Passwort braucht mindestens %d Zeichen", MinPasswordLength)

func HashPassword(password string) (string, error) {
	if utf8.RuneCountInString(password) < MinPasswordLength {
		return "", ErrWeakPassword
	}
	// bcrypt nutzt nur die ersten 72 Bytes; längere Passwörter sind trotzdem erlaubt.
	hash, err := bcrypt.GenerateFromPassword(truncate(password), 12)
	return string(hash), err
}

func CheckPassword(hash, password string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), truncate(password)) == nil
}

func truncate(password string) []byte {
	b := []byte(password)
	if len(b) > 72 {
		b = b[:72]
	}
	return b
}

// NewToken erzeugt ein zufälliges Anmelde-Token; gespeichert wird nur sein Hash.
func NewToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// Hash dient zum Speichern von Token und Codes: Wer die Datenbank liest, kann sich damit nicht anmelden.
func Hash(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

// Zeichen für Codes: ohne leicht verwechselbare wie 0/O und 1/I/L.
const codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

// NewCode erzeugt einen Code wie „K7QM-2XWD-9HTR“: zwölf Zeichen, knapp 60 Bit Zufall. Codes gelten nur einmal
// und nur kurz, und Fehlversuche werden gebremst; das reicht gegen Raten.
func NewCode() string {
	var sb strings.Builder
	buf := make([]byte, 1)
	for n := 0; n < 12; {
		if _, err := rand.Read(buf); err != nil {
			panic(err)
		}
		// Nur Bytes unter 8·31 = 248, damit jedes Zeichen gleich wahrscheinlich ist
		if int(buf[0]) >= 8*len(codeAlphabet) {
			continue
		}
		if n > 0 && n%4 == 0 {
			sb.WriteByte('-')
		}
		sb.WriteByte(codeAlphabet[int(buf[0])%len(codeAlphabet)])
		n++
	}
	return sb.String()
}

// NormalizeCode macht Eingaben vergleichbar: Groß-/Kleinschreibung, Leerzeichen und Bindestriche zählen nicht.
func NormalizeCode(code string) string {
	code = strings.ToUpper(code)
	var sb strings.Builder
	for _, r := range code {
		if strings.ContainsRune(codeAlphabet, r) {
			sb.WriteRune(r)
		}
	}
	return sb.String()
}

// Packed ist der Inhalt eines Einladungs- oder Reset-Codes, wie ihn die App einliest: die Adresse des Servers,
// die Art und der eigentliche Code.
type Packed struct {
	Server string `json:"s"`
	Kind   string `json:"k"`
	Code   string `json:"c"`
}

const packedPrefix = "UF1."

// Pack verpackt einen Code mit der Serveradresse, z. B. „UF1.eyJzIjoiaHR0cHM6Ly8…“.
func Pack(p Packed) string {
	data, _ := json.Marshal(p)
	return packedPrefix + base64.RawURLEncoding.EncodeToString(data)
}

func Unpack(text string) (Packed, error) {
	text = strings.TrimSpace(text)
	if !strings.HasPrefix(text, packedPrefix) {
		return Packed{}, errors.New("kein Code dieser App")
	}
	data, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(text, packedPrefix))
	if err != nil {
		return Packed{}, err
	}
	var p Packed
	err = json.Unmarshal(data, &p)
	return p, err
}
