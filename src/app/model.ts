export type SectionType = 'checklist' | 'text';

export interface ChecklistItem {
  id: string;
  text: string;
}

/**
 * `lesson`: erscheint im PDF bei jeder Stunde.
 * `general`: nur für Textbausteine; jeder Baustein, der in irgendeiner Stunde angehakt ist,
 * erscheint einmal im allgemeinen Teil vor den Stunden.
 */
export type SectionScope = 'lesson' | 'general';

/** Ein Abschnitt des Feedbackbogens: entweder anhakbare Textbausteine oder ein Freitextfeld. */
export interface Section {
  id: string;
  title: string;
  type: SectionType;
  scope: SectionScope;
  items: ChecklistItem[];
}

export type BlockPosition = 'start' | 'end';
export type ImageAlign = 'left' | 'center' | 'right';

export interface BlockImage {
  dataUrl: string;
  widthPx: number;
  heightPx: number;
  /** Breite im PDF in mm */
  widthMm: number;
  align: ImageAlign;
}

/** Fester Text oder festes Bild, das bei jedem Export am Anfang oder Ende erscheint. */
export interface FixedBlock {
  id: string;
  type: 'text' | 'image';
  position: BlockPosition;
  text: string;
  image?: BlockImage;
}

export interface FeedbackConfig {
  version: 1;
  title: string;
  blocks: FixedBlock[];
  sections: Section[];
}

export const PLACEHOLDERS = [
  { key: '{vorname}', description: 'Vorname (erstes Wort des Namens)' },
  { key: '{name}', description: 'vollständiger Name' },
];

/** Ersetzt die Platzhalter aus `PLACEHOLDERS` durch die Daten der Person. */
export function fillPlaceholders(text: string, student: Student): string {
  const firstName = student.name.trim().split(/\s+/)[0] ?? '';
  return text.replace(/\{vorname\}/gi, firstName).replace(/\{name\}/gi, student.name.trim());
}

export interface Lesson {
  id: string;
  /** ISO-Datum (YYYY-MM-DD) */
  date: string;
  /** Angehakte Textbausteine je Abschnitt (Abschnitts-ID → Item-IDs) */
  checked: Record<string, string[]>;
  /** Freitext je Abschnitt (Abschnitts-ID → Text) */
  texts: Record<string, string>;
}

export interface Student {
  id: string;
  name: string;
  lessons: Lesson[];
}

export function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function today(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

export function formatDate(isoDate: string): string {
  return new Date(isoDate + 'T00:00:00').toLocaleDateString('de-DE', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}
