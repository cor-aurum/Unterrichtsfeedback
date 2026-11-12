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
  /** Eigener Abschnitt dieses Lehrers (siehe `isVisibleTo`); fehlt bei gemeinsamen */
  ownerId?: string;
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

/**
 * Ersetzt den Inhalt eines festen Blocks für bestimmte Instrumente, Berichtszeiträume oder (als eigene Variante)
 * die Personen eines Lehrers. Alle gewählten Bedingungen müssen passen; eine leere Liste bedeutet „egal“.
 */
export interface BlockVariant extends BlockContent {
  id: string;
  instrumentIds: string[];
  periodIds: string[];
  /** Eigene Variante dieses Lehrers (siehe `isVisibleTo`): gilt nur für seine Personen und Gruppen */
  ownerId?: string;
}

/** Für wen und wann ein fester Block geschrieben wird */
export interface VariantContext {
  instrument: Instrument;
  teacher: Teacher;
  periodId: string;
}

function variantMatches(variant: BlockVariant, context: VariantContext): boolean {
  if (variant.ownerId && variant.ownerId !== context.teacher.id) return false;
  const conditions: [string[], string][] = [
    [variant.instrumentIds, context.instrument.id],
    [variant.periodIds, context.periodId],
  ];
  const chosen = conditions.filter(([ids]) => ids.length > 0);
  // Eine eigene Variante ohne weitere Bedingung gilt für alle Personen ihres Lehrers.
  return (chosen.length > 0 || !!variant.ownerId) && chosen.every(([ids, id]) => ids.includes(id));
}

/**
 * Fester Text oder festes Bild, das bei jedem Export am Anfang oder Ende erscheint.
 * Wie bei switch/case gewinnt die erste passende Variante; sonst gilt der Standardinhalt (`text`/`image`).
 * Ist dieser leer, entfällt der Block.
 */
export interface FixedBlock extends BlockContent {
  id: string;
  type: 'text' | 'image';
  position: BlockPosition;
  variants: BlockVariant[];
  /** Eigener Inhalt dieses Lehrers (siehe `isVisibleTo`); fehlt bei gemeinsamen */
  ownerId?: string;
}

export function contentFor(block: FixedBlock, context: VariantContext): BlockContent {
  return block.variants.find((variant) => variantMatches(variant, context)) ?? block;
}

/**
 * Abschnitte und feste Inhalte gelten für alle Lehrer oder gehören einem (`ownerId`). Eigene gelten nur für die
 * Personen und Gruppen ihres Lehrers; andere Lehrer sehen sie weder beim Erfassen noch in der Konfiguration.
 */
export function isVisibleTo(entry: { ownerId?: string }, teacherId: string): boolean {
  return !entry.ownerId || entry.ownerId === teacherId;
}

/** Die Konfiguration, wie sie für einen Lehrer gilt: ohne die eigenen Abschnitte und Inhalte anderer Lehrer */
export function configForTeacher(config: FeedbackConfig, teacherId: string): FeedbackConfig {
  const visible = <T extends { ownerId?: string }>(list: T[]) => list.filter((entry) => isVisibleTo(entry, teacherId));
  const visibleBlocks = (blocks: FixedBlock[]) =>
    visible(blocks).map((block) => ({ ...block, variants: visible(block.variants) }));
  return {
    ...config,
    sections: visible(config.sections),
    blocks: visibleBlocks(config.blocks),
    groupSections: visible(config.groupSections),
    groupBlocks: visibleBlocks(config.groupBlocks),
  };
}

/** Zeitraum als ISO-Daten, jeweils einschließlich */
export interface Period {
  from: string;
  to: string;
}

/**
 * Berichtszeitraum, z. B. ein Schulhalbjahr. Er bestimmt, welche Personen und Stunden im PDF stehen, welche
 * Stunden für den allgemeinen Teil zählen und welche Varianten der festen Inhalte gelten.
 */
export interface ReportPeriodEntry extends Period {
  id: string;
  name: string;
  /** Lehrer, die in diesem Zeitraum unterrichten; der erste (z. B. die Leitung) steht überall vorne */
  teacherIds: string[];
  /**
   * Nur auf dem Gerät: Vorläufiger Zeitraum, weil die Lehrkraft in keinem eingetragen ist (die App braucht immer
   * einen). Er geht nicht auf den Server.
   */
  placeholder?: boolean;
  /**
   * Gemeinsame Unterrichtszeiten für alle Lehrer im Zeitraum. Fehlen sie, hat jeder Lehrer eigene
   * (`Teacher.periodWindows`).
   */
  sharedWindows?: TeachingWindow[];
  /** Selbsteintragung über den Download-Link; fehlt, wenn sie nicht läuft */
  selfBooking?: SelfBooking;
}

/**
 * Selbsteintragung über den Download-Link: Wie am Tablet tragen sich die Personen dieser Lehrkräfte selbst für
 * Einzeltermine ein, jede auf ihrer eigenen Seite. Läuft sie für eine Lehrkraft, gibt es für sie keine
 * Tablet-Planung im selben Zeitraum.
 */
export interface SelfBooking {
  teacherIds: string[];
  from: string;
  to: string;
  /** So viele Einzeltermine darf jede Person im Zeitraum höchstens haben (bereits eingetragene zählen mit). */
  maxPerStudent: number;
}

/** Läuft die Selbsteintragung über den Link noch (bis einschließlich ihres letzten Tages)? */
export function activeSelfBooking(period: ReportPeriodEntry | undefined): SelfBooking | null {
  const booking = period?.selfBooking;
  return booking && booking.teacherIds.length > 0 && booking.to >= today() ? booking : null;
}

/**
 * Ende des Berichtszeitraums, in dem das Datum liegt (bei mehreren des längsten). Liegt es in keinem, gilt der
 * nächste spätere Zeitraum, sonst das Schulhalbjahr um das Datum.
 */
export function reportPeriodEnd(periods: Period[], date: string): string {
  const containing = periods.filter((period) => containsDate(period, date)).map((period) => period.to).sort();
  if (containing.length > 0) return containing.at(-1)!;
  const later = periods.filter((period) => period.from > date).sort((a, b) => a.from.localeCompare(b.from));
  return later[0]?.to ?? schoolHalfYear(date).to;
}

/** Lehrer, die an dem Tag in einem Berichtszeitraum aktiv sind; liegt der Tag in keinem Zeitraum, alle. */
export function activeTeachersOn(config: FeedbackConfig, date: string): Teacher[] {
  const periods = config.reportPeriods.filter((period) => containsDate(period, date));
  if (periods.length === 0) return config.teachers;
  const ids = new Set(periods.flatMap((period) => period.teacherIds));
  return teachersInOrderOn(config, date).filter((teacher) => ids.has(teacher.id));
}

/** Die Lehrer des Zeitraums in seiner Reihenfolge */
export function periodTeachers(config: FeedbackConfig, period: ReportPeriodEntry): Teacher[] {
  return byPeriodOrder(config.teachers, period.teacherIds).filter((teacher) => period.teacherIds.includes(teacher.id));
}

/**
 * Alle Lehrer: zuerst die der Berichtszeiträume am Tag in deren Reihenfolge, danach die übrigen in der allgemeinen
 * (Konfiguration → Lehrer).
 */
export function teachersInOrderOn(config: FeedbackConfig, date: string): Teacher[] {
  const ids = config.reportPeriods.filter((period) => containsDate(period, date)).flatMap((period) => period.teacherIds);
  return byPeriodOrder(config.teachers, ids);
}

/** Zuerst die Lehrer aus `ids` in deren Reihenfolge, danach die übrigen in ihrer bisherigen */
export function byPeriodOrder(teachers: Teacher[], ids: string[]): Teacher[] {
  const rank = (teacher: Teacher) => {
    const index = ids.indexOf(teacher.id);
    return index < 0 ? ids.length : index;
  };
  return [...teachers].sort((a, b) => rank(a) - rank(b));
}

export function containsDate(period: Period, date: string): boolean {
  return date >= period.from && date <= period.to;
}

/**
 * Für Termine und Stunden ohne gespeicherten Zeitraum (ältere Daten): der früheste Zeitraum der Person, in dem der
 * Tag liegt. Überall dieselbe Regel – auch für die Ablage auf dem Server –, unabhängig vom gewählten Zeitraum.
 */
export function studentPeriodOn(student: Student, date: string, periods: ReportPeriodEntry[]): string | null {
  const own = periods.filter((period) => Object.hasOwn(student.periods, period.id) && containsDate(period, date));
  return own.sort((a, b) => a.from.localeCompare(b.from))[0]?.id ?? null;
}

/** Berichtszeitraum einer Stunde der Person: der gespeicherte, sonst wie `studentPeriodOn` */
export function lessonPeriodId(student: Student, lesson: Lesson, periods: ReportPeriodEntry[]): string | null {
  return lesson.periodId ?? studentPeriodOn(student, lesson.date, periods);
}

/** Unterricht gibt es nur an Tagen in einem Berichtszeitraum. */
export function isTeachingDay(config: FeedbackConfig, date: string): boolean {
  return config.reportPeriods.some((period) => containsDate(period, date));
}

export const NO_TEACHING_TEXT = 'liegt in keinem Berichtszeitraum; außerhalb der Berichtszeiträume gibt es keinen Unterricht.';

/** Schulhalbjahr um ein Datum: 1. August bis 31. Januar oder 1. Februar bis 31. Juli */
export function schoolHalfYear(date: string): Omit<ReportPeriodEntry, 'teacherIds'> {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  // Schuljahr, z. B. 2026 für 2026/27
  const start = month >= 8 ? year : year - 1;
  const first = month >= 8 || month === 1;
  const from = first ? `${start}-08-01` : `${start + 1}-02-01`;
  return {
    // Aus dem Datum abgeleitet, damit mehrere Geräte für dasselbe Halbjahr dieselbe ID erzeugen
    id: `halbjahr-${from}`,
    name: `${first ? 1 : 2}. Halbjahr ${start}/${String((start + 1) % 100).padStart(2, '0')}`,
    from,
    to: first ? `${start + 1}-01-31` : `${start + 1}-07-31`,
  };
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
  /** Logo neben der Überschrift auf der ersten Seite, verkleinert auch neben der Kopfzeile der Folgeseiten */
  headerLogo: PdfLogo | null;
  /** Logo in der Fußzeile jeder Seite */
  footerLogo: PdfLogo | null;
  /** Alle PDFs in Graustufen, ohne farbige Flächen und mit grauen Bildern, um beim Drucken Farbe zu sparen */
  grayscale: boolean;
}

/** Logo in Kopf- oder Fußzeile; die Höhe bestimmt die Größe, die Breite folgt aus dem Seitenverhältnis. */
export interface PdfLogo {
  /** Hochgeladenes Bild als Data-URL oder `APP_LOGO_PATH` für das mitgelieferte Logo der App */
  dataUrl: string;
  widthPx: number;
  heightPx: number;
  /** Höhe im PDF in mm */
  heightMm: number;
  align: ImageAlign;
}

/** Breite und Höhe eines Logos in mm bei der gewünschten Höhe, höchstens `maxWidth` breit */
export function logoSize(logo: PdfLogo, height: number, maxWidth: number): { width: number; height: number } {
  const width = height * (logo.widthPx / logo.heightPx);
  return width <= maxWidth ? { width, height } : { width: maxWidth, height: maxWidth * (logo.heightPx / logo.widthPx) };
}

/**
 * Das App-Logo liegt der App bei und wird erst beim PDF-Export eingebettet, damit die Konfiguration klein bleibt.
 * Für das PDF ohne den cremefarbenen Hintergrund von `logo.png`, damit es auf dem Papier keinen Kasten bildet.
 */
export const APP_LOGO_PATH = 'logo-transparent.png';
/** Frühere Konfigurationen verweisen noch auf das Logo mit Hintergrund. */
export const LEGACY_APP_LOGO_PATH = 'logo.png';
export const APP_LOGO: PdfLogo = { dataUrl: APP_LOGO_PATH, widthPx: 256, heightPx: 256, heightMm: 15, align: 'right' };

export const LOGO_HEIGHT_LIMITS = { headerLogo: { min: 5, max: 40 }, footerLogo: { min: 4, max: 12 } } as const;

export const DEFAULT_PDF_LAYOUT: PdfLayout = {
  subtitle: 'für {name}',
  showInfoLine: true,
  runningHeader: '{titel} · {name}',
  footerLeft: '{name}',
  footerCenter: '',
  footerRight: 'Seite {seite} von {seiten}',
  headerLogo: APP_LOGO,
  footerLogo: null,
  grayscale: false,
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
  /** Ob „Wiederholen“ bei neuen Terminen angehakt ist */
  repeatByDefault: boolean;
  /** Vorlage für die Unterrichtszeiten eines Tages; lässt sich bei jedem Lehrer auf einen Tag übernehmen */
  defaultWindows: TimeWindow[];
}

export function defaultCalendarSettings(): CalendarSettings {
  return {
    defaultDurationMinutes: 30,
    repeatByDefault: false,
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
  /** Freitext, z. B. „Raum 3, Musikschule Mitte“; gilt in Berichtszeiträumen ohne eigenen (`periodLocations`) */
  location: string;
  /** Ort je Berichtszeitraum (Schlüssel: ID des Zeitraums); immer über `locationIn` oder `locationOn` auswerten */
  periodLocations: Record<string, string>;
  /**
   * Persönliche Themenfarbe (Hex) für App und PDFs dieser Lehrkraft; fehlt sie, gilt die allgemeine
   * (`FeedbackConfig.themeColor`). Andere Lehrkräfte beeinflusst sie nicht.
   */
  themeColor?: string;
  /** Wohin das Logo oben links führt (Pfad einer Seite aus `HOME_PAGES`); fehlt es, zum Kalender */
  homePage?: string;
  /** Standard-Unterrichtszeiten für Berichtszeiträume ohne eigene (`periodWindows`) */
  teachingWindows: TeachingWindow[];
  /** Eigene Unterrichtszeiten je Berichtszeitraum (Schlüssel: ID des Zeitraums) */
  periodWindows: Record<string, TeachingWindow[]>;
}

/**
 * Wessen Unterrichtszeiten bearbeitet werden: die eines Lehrers in einem Berichtszeitraum (`periodId` null: seine
 * Standardzeiten) oder die gemeinsamen eines Zeitraums.
 */
export type WindowsOwner = { teacherId: string; periodId: string | null } | { sharedPeriodId: string };

/** Unterrichtszeiten eines Lehrers im Berichtszeitraum; `null` oder ohne eigene: die allgemeinen */
export function teachingWindowsFor(teacher: Teacher, periodId: string | null): TeachingWindow[] {
  return (periodId && teacher.periodWindows[periodId]) || teacher.teachingWindows;
}

/**
 * Unterrichtszeiten des Lehrers an einem Tag, nach Beginn sortiert: die des Berichtszeitraums, in dem der Tag
 * liegt (bei mehreren der, in dem der Lehrer aktiv ist) – die gemeinsamen des Zeitraums oder, ohne sie, die eigenen
 * des Lehrers. Außerhalb der Berichtszeiträume gibt es keinen Unterricht.
 */
export function teachingWindowsOn(
  teacher: Teacher,
  config: FeedbackConfig,
  date: string,
  preferredPeriodId?: string,
): TeachingWindow[] {
  const period = periodOfTeacherOn(teacher, config, date, preferredPeriodId);
  if (!period) return [];
  const day = (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7;
  return (period.sharedWindows ?? teachingWindowsFor(teacher, period.id))
    .filter((window) => window.weekday === day)
    .sort((a, b) => a.from.localeCompare(b.from));
}

/** Ort des Lehrers im Berichtszeitraum; ohne eigenen (oder ohne Zeitraum) sein allgemeiner */
export function locationIn(teacher: Teacher, periodId: string | null): string {
  const own = periodId !== null && Object.hasOwn(teacher.periodLocations, periodId);
  return (own ? teacher.periodLocations[periodId!] : teacher.location).trim();
}

/** Ort des Lehrers an einem Tag: der des Berichtszeitraums, in dem der Tag liegt (wie bei `teachingWindowsOn`) */
export function locationOn(teacher: Teacher, config: FeedbackConfig, date: string, preferredPeriodId?: string): string {
  return locationIn(teacher, periodOfTeacherOn(teacher, config, date, preferredPeriodId)?.id ?? null);
}

/**
 * Zeitraum eines Lehrers an einem Tag: bei mehreren überlappenden der bevorzugte (z. B. der auf dem Gerät gewählte
 * oder der eines Termins), wenn der Lehrer in ihm aktiv ist; sonst der erste, in dem er aktiv ist; sonst irgendeiner.
 */
function periodOfTeacherOn(
  teacher: Teacher,
  config: FeedbackConfig,
  date: string,
  preferredPeriodId?: string,
): ReportPeriodEntry | undefined {
  const periods = config.reportPeriods.filter((period) => containsDate(period, date));
  const active = periods.filter((p) => p.teacherIds.includes(teacher.id));
  return active.find((p) => p.id === preferredPeriodId) ?? active[0] ?? periods[0];
}

export function teacherInstrument(teacher: Teacher, config: FeedbackConfig): Instrument {
  return config.instruments.find((i) => i.id === teacher.instrumentId) ?? defaultInstrument(config);
}

/**
 * Lehrer der Person im Berichtszeitraum. Ist sie dort nicht aktiv, gilt ihr Lehrer aus einem anderen Zeitraum;
 * fehlt er (gelöschter Lehrer), der erste Lehrer.
 */
export function teacherOf(student: Student, config: FeedbackConfig, periodId: string): Teacher {
  const id = isActiveIn(student, periodId)
    ? student.periods[periodId]
    : Object.values(student.periods).find((teacherId) => teacherId !== null);
  return config.teachers.find((t) => t.id === id) ?? config.teachers[0];
}

/** In Zeiträumen, in denen sie nicht eingetragen ist, ist die Person inaktiv. */
export function isActiveIn(student: Student, periodId: string): boolean {
  return Object.hasOwn(student.periods, periodId);
}

/** Seiten, zu denen das Logo oben links führen kann, in der Reihenfolge der Auswahl */
export const HOME_PAGES = [
  { path: 'kalender', label: 'Kalender' },
  { path: 'stunden', label: 'Stunden erfassen' },
  { path: 'personen', label: 'Personen' },
  { path: 'gruppen', label: 'Gruppenplanung' },
  { path: 'konfiguration', label: 'Konfiguration' },
  { path: 'export', label: 'Export & Sicherung' },
  { path: 'hilfe', label: 'Hilfe' },
] as const;

/** Ziel des Logos für die Lehrkraft, z. B. „/kalender“ */
export function homeLinkOf(teacher: Teacher): string {
  return '/' + (HOME_PAGES.find((page) => page.path === teacher.homePage)?.path ?? 'kalender');
}

export interface FeedbackConfig {
  version: 1;
  title: string;
  /** Themenfarbe (Hex, z. B. #f57115) für Lehrkräfte ohne eigene (`Teacher.themeColor`) */
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
  /** Eigene Abschnitte und feste Inhalte für Gruppenstunden und das Gruppen-PDF */
  groupBlocks: FixedBlock[];
  groupSections: Section[];
  /** Enthält immer mindestens einen Zeitraum; welcher gerade gilt, wählt jedes Gerät selbst (`ReportPeriod`). */
  reportPeriods: ReportPeriodEntry[];
  /** Feste Texte der Kalender-PDFs (Terminlisten, Wochen- und Tagesplan) */
  calendarPdf: CalendarPdfTexts;
  /**
   * Mit Server ändert jede Lehrkraft nur eigene Inhalte und Varianten. Früher geänderte gemeinsame Texte wurden dafür
   * einmal zu eigenen Varianten aller Lehrkräfte (siehe `ConfigStore.migrateSharedContents`).
   */
  sharedContentsMigrated?: boolean;
}

export interface CalendarPdfTexts {
  listTitle: string;
  eventListTitle: string;
  individualListTitle: string;
  dayPlanTitle: string;
  /** Links in der Fußzeile jeder Seite */
  footer: string;
  /** Steht im PDF, wenn der Zeitraum keine Termine hat */
  noAppointments: string;
  /** Bezeichnung von Blockern, z. B. „Blockiert: Fortbildung“ */
  blocked: string;
}

export const DEFAULT_CALENDAR_PDF_TEXTS: CalendarPdfTexts = {
  listTitle: 'Unterrichtsplan',
  eventListTitle: 'Termine ohne Einzelunterricht',
  individualListTitle: 'Einzelunterricht',
  dayPlanTitle: 'Tagesplan aller Lehrkräfte',
  footer: 'Unterrichtsplan',
  noAppointments: 'In diesem Zeitraum sind keine Termine geplant.',
  blocked: 'Blockiert',
};

/** Einzelunterricht (`single`) oder Gruppen (`group`): welche Abschnitte und festen Inhalte gemeint sind */
export type ContentKind = 'single' | 'group';

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
  { key: '{lehrer}', description: 'vollständiger Name der Lehrkraft der Person' },
  { key: '{lehrervorname}', description: 'Vorname der Lehrkraft' },
  { key: '{lehrernachname}', description: 'Nachname der Lehrkraft' },
  { key: '{lehrerinstrument}', description: 'Instrument der Lehrkraft' },
  { key: '{ort}', description: 'Ort der Lehrkraft im Berichtszeitraum' },
  { key: '{titel}', description: 'Überschrift im PDF' },
  { key: '{datum}', description: 'Datum des Exports' },
  { key: '{zeitraum}', description: 'Name des Berichtszeitraums, z. B. „1. Halbjahr 2026/27“' },
  { key: '{uhrzeit}', description: 'Beginn der Stunde; außerhalb einer Stunde der letzten Stunde mit Uhrzeit' },
  { key: '{seite}', description: 'Seitennummer bei der Person' },
  { key: '{seiten}', description: 'Seitenanzahl der Person' },
];

/** Platzhalter im Gruppen-PDF; {name} und {vorname} stehen dort ebenfalls für den Gruppennamen. */
export const GROUP_PLACEHOLDERS = [
  { key: '{gruppe}', description: 'Name der Gruppe (ohne Namen: die Vornamen der Mitglieder)' },
  { key: '{mitglieder}', description: 'Vornamen aller Mitglieder, z. B. „Anna, Ben und Clara“' },
  ...PLACEHOLDERS.filter((p) => !['{vorname}', '{nachname}', '{name}', '{instrument}'].includes(p.key)).map((p) =>
    p.key === '{seite}' || p.key === '{seiten}' ? { ...p, description: p.description.replace('der Person', 'der Gruppe') } : p,
  ),
];

/**
 * Ersetzt die Platzhalter der Person und des Exports. {seite} und {seiten} bleiben stehen: Die Seite
 * steht erst beim Schreiben ins PDF fest (siehe `PdfWriter`).
 *
 * `lesson` ist die Stunde, zu der der Text gehört; ohne sie gilt für {uhrzeit} die letzte Stunde mit Uhrzeit.
 */
export function fillPlaceholders(
  text: string,
  student: Student,
  teacher: Teacher,
  config: FeedbackConfig,
  lesson?: Lesson,
): string {
  const timedLesson = lesson ?? latestLessonWithTime(student);
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
/**
 * Personen, die zusammen Unterricht haben, auch bei verschiedenen Lehrern. Gruppentermine stehen im Kalender
 * von `teacherId`. Gruppenstunden gehören der Gruppe, nutzen die Gruppen-Abschnitte und stehen im Gruppen-PDF.
 */
export interface Group {
  id: string;
  /** Darf leer sein; dann zeigt die App die Vornamen der Mitglieder. */
  name: string;
  memberIds: string[];
  /** Immer über `groupTeacherOf` auswerten. */
  teacherId: string | null;
  /** Gruppen gelten für einen Berichtszeitraum; im nächsten werden sie neu angelegt. */
  periodId: string;
  lessons: Lesson[];
  /** Freitexte der allgemeinen Gruppen-Abschnitte (Abschnitts-ID → Text) */
  generalTexts: Record<string, string>;
  /**
   * Automatische Gruppe der Lehrkraft (`teacherId`) im Zeitraum: Mitglieder sind immer alle Personen, die sie dort
   * haben (siehe `withAutoGroups`); von Hand ändern lassen sie sich nicht.
   */
  auto?: boolean;
}

export function groupTeacherOf(group: Group, config: FeedbackConfig): Teacher {
  return config.teachers.find((t) => t.id === group.teacherId) ?? config.teachers[0];
}

export function groupMembers(group: Group, students: Student[]): Student[] {
  return students.filter((student) => group.memberIds.includes(student.id));
}

/** Name der Gruppe oder, ohne Namen, z. B. „Anna, Ben und Clara“ */
export function groupLabel(group: Group, students: Student[]): string {
  return group.name.trim() || memberNames(group, students) || 'Gruppe ohne Mitglieder';
}

/** Vornamen der Mitglieder, z. B. „Anna, Ben und Clara“; leer ohne Mitglieder */
export function memberNames(group: Group, students: Student[]): string {
  const names = groupMembers(group, students).map((student) => firstNameOf(student.name));
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} und ${names.at(-1)}`;
}

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
  /**
   * Berichtszeitraum, zu dem die Stunde gehört; gesetzt bei neuen Stunden. Überlappen sich Zeiträume, entscheidet
   * er (nicht das Datum), in welchem Bericht sie steht. Ältere Stunden: siehe `lessonPeriodId`.
   */
  periodId?: string;
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
export function lessonAt(owner: { lessons: Lesson[] }, date: string, start?: string): Lesson | undefined {
  return owner.lessons.find(
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
  /** ISO-Datum; freiwillig, um Personen gleichen Namens zu unterscheiden */
  birthDate?: string;
  /** ID eines Instruments aus `FeedbackConfig.instruments`; immer über `instrumentOf` auswerten. */
  instrumentId: string | null;
  /**
   * Berichtszeiträume, in denen die Person Unterricht hat, mit ihrem Lehrer dort (Zeitraum-ID → Lehrer-ID, `null`
   * für den ersten Lehrer). In anderen Zeiträumen ist sie inaktiv. Den Lehrer immer über `teacherOf` auswerten.
   */
  periods: Record<string, string | null>;
  /** Freitext der allgemeinen Abschnitte, gilt für alle Stunden (Abschnitts-ID → Text) */
  generalTexts: Record<string, string>;
  lessons: Lesson[];
  /** Lehrer aus Daten vor den Zeiträumen je Person; nur bis zur Umstellung (siehe `withPeriodMembership`) */
  legacyTeacherId?: string | null;
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

/** „03.05.2015“, ohne Wochentag */
export function formatShortDate(isoDate: string): string {
  return isoDate.split('-').reverse().join('.');
}

export function formatDate(isoDate: string): string {
  return new Date(isoDate + 'T00:00:00').toLocaleDateString('de-DE', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}
