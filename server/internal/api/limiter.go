package api

import (
	"sync"
	"time"
)

// limiter bremst wiederholte Fehlversuche bei Anmeldung und Codes: Nach fünf Fehlern in Folge wartet man eine
// Minute, danach jeweils doppelt so lange, höchstens eine Stunde. Ein Erfolg setzt den Zähler zurück.
type limiter struct {
	mu      sync.Mutex
	entries map[string]*attempts
}

type attempts struct {
	failures int
	until    time.Time
	last     time.Time
}

const (
	freeFailures = 5
	firstWait    = time.Minute
	maxWait      = time.Hour
)

func newLimiter() *limiter {
	return &limiter{entries: map[string]*attempts{}}
}

// blocked liefert, wie lange noch gewartet werden muss; 0, wenn ein Versuch erlaubt ist.
func (l *limiter) blocked(key string) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	if a := l.entries[key]; a != nil {
		if wait := time.Until(a.until); wait > 0 {
			return wait
		}
	}
	return 0
}

func (l *limiter) failure(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.cleanup()
	a := l.entries[key]
	if a == nil {
		a = &attempts{}
		l.entries[key] = a
	}
	a.failures++
	a.last = time.Now()
	if a.failures >= freeFailures {
		wait := firstWait << min(a.failures-freeFailures, 6)
		a.until = time.Now().Add(min(wait, maxWait))
	}
}

func (l *limiter) success(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.entries, key)
}

// cleanup vergisst Einträge, die lange ruhen, damit die Tabelle nicht wächst.
func (l *limiter) cleanup() {
	if len(l.entries) < 1000 {
		return
	}
	for key, a := range l.entries {
		if time.Since(a.last) > 2*maxWait {
			delete(l.entries, key)
		}
	}
}
