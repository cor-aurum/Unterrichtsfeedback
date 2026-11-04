/**
 * CSV für Excel: Semikolon als Trennzeichen, UTF-8 mit BOM, damit Umlaute in Excel richtig erscheinen,
 * Zeilenenden CRLF. Die erste Zeile sind die Überschriften.
 */
export function csvText(rows: string[][]): string {
  return '﻿' + rows.map((cells) => cells.map(csvField).join(';')).join('\r\n') + '\r\n';
}

export function csvBlob(rows: string[][]): Blob {
  return new Blob([csvText(rows)], { type: 'text/csv;charset=utf-8' });
}

/** In Anführungszeichen, sobald das Feld Trennzeichen, Anführungszeichen oder Zeilenumbrüche enthält */
function csvField(value: string): string {
  return /[";\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
