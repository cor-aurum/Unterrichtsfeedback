import { Signal, signal } from '@angular/core';

/** Bis zu dieser Breite gilt der Bildschirm als Handy (wie die schmale Ansicht der Kopfleiste). */
export const PHONE_MAX_PX = 700;
/** Bis zu dieser Breite stehen „Stunden erfassen“ und „Personen“ in einer Spalte. */
export const ONE_COLUMN_MAX_PX = 900;

const queries = new Map<string, Signal<boolean>>();

/**
 * Ob die Media-Query gerade zutrifft, als Signal; folgt dem Drehen des Geräts und dem Ändern der Fenstergröße. Je
 * Query gibt es ein Signal für die ganze App.
 */
export function mediaQuery(query: string): Signal<boolean> {
  const known = queries.get(query);
  if (known) return known;
  const matches = signal(false);
  if (typeof matchMedia === 'function') {
    const list = matchMedia(query);
    matches.set(list.matches);
    list.addEventListener('change', () => matches.set(list.matches));
  }
  queries.set(query, matches.asReadonly());
  return matches.asReadonly();
}

/** Handybreite */
export function phoneScreen(): Signal<boolean> {
  return mediaQuery(`(max-width: ${PHONE_MAX_PX}px)`);
}

/** Eine Spalte: Listen und Bearbeiten stehen nicht nebeneinander, sondern nacheinander. */
export function oneColumn(maxPx = ONE_COLUMN_MAX_PX): Signal<boolean> {
  return mediaQuery(`(max-width: ${maxPx}px)`);
}
