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
  /** Die erste Zeile enthält Überschriften und wird nicht importiert. */
  hasHeader: boolean;
}

export interface ImportRow {
  /** Zeilennummer in der Datei (ab 1), zum Wiederfinden */
  line: number;
  name: string;
  /** Leer, wenn keine Spalte gewählt oder die Zelle leer ist; dann gilt das Standardinstrument. */
  instrument: string;
  /** Eine Person mit diesem Namen gibt es schon. */
  existing: boolean;
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
  const hasHeader = firstName !== null || lastName !== null || instrument !== null;
  // Nur eine Spalte „Name“: Sie enthält den ganzen Namen.
  if (firstName === null && lastName !== null) return { firstName: lastName, lastName: null, instrument, hasHeader };
  return { firstName: firstName ?? 0, lastName, instrument, hasHeader };
}

/** Zeilen für den Import; Zeilen ohne Namen entfallen. */
export function toImportRows(table: ImportTable, mapping: ColumnMapping, existingNames: string[]): ImportRow[] {
  const existing = new Set(existingNames.map(normalizeName));
  const cell = (row: string[], index: number | null) => (index === null ? '' : (row[index] ?? '').trim());
  return table.rows
    .map((row, index) => ({ row, line: index + 1 }))
    .slice(mapping.hasHeader ? 1 : 0)
    .map(({ row, line }) => {
      const name = [cell(row, mapping.firstName), cell(row, mapping.lastName)].filter(Boolean).join(' ');
      return { line, name, instrument: cell(row, mapping.instrument), existing: existing.has(normalizeName(name)) };
    })
    .filter((row) => row.name);
}

export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toLocaleDateString('de-DE');
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
