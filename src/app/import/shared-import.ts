import { addDays, daysFrom, minutesOf, timeOf } from '../calendar/appointments';
import { SharedAppointment } from '../calendar/shared-appointments';
import { activeTeachersOn, FeedbackConfig } from '../model';
import { findTeacher, ImportTable, normalizeName, parseDate, splitNames } from './student-import';

/** Welche Spalte was enthält; `null` heißt „nicht vorhanden“. */
export interface SharedColumnMapping {
  title: number;
  date: number;
  start: number | null;
  end: number | null;
  duration: number | null;
  location: number | null;
  teachers: number | null;
  /** Art aus dem Tabellen-Export des Kalenders; übernommen werden nur leere Zellen und „Allgemein“. */
  kind: number | null;
  /** Die erste Zeile enthält Überschriften und wird nicht importiert. */
  hasHeader: boolean;
}

/** Eine Zeile der Datei als allgemeiner Termin; mit `problem` wird sie nicht importiert. */
export interface SharedImportRow {
  /** Zeilennummer in der Datei (ab 1), zum Wiederfinden */
  line: number;
  appointment: Omit<SharedAppointment, 'id'>;
  /** Datum, wie es in der Datei steht; mit Startdatum weicht das Datum des Termins davon ab. */
  fileDate: string | null;
  /** Namen aus der Lehrer-Spalte, die zu keinem Lehrer passen */
  unknownTeachers: string[];
  problem: string | null;
  /** Einen Termin mit Bezeichnung, Datum und Beginn gibt es schon. */
  existing: boolean;
}

const DEFAULT_DURATION = 60;

/** Rät die Spalten anhand der Überschriften; ohne passende Überschrift: Bezeichnung in A, Datum in B, Beginn in C. */
export function guessSharedMapping(table: ImportTable): SharedColumnMapping {
  const header = (table.rows[0] ?? []).map((cell) => cell.toLowerCase());
  const find = (...patterns: RegExp[]) => {
    const index = header.findIndex((cell) => patterns.some((pattern) => pattern.test(cell)));
    return index >= 0 ? index : null;
  };
  const title = find(/bezeichnung/, /titel/, /termin/, /anlass/, /^name$/, /was/);
  const date = find(/datum/, /^tag$/, /date/);
  const start = find(/beginn/, /start/, /^von$/, /uhrzeit/, /^zeit$/);
  const end = find(/ende/, /^bis$/);
  const duration = find(/dauer/, /länge/, /minuten/);
  const location = find(/^ort/, /raum/, /location/);
  const teachers = find(/lehrer/, /teilnehm/, /lehrkr/);
  const kind = find(/^art$/, /^typ$/);
  const hasHeader = [title, date, start, end, duration, location, teachers, kind].some(
    (index) => index !== null,
  );
  return {
    title: title ?? 0,
    date: date ?? 1,
    start: start ?? (hasHeader ? null : 2),
    end,
    duration,
    location,
    teachers,
    kind,
    hasHeader,
  };
}

/** Zeilen der Datei ab den Überschriften, mit Zeilennummer; ganz leere Zeilen entfallen. */
function dataRows(
  table: ImportTable,
  mapping: SharedColumnMapping,
): { row: string[]; line: number }[] {
  return table.rows
    .map((row, index) => ({ row, line: index + 1 }))
    .slice(mapping.hasHeader ? 1 : 0)
    .filter(({ row }) => cell(row, mapping.title) || cell(row, mapping.date));
}

function cell(row: string[], index: number | null): string {
  return index === null ? '' : (row[index] ?? '').trim();
}

/** Zeilen einer anderen Art (Einzelunterricht, Gruppe, Blocker), z. B. aus dem Tabellen-Export des Kalenders */
function isOtherKind(row: string[], mapping: SharedColumnMapping): boolean {
  const kind = normalizeName(cell(row, mapping.kind));
  return kind !== '' && !kind.startsWith('allgemein');
}

/** Wie viele Zeilen wegen ihrer Art nicht in Frage kommen */
export function countOtherKinds(table: ImportTable, mapping: SharedColumnMapping): number {
  return dataRows(table, mapping).filter(({ row }) => isOtherKind(row, mapping)).length;
}

/**
 * Zeilen für den Import; ganz leere Zeilen und Zeilen anderer Art entfallen. Mit `startDate` liegt der früheste
 * Termin der Datei an diesem Tag, alle anderen behalten ihren Abstand in Tagen (der Wochentag kann sich ändern).
 */
export function toSharedRows(
  table: ImportTable,
  mapping: SharedColumnMapping,
  config: FeedbackConfig,
  existing: Omit<SharedAppointment, 'id'>[],
  startDate: string | null = null,
): SharedImportRow[] {
  // Vorhandene Termine und solche, die weiter oben in der Datei schon stehen
  const known = new Set(existing.map((a) => sharedKey(a.title, a.date, a.start)));
  const rows = dataRows(table, mapping)
    .filter(({ row }) => !isOtherKind(row, mapping))
    .map((entry) => ({ ...entry, fileDate: parseDate(cell(entry.row, mapping.date)) }));
  const shift = shiftTo(
    startDate,
    rows.map((r) => r.fileDate),
  );
  return rows.map(({ row, line, fileDate }) => {
    const title = cell(row, mapping.title);
    const dateCell = cell(row, mapping.date);
    const date = fileDate && addDays(fileDate, shift);
    // Steht die Uhrzeit mit im Datum („3.11.2026 15:00“), braucht es keine eigene Spalte.
    const start =
      parseTime(cell(row, mapping.start)) ?? (mapping.start === null ? parseTime(dateCell) : null);
    const durationMinutes = durationOf(start, cell(row, mapping.end), cell(row, mapping.duration));
    const { teacherIds, unknown, allTeachers } = teachersOf(cell(row, mapping.teachers), config, date);
    const problem = !title
      ? 'Bezeichnung fehlt'
      : !date
        ? 'Datum fehlt oder ist ungültig'
        : !start
          ? 'Beginn fehlt oder ist ungültig'
          : durationMinutes === null
            ? 'Ende liegt vor dem Beginn'
            : teacherIds.length === 0 && !allTeachers
              ? 'Keine bekannte Lehrkraft des Berichtszeitraums'
              : null;
    return {
      line,
      appointment: {
        title,
        date: date ?? '',
        start: start ?? '',
        durationMinutes: durationMinutes ?? DEFAULT_DURATION,
        location: cell(row, mapping.location),
        teacherIds,
        ...(allTeachers ? { allTeachers: true } : {}),
        blocksPlanning: true,
      },
      fileDate,
      unknownTeachers: unknown,
      problem,
      existing: !!date && !!start && !remember(known, sharedKey(title, date, start)),
    };
  });
}

/** Frühestes gültiges Datum der Datei */
export function earliestDate(dates: (string | null)[]): string | null {
  return dates.filter((date) => date !== null).sort()[0] ?? null;
}

/** Tage, um die alle Termine verschoben werden, damit der früheste auf `startDate` fällt */
function shiftTo(startDate: string | null, dates: (string | null)[]): number {
  const earliest = earliestDate(dates);
  return startDate && earliest ? daysFrom(earliest, startDate) : 0;
}

/** Merkt sich den Schlüssel; `false`, wenn er schon bekannt war */
function remember(known: Set<string>, key: string): boolean {
  if (known.has(key)) return false;
  known.add(key);
  return true;
}

function sharedKey(title: string, date: string, start: string): string {
  return `${normalizeName(title)}|${date}|${start}`;
}

/** „15:00“, „15.00“, „9:30 Uhr“ → „HH:MM“; ein Datum wie „3.11.2026“ zählt nicht als Uhrzeit. */
export function parseTime(text: string): string | null {
  const match = text.replace(/\d{1,2}\.\d{1,2}\.\d{2,4}/, '').match(/(\d{1,2})[:.](\d{2})/);
  if (!match) return null;
  const [hours, minutes] = [Number(match[1]), Number(match[2])];
  return hours < 24 && minutes < 60 ? timeOf(hours * 60 + minutes) : null;
}

/** Aus dem Ende oder der Dauer (Minuten oder „1:30“); ohne beides eine Stunde. `null`, wenn das Ende zu früh liegt. */
function durationOf(start: string | null, endText: string, durationText: string): number | null {
  const end = parseTime(endText);
  if (start && end) {
    const minutes = minutesOf(end) - minutesOf(start);
    return minutes > 0 ? minutes : null;
  }
  const clock = parseTime(durationText);
  if (clock) return minutesOf(clock) || DEFAULT_DURATION;
  const minutes = Number(durationText.replace(',', '.').replace(/[^\d.]/g, ''));
  return minutes > 0 ? Math.round(minutes) : DEFAULT_DURATION;
}

/**
 * Lehrkräfte aus der Zelle („Anna, Ben“, „Anna Schmidt; Ben Krause“, „Anna und Ben“): ganzer Name, Vor- oder
 * Nachname, sofern er eindeutig ist. Infrage kommen nur die Lehrkräfte des Berichtszeitraums am Tag; andere zählen
 * als unbekannt. Eine leere Zelle steht für alle Lehrkräfte des Zeitraums.
 */
function teachersOf(
  text: string,
  config: FeedbackConfig,
  date: string | null,
): { teacherIds: string[]; unknown: string[]; allTeachers?: boolean } {
  const names = splitNames(text);
  // Ohne Angabe: alle Lehrkräfte des Zeitraums, auch später dazukommende
  if (names.length === 0) return { teacherIds: [], unknown: [], allTeachers: true };
  const teacherIds = new Set<string>();
  const unknown: string[] = [];
  for (const name of names) {
    const match = findTeacher(name, date ? activeTeachersOn(config, date) : config.teachers);
    if (match) teacherIds.add(match.id);
    else unknown.push(name);
  }
  return { teacherIds: [...teacherIds], unknown };
}
