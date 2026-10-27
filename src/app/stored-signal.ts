import { effect, signal, WritableSignal } from '@angular/core';

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
  const load = () => read(key, parse) ?? initial();
  const value = signal<T>(load());
  effect(() => save(key, value()));
  window.addEventListener('storage', (event) => {
    if (event.key === key) value.set(load());
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
