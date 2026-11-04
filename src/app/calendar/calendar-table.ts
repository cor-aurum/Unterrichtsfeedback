import { csvText } from '../csv';
import { WEEKDAY_NAMES, weekday } from './appointments';

/** Art einer Zeile; „Allgemein“ liest der Import allgemeiner Termine wieder ein. */
export type CalendarRowKind = 'Einzelunterricht' | 'Gruppe' | 'Allgemein' | 'Blocker';

/** Eine Zeile der Kalendertabelle */
export interface CalendarRow {
  kind: CalendarRowKind;
  title: string;
  /** ISO-Datum */
  date: string;
  start: string;
  end: string;
  durationMinutes: number;
  location: string;
  teachers: string[];
}

/** Überschriften wie beim Import, damit eine exportierte Datei ohne Zuordnen wieder eingelesen werden kann */
export const CALENDAR_TABLE_HEADER = [
  'Art',
  'Bezeichnung',
  'Datum',
  'Wochentag',
  'Beginn',
  'Ende',
  'Dauer (Minuten)',
  'Ort',
  'Lehrer',
];

export function sortRows(rows: CalendarRow[]): CalendarRow[] {
  return [...rows].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.start.localeCompare(b.start) ||
      a.teachers.join().localeCompare(b.teachers.join(), 'de') ||
      a.title.localeCompare(b.title, 'de'),
  );
}

/** CSV für Excel (siehe `csvText`), Daten als „03.11.2026“ */
export function toCsv(rows: CalendarRow[]): string {
  return csvText([CALENDAR_TABLE_HEADER, ...rows.map(rowCells)]);
}

function rowCells(row: CalendarRow): string[] {
  return [
    row.kind,
    row.title,
    row.date.split('-').reverse().join('.'),
    WEEKDAY_NAMES[weekday(row.date)],
    row.start,
    row.end,
    String(row.durationMinutes),
    row.location,
    row.teachers.join(', '),
  ];
}
