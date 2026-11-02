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
/**
 * Ersetzt den Inhalt eines festen Blocks für bestimmte Personen. Sind Instrumente und Lehrer gewählt,
 * müssen beide passen; eine leere Liste bedeutet „egal“.
 */
export interface BlockVariant extends BlockContent {
  id: string;
  instrumentIds: string[];
  teacherIds: string[];
}

function variantMatches(variant: BlockVariant, instrument: Instrument, teacher: Teacher): boolean {
  if (variant.instrumentIds.length === 0 && variant.teacherIds.length === 0) return false;
  return (
    (variant.instrumentIds.length === 0 || variant.instrumentIds.includes(instrument.id)) &&
    (variant.teacherIds.length === 0 || variant.teacherIds.includes(teacher.id))
  );
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

export function contentFor(block: FixedBlock, instrument: Instrument, teacher: Teacher): BlockContent {
  return block.variants.find((variant) => variantMatches(variant, instrument, teacher)) ?? block;
}

export interface Instrument {
  id: string;
  name: string;
}

/**
 * Kopf- und Fußzeile im PDF. Alle Texte können die Platzhalter aus `PLACEHOLDERS` enthalten;
 * ein leerer Text blendet die Zeile aus.
 */
export interface PdfLayout {
  /** Zeile unter der Überschrift auf der ersten Seite einer Person */
  subtitle: string;
  /** Anzahl der Stunden und Stand bzw. Datum der einzigen Stunde unter dem Untertitel */
  showInfoLine: boolean;
  /** Kopfzeile ab der zweiten Seite einer Person */
  runningHeader: string;
  footerLeft: string;
  footerCenter: string;
  footerRight: string;
}

export const DEFAULT_PDF_LAYOUT: PdfLayout = {
  subtitle: 'für {name}',
  showInfoLine: true,
  runningHeader: '{titel} · {name}',
  footerLeft: '{name}',
  footerCenter: '',
  footerRight: 'Seite {seite} von {seiten}',
};

/** Zeitfenster ohne Wochentag, z. B. eine der Standardunterrichtszeiten */
export interface TimeWindow {
  id: string;
  /** HH:MM */
  from: string;
  /** HH:MM */
  to: string;
}

/** Zeitfenster, in dem an einem Wochentag Unterricht möglich ist (0 = Montag … 6 = Sonntag). */
export interface TeachingWindow extends TimeWindow {
  weekday: number;
}

/** Gilt für alle Lehrer; die Unterrichtszeiten hat jeder Lehrer selbst. */
export interface CalendarSettings {
  /** Standardlänge neuer Termine; teilt die Zeitfenster außerdem in Slots */
  defaultDurationMinutes: number;
  /** Ob „Jede Woche wiederholen“ bei neuen Terminen angehakt ist */
  weeklyByDefault: boolean;
  /** Vorlage für die Unterrichtszeiten eines Tages; lässt sich bei jedem Lehrer auf einen Tag übernehmen */
  defaultWindows: TimeWindow[];
}

export function defaultCalendarSettings(): CalendarSettings {
  return {
    defaultDurationMinutes: 45,
    weeklyByDefault: true,
    defaultWindows: [{ id: newId(), from: '14:00', to: '18:30' }],
  };
}

/** Die Standardunterrichtszeiten als Zeitfenster für einen Wochentag (mit neuen IDs). */
export function standardWindowsFor(settings: CalendarSettings, weekday: number): TeachingWindow[] {
  return settings.defaultWindows.map((w) => ({ id: newId(), weekday, from: w.from, to: w.to }));
}

/** Unterrichtszeiten eines neuen Lehrers: die Standardunterrichtszeiten von Montag bis Freitag */
export function defaultTeachingWindows(settings = defaultCalendarSettings()): TeachingWindow[] {
  return [0, 1, 2, 3, 4].flatMap((weekday) => standardWindowsFor(settings, weekday));
}

/** Lehrkraft mit eigenem Kalender: Termine ihrer Personen und eigene Unterrichtszeiten. */
export interface Teacher {
  id: string;
  name: string;
  /** ID eines Instruments aus `FeedbackConfig.instruments`; immer über `teacherInstrument` auswerten. */
  instrumentId: string | null;
  /** Freitext, z. B. „Raum 3, Musikschule Mitte“ */
  location: string;
  teachingWindows: TeachingWindow[];
}

export function teacherInstrument(teacher: Teacher, config: FeedbackConfig): Instrument {
  return config.instruments.find((i) => i.id === teacher.instrumentId) ?? defaultInstrument(config);
}

/** Lehrer der Person; fehlt er (ältere Daten, gelöschter Lehrer), gilt der erste Lehrer. */
export function teacherOf(student: Student, config: FeedbackConfig): Teacher {
  return config.teachers.find((t) => t.id === student.teacherId) ?? config.teachers[0];
}

export interface FeedbackConfig {
  version: 1;
  title: string;
  /** Themenfarbe (Hex, z. B. #f57115) für App und PDF */
  themeColor: string;
  pdfLayout: PdfLayout;
  calendar: CalendarSettings;
  /** Enthält immer mindestens einen Lehrer. */
  teachers: Teacher[];
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

/** Alle Platzhalter funktionieren in jedem Text, der im PDF erscheint. */
export const PLACEHOLDERS = [
  { key: '{vorname}', description: 'Vorname (erstes Wort des Namens)' },
  { key: '{nachname}', description: 'Nachname (alles nach dem ersten Wort)' },
  { key: '{name}', description: 'vollständiger Name' },
  { key: '{instrument}', description: 'Instrument der Person' },
  { key: '{lehrer}', description: 'vollständiger Name des Lehrers der Person' },
  { key: '{lehrervorname}', description: 'Vorname des Lehrers' },
  { key: '{lehrernachname}', description: 'Nachname des Lehrers' },
  { key: '{lehrerinstrument}', description: 'Instrument des Lehrers' },
  { key: '{ort}', description: 'Ort des Lehrers' },
  { key: '{titel}', description: 'Überschrift im PDF' },
  { key: '{datum}', description: 'Datum des Exports' },
  { key: '{uhrzeit}', description: 'Beginn der Stunde; außerhalb einer Stunde der letzten Stunde mit Uhrzeit' },
  { key: '{seite}', description: 'Seitennummer bei der Person' },
  { key: '{seiten}', description: 'Seitenanzahl der Person' },
];

/**
 * Ersetzt die Platzhalter der Person und des Exports. {seite} und {seiten} bleiben stehen: Die Seite
 * steht erst beim Schreiben ins PDF fest (siehe `PdfWriter`).
 *
 * `lesson` ist die Stunde, zu der der Text gehört; ohne sie gilt für {uhrzeit} die letzte Stunde mit Uhrzeit.
 */
export function fillPlaceholders(text: string, student: Student, config: FeedbackConfig, lesson?: Lesson): string {
  const timedLesson = lesson ?? latestLessonWithTime(student);
  const teacher = teacherOf(student, config);
  return (
    text
      // {titel} zuerst, weil die Überschrift selbst Platzhalter enthalten kann.
      .replace(/\{titel\}/gi, config.title)
      .replace(/\{vorname\}/gi, firstNameOf(student.name))
      .replace(/\{nachname\}/gi, lastNameOf(student.name))
      .replace(/\{name\}/gi, student.name.trim())
      .replace(/\{instrument\}/gi, instrumentOf(student, config).name)
      .replace(/\{lehrervorname\}/gi, firstNameOf(teacher.name))
      .replace(/\{lehrernachname\}/gi, lastNameOf(teacher.name))
      .replace(/\{lehrer\}/gi, teacher.name.trim())
      .replace(/\{lehrerinstrument\}/gi, teacherInstrument(teacher, config).name)
      .replace(/\{ort\}/gi, teacher.location)
      .replace(/\{datum\}/gi, formatLongDate(today()))
      .replace(/\{uhrzeit\}/gi, timedLesson?.start ?? '')
  );
}

/** Erstes Wort eines Namens, z. B. „Anna“ aus „Anna Maria Berg“ */
export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

/** Alles nach dem ersten Wort, z. B. „Maria Berg“ aus „Anna Maria Berg“ */
export function lastNameOf(name: string): string {
  return name.trim().split(/\s+/).slice(1).join(' ');
}

function latestLessonWithTime(student: Student): Lesson | undefined {
  return student.lessons
    .filter((lesson) => lesson.start)
    .sort((a, b) => b.date.localeCompare(a.date) || b.start!.localeCompare(a.start!))[0];
}

export interface Lesson {
  id: string;
  /** ISO-Datum (YYYY-MM-DD) */
  date: string;
  /** Beginn als HH:MM; gesetzt bei Stunden aus dem Kalender oder von Hand */
  start?: string;
  /** Länge in Minuten; nur bei Stunden aus dem Kalender bekannt */
  durationMinutes?: number;
  /** Angehakte Textbausteine je Abschnitt (Abschnitts-ID → Item-IDs) */
  checked: Record<string, string[]>;
  /** Freitext je Abschnitt (Abschnitts-ID → Text) */
  texts: Record<string, string>;
}

/** Uhrzeit einer Stunde für Anzeige und Platzhalter, z. B. „15:00–15:45“ oder nur „15:00“; leer ohne Uhrzeit. */
export function lessonTime(lesson: Lesson): string {
  if (!lesson.start) return '';
  if (!lesson.durationMinutes) return lesson.start;
  const [hours, minutes] = lesson.start.split(':').map(Number);
  const end = hours * 60 + minutes + lesson.durationMinutes;
  return `${lesson.start}–${String(Math.floor(end / 60) % 24).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
}

/** Stunde einer Person an einem Termin: gleiches Datum und, falls beide eine Uhrzeit haben, gleicher Beginn. */
export function lessonAt(student: Student, date: string, start?: string): Lesson | undefined {
  return student.lessons.find(
    (lesson) => lesson.date === date && (!lesson.start || !start || lesson.start === start),
  );
}

/** Daten, an denen die Person mehr als eine Stunde eingetragen hat – meist ein Versehen. */
export function doubleLessonDates(student: Student): Set<string> {
  const dates = student.lessons.map((lesson) => lesson.date);
  return new Set(dates.filter((date, index) => dates.indexOf(date) !== index));
}

export interface Student {
  id: string;
  name: string;
  /** ID eines Instruments aus `FeedbackConfig.instruments`; immer über `instrumentOf` auswerten. */
  instrumentId: string | null;
  /** ID eines Lehrers aus `FeedbackConfig.teachers`; immer über `teacherOf` auswerten. */
  teacherId: string | null;
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

export function formatLongDate(isoDate: string): string {
  return new Date(isoDate + 'T00:00:00').toLocaleDateString('de-DE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export function formatDate(isoDate: string): string {
  return new Date(isoDate + 'T00:00:00').toLocaleDateString('de-DE', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}
