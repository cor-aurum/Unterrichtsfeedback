import { effect, signal, WritableSignal } from '@angular/core';

/** Merker für den Demomodus; er selbst liegt außerhalb der Demodaten. */
export const DEMO_FLAG = 'unterricht-feedback.demo';
/** Vor jedem Schlüssel der Demodaten, z. B. „demo:feedback.config“ */
export const DEMO_PREFIX = 'demo:';

/**
 * Läuft die App im Demomodus? Das steht beim Laden fest: Wechseln lädt die App neu. Im Demomodus liegen alle Daten
 * unter eigenen Schlüsseln, die echten bleiben unberührt.
 */
export const demoMode = (() => {
  try {
    const demo = localStorage.getItem(DEMO_FLAG) === '1';
    // Reste einer beendeten Demo: Beim Beenden können Seiten ihre Werte noch einmal schreiben, bevor neu geladen ist.
    if (!demo) {
      Object.keys(localStorage)
        .filter((key) => key.startsWith(DEMO_PREFIX))
        .forEach((key) => localStorage.removeItem(key));
    }
    return demo;
  } catch {
    return false;
  }
})();

/** Schlüssel im Local Storage; im Demomodus der der Demodaten */
export function storageKey(key: string): string {
  return demoMode ? DEMO_PREFIX + key : key;
}

/**
 * Signal, dessen Wert im Local Storage des Browsers gesichert wird und damit einen Neustart des
 * Browsers übersteht. Änderungen aus anderen Tabs werden übernommen.
 * Muss in einem Injection Context erzeugt werden (z. B. als Feld eines Services).
 *
 * `parse` prüft gespeicherte Daten beim Laden und kann ältere Formate ergänzen.
 */
export function storedSignal<T>(
  key: string,
  initial: () => T,
  parse: (data: unknown) => T = (data) => data as T,
): WritableSignal<T> {
  const stored = storageKey(key);
  const load = () => read(stored, parse) ?? initial();
  const value = signal<T>(load());
  effect(() => save(stored, value()));
  window.addEventListener('storage', (event) => {
    if (event.key === stored) value.set(load());
  });
  return value;
}

function read<T>(key: string, parse: (data: unknown) => T): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? parse(JSON.parse(raw)) : undefined;
  } catch {
    return undefined;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    alert('Der Browserspeicher ist voll, die letzte Änderung wurde nicht gespeichert. Bilder verkleinern oder entfernen.');
  }
}
