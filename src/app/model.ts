export type SectionType = 'checklist' | 'text';

export interface ChecklistItem {
  id: string;
  text: string;
}

/**
 * `lesson`: erscheint im PDF bei jeder Stunde.
 * `general`: erscheint einmal im allgemeinen Teil vor den Stunden. Bei Textbausteinen jeder Baustein,
 * der in irgendeiner Stunde angehakt ist; bei Freitext ein Text je Person (`Student.generalTexts`).
 */
export type SectionScope = 'lesson' | 'general';

/** Ein Abschnitt des Feedbackbogens: entweder anhakbare Textbausteine oder ein Freitextfeld. */
export interface Section {
  id: string;
  title: string;
  type: SectionType;
  scope: SectionScope;
  /** Nur Freitext: Titel im PDF vor den Text setzen („Titel: Text“) */
  showTitle: boolean;
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

export interface BlockContent {
  text: string;
  image?: BlockImage;
}

/** Ersetzt den Inhalt eines festen Blocks für Personen mit einem der Instrumente. */
export interface BlockVariant extends BlockContent {
  id: string;
  instrumentIds: string[];
}

/**
 * Fester Text oder festes Bild, das bei jedem Export am Anfang oder Ende erscheint.
 * Wie bei switch/case gewinnt die erste Variante, die das Instrument der Person enthält;
 * sonst gilt der Standardinhalt (`text`/`image`). Ist dieser leer, entfällt der Block.
 */
export interface FixedBlock extends BlockContent {
  id: string;
  type: 'text' | 'image';
  position: BlockPosition;
  variants: BlockVariant[];
}

export function contentFor(block: FixedBlock, instrument: Instrument): BlockContent {
  return block.variants.find((variant) => variant.instrumentIds.includes(instrument.id)) ?? block;
}

export interface Instrument {
  id: string;
  name: string;
}

export interface FeedbackConfig {
  version: 1;
  title: string;
  /** Enthält immer mindestens ein Instrument. */
  instruments: Instrument[];
  defaultInstrumentId: string;
  blocks: FixedBlock[];
  sections: Section[];
}

export function defaultInstrument(config: FeedbackConfig): Instrument {
  return config.instruments.find((i) => i.id === config.defaultInstrumentId) ?? config.instruments[0];
}

/** Instrument der Person; fehlt es (ältere Daten, gelöschtes Instrument), gilt das Standardinstrument. */
export function instrumentOf(student: Student, config: FeedbackConfig): Instrument {
  return config.instruments.find((i) => i.id === student.instrumentId) ?? defaultInstrument(config);
}

export const PLACEHOLDERS = [
  { key: '{vorname}', description: 'Vorname (erstes Wort des Namens)' },
  { key: '{name}', description: 'vollständiger Name' },
  { key: '{instrument}', description: 'Instrument der Person' },
];

/** Ersetzt die Platzhalter aus `PLACEHOLDERS` durch die Daten der Person. */
export function fillPlaceholders(text: string, student: Student, config: FeedbackConfig): string {
  const firstName = student.name.trim().split(/\s+/)[0] ?? '';
  return text
    .replace(/\{vorname\}/gi, firstName)
    .replace(/\{name\}/gi, student.name.trim())
    .replace(/\{instrument\}/gi, instrumentOf(student, config).name);
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
  /** ID eines Instruments aus `FeedbackConfig.instruments`; immer über `instrumentOf` auswerten. */
  instrumentId: string | null;
  /** Freitext der allgemeinen Abschnitte, gilt für alle Stunden (Abschnitts-ID → Text) */
  generalTexts: Record<string, string>;
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
