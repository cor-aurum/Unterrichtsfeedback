import { Teacher, today } from '../model';

/** Ein Tabellenblatt: Zellen als Text, Zeile für Zeile */
export interface ImportTable {
  name: string;
  rows: string[][];
}

/** Welche Spalte was enthält; `null` heißt „nicht vorhanden“. */
export interface ColumnMapping {
  firstName: number;
  lastName: number | null;
  instrument: number | null;
  /** Lehrer der Person; ohne Spalte legst du ihn im letzten Schritt fest. */
  teacher: number | null;
  /** Gruppennamen, mit Komma getrennt; die Gruppen werden ohne Mitglieder angelegt. */
  groups: number | null;
  /** Geburtsdatum, unterscheidet gleichnamige Personen */
  birthDate: number | null;
  /** Die erste Zeile enthält Überschriften und wird nicht importiert. */
  hasHeader: boolean;
}

export interface ImportRow {
  /** Zeilennummer in der Datei (ab 1), zum Wiederfinden */
  line: number;
  name: string;
  /** Leer, wenn keine Spalte gewählt oder die Zelle leer ist; dann gilt das Standardinstrument. */
  instrument: string;
  /** Lehrer laut Datei, `null` ohne Spalte oder bei unbekanntem Namen */
  teacherId: string | null;
  groups: string[];
  /** ISO-Datum; `undefined` ohne Spalte, leere oder ungültige Zelle */
  birthDate?: string;
  /** Die Zelle enthält etwas, das kein Datum ist. */
  invalidBirthDate: boolean;
  /** Diese Person (Name und Geburtsdatum, siehe `samePerson`) gibt es im Berichtszeitraum schon. */
  existing: boolean;
  /** Diese Person gibt es in einem anderen Zeitraum; sie wird übernommen statt neu angelegt. */
  formerId: string | null;
}

/** Vorhandene Person, mit der eine Zeile verglichen wird */
export interface KnownPerson {
  id: string;
  name: string;
  birthDate?: string;
  /** Im gewählten Berichtszeitraum aktiv */
  active: boolean;
}

/** Liest .xlsx (alle Blätter) oder .csv; Zellen werden zu Text, leere Zeilen entfallen. */
export async function readTables(file: File): Promise<ImportTable[]> {
  if (/\.(csv|txt)$/i.test(file.name)) {
    return [{ name: file.name, rows: parseCsv(await file.text()) }];
  }
  // Die Bibliothek wird erst beim ersten Import geladen.
  const { default: readXlsxFile } = await import('read-excel-file/browser');
  const sheets = await readXlsxFile(file);
  return sheets
    .map((sheet) => ({ name: sheet.sheet, rows: cleanRows(sheet.data.map((row) => row.map(cellText))) }))
    .filter((table) => table.rows.length > 0);
}

/** Spaltennamen für die Auswahl, z. B. „A – Vorname“ */
export function columnLabels(table: ImportTable, hasHeader: boolean): string[] {
  const width = Math.max(0, ...table.rows.map((row) => row.length));
  return Array.from({ length: width }, (_, i) => {
    const header = hasHeader ? (table.rows[0]?.[i] ?? '') : '';
    return header ? `${columnLetter(i)} – ${header}` : `Spalte ${columnLetter(i)}`;
  });
}

/** Rät die Spalten anhand der Überschriften; ohne passende Überschrift: Vorname in Spalte A. */
export function guessMapping(table: ImportTable): ColumnMapping {
  const header = (table.rows[0] ?? []).map((cell) => cell.toLowerCase());
  const find = (...patterns: RegExp[]) => {
    const index = header.findIndex((cell) => patterns.some((pattern) => pattern.test(cell)));
    return index >= 0 ? index : null;
  };
  const firstName = find(/vorname/, /first ?name/, /rufname/);
  const lastName = find(/nachname/, /familienname/, /last ?name/, /^name$/);
  const instrument = find(/instrument/, /fach/);
  const teacher = find(/lehrer/, /lehrkraft/);
  const groups = find(/gruppe/);
  const birthDate = find(/geburt/, /^geb\.?$/, /birth/);
  const hasHeader = [firstName, lastName, instrument, teacher, groups, birthDate].some((index) => index !== null);
  // Nur eine Spalte „Name“: Sie enthält den ganzen Namen.
  if (firstName === null && lastName !== null) {
    return { firstName: lastName, lastName: null, instrument, teacher, groups, birthDate, hasHeader };
  }
  return { firstName: firstName ?? 0, lastName, instrument, teacher, groups, birthDate, hasHeader };
}

/** Zeilen für den Import; Zeilen ohne Namen entfallen. */
export function toImportRows(
  table: ImportTable,
  mapping: ColumnMapping,
  known: KnownPerson[],
  teachers: Teacher[],
): ImportRow[] {
  const cell = (row: string[], index: number | null) => (index === null ? '' : (row[index] ?? '').trim());
  const date = today();
  return table.rows
    .map((row, index) => ({ row, line: index + 1 }))
    .slice(mapping.hasHeader ? 1 : 0)
    .map(({ row, line }) => {
      const name = [cell(row, mapping.firstName), cell(row, mapping.lastName)].filter(Boolean).join(' ');
      const birthText = cell(row, mapping.birthDate);
      const birthDate = parseBirthDate(birthText, date) ?? undefined;
      const person = knownPerson(known, { name, birthDate });
      return {
        line,
        name,
        ...(birthDate ? { birthDate } : {}),
        invalidBirthDate: !!birthText && !birthDate,
        instrument: cell(row, mapping.instrument),
        teacherId: findTeacher(cell(row, mapping.teacher), teachers)?.id ?? null,
        groups: splitNames(cell(row, mapping.groups)),
        existing: !!person?.active,
        formerId: person && !person.active ? person.id : null,
      };
    })
    .filter((row) => row.name);
}

/** Vorhandene Person zur Zeile; eine mit gleichem Geburtsdatum geht vor. */
function knownPerson(known: KnownPerson[], row: { name: string; birthDate?: string }): KnownPerson | undefined {
  const candidates = known.filter((person) => samePerson(person, row));
  return candidates.find((person) => person.birthDate && person.birthDate === row.birthDate) ?? candidates[0];
}

/** „Anna, Ben“, „Anna; Ben“, „Anna und Ben“ → einzelne Namen */
export function splitNames(text: string): string[] {
  return text
    .split(/[,;/+&]|\s+und\s+/i)
    .map((name) => name.trim())
    .filter(Boolean);
}

/** Lehrer zum Namen: ganzer Name, Vor- oder Nachname, sofern er eindeutig ist */
export function findTeacher(name: string, teachers: Teacher[]): Teacher | undefined {
  const wanted = normalizeName(name);
  if (!wanted) return undefined;
  const exact = teachers.filter((t) => normalizeName(t.name) === wanted);
  const partial = teachers.filter((t) => normalizeName(t.name).split(' ').includes(wanted));
  return exact.length === 1 ? exact[0] : partial.length === 1 ? partial[0] : undefined;
}

/** „3.11.2026“, „03.11.26“, „2026-11-03“, auch mit Wochentag oder Uhrzeit davor oder dahinter */
export function parseDate(text: string): string | null {
  const iso = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  const german = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  const [year, month, day] = iso
    ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    : german
      ? [
          Number(german[3]) < 100 ? 2000 + Number(german[3]) : Number(german[3]),
          Number(german[2]),
          Number(german[1]),
        ]
      : [0, 0, 0];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (!year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * Geburtsdatum aus einer Zelle wie `parseDate`; bei zweistelliger Jahreszahl liegt es nie in der Zukunft
 * („1.2.98“ ist 1998).
 */
export function parseBirthDate(text: string, today: string): string | null {
  const date = parseDate(text);
  if (!date || date <= today) return date;
  const twoDigitYear = /\d{1,2}\.\d{1,2}\.\d{2}(?!\d)/.test(text);
  return twoDigitYear ? `${Number(date.slice(0, 4)) - 100}${date.slice(4)}` : null;
}

/**
 * Gleiche Person: gleicher Name und kein widersprüchliches Geburtsdatum. Fehlt es auf einer Seite, zählt nur
 * der Name; mit zwei verschiedenen Geburtsdaten sind es zwei Personen.
 */
export function samePerson(a: { name: string; birthDate?: string }, b: { name: string; birthDate?: string }): boolean {
  return (
    normalizeName(a.name) === normalizeName(b.name) && (!a.birthDate || !b.birthDate || a.birthDate === b.birthDate)
  );
}

export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Zelle als Text. Excel liefert Datum und Uhrzeit als Datum (in UTC): reine Uhrzeiten liegen am 30./31.12.1899
 * und werden zu „14:00“, Datum mit Uhrzeit zu „3.11.2026 14:00“.
 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const time = `${String(value.getUTCHours()).padStart(2, '0')}:${String(value.getUTCMinutes()).padStart(2, '0')}`;
    if (value.getUTCFullYear() < 1901) return time;
    const date = `${value.getUTCDate()}.${value.getUTCMonth() + 1}.${value.getUTCFullYear()}`;
    return time === '00:00' ? date : `${date} ${time}`;
  }
  return String(value).trim();
}

/** Entfernt leere Zeilen am Ende und dazwischen */
function cleanRows(rows: string[][]): string[][] {
  return rows.filter((row) => row.some((cell) => cell !== ''));
}

function columnLetter(index: number): string {
  let letters = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

/**
 * Einfacher CSV-Leser: Trennzeichen Semikolon (deutsches Excel) oder Komma, je nachdem was in der ersten Zeile
 * häufiger vorkommt; Felder dürfen in Anführungszeichen stehen.
 */
export function parseCsv(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const separator = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === separator) {
      row.push(field.trim());
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field || row.length) {
    row.push(field.trim());
    rows.push(row);
  }
  return cleanRows(rows.map((r) => r.map((cell) => cell.replace(/^﻿/, ''))));
}
