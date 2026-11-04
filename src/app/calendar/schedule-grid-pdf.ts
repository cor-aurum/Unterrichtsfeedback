import type { jsPDF } from 'jspdf';
import { WithLane, withLanes } from './lanes';
import { CalendarPdfTexts, formatDate, formatLongDate, logoSize, PdfLogo } from '../model';
import type { DayPlan, ScheduleEntry, SchedulePeriod, ScheduleTeacher, SharedSpan } from '../pdf-export';
import { GRAYSCALE_THEME, Theme } from '../theme';
import { addDays, minutesOf, timeOf, WEEKDAY_NAMES, weekday } from './appointments';

const PAGE_WIDTH = 297;
const PAGE_HEIGHT = 210;
const MARGIN = 12;
const HEADER_HEIGHT = 22;
const DAY_HEADER_HEIGHT = 9;
const TIME_AXIS_WIDTH = 13;
const FOOTER_HEIGHT = 8;
/** Das Kopflogo bleibt im Kopfbereich, auch wenn es für die Feedback-PDFs größer eingestellt ist. */
const MAX_LOGO_HEIGHT = 12;
const MAX_LOGO_WIDTH = 60;
/** Kürzester Ausschnitt des Tages, damit wenige Termine nicht riesig werden */
const MIN_HOURS = 4;
const TEXT = '#1f2933';
const MUTED = '#66727f';
const LINE = '#d5dbe1';
const LINE_LIGHT = '#eceff2';

/** Termin in einer Tagesspalte; `lane`/`lanes` teilen die Spalte, wenn sich Termine überschneiden. */
type Block = WithLane<ScheduleEntry>;

/**
 * Wochenplan als Tabelle im Querformat: je Lehrer und Woche eine Seite, Tage als Spalten, Uhrzeiten als Zeilen.
 * Die Unterrichtszeiten des Lehrers sind hinterlegt, damit freie Zeiten auffallen.
 */
export function writeScheduleGrid(
  doc: jsPDF,
  theme: Theme,
  logo: PdfLogo | null,
  texts: CalendarPdfTexts,
  teachers: ScheduleTeacher[],
  period: SchedulePeriod,
): void {
  const weeks = weeksOf(period);
  const showWeekend = teachers.some((teacher) =>
    teacher.days.some((day) => isWeekend(day.date) && day.entries.some((e) => !e.blocked)) ||
    Object.entries(teacher.windowsByDate).some(([date, windows]) => isWeekend(date) && windows.length > 0),
  );
  let pages = 0;
  for (const teacher of teachers) {
    const range = hourRange(teacher);
    for (const weekStart of weeks) {
      // Die letzte Woche endet mit dem Zeitraum; ein Zeitraum unter einer Woche zeigt nur seine Tage.
      const week = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)).filter(
        (date) => date <= period.to && (showWeekend || !isWeekend(date)),
      );
      if (!week.some((date) => entriesOn(teacher, date).length > 0)) continue;
      if (pages++ > 0) doc.addPage('a4', 'landscape');
      writeWeek(doc, theme, logo, teacher, week, period, range);
    }
  }
  if (pages === 0) writeNoAppointments(doc, texts, period);
  writeFooters(doc, texts);
}

/** Leeres PDF: der eingestellte Hinweis und der Zeitraum */
function writeNoAppointments(doc: jsPDF, texts: CalendarPdfTexts, period: SchedulePeriod): void {
  doc.setFont('helvetica', 'italic').setFontSize(12).setTextColor(MUTED);
  doc.text(`${texts.noAppointments} (${formatDate(period.from)} – ${formatDate(period.to)})`, MARGIN, MARGIN + 10);
}

/**
 * Tagesplan aller Lehrer im Querformat: je Tag eine Seite, Lehrer als Spalten, Uhrzeiten als Zeilen. Allgemeine
 * Termine reichen über die Spalten ihrer Lehrer. Tage ohne Termine fallen weg.
 */
export function writeDayGrid(
  doc: jsPDF,
  theme: Theme,
  logo: PdfLogo | null,
  texts: CalendarPdfTexts,
  days: DayPlan[],
  period: SchedulePeriod,
): void {
  const shown = days.filter((day) => day.shared.length > 0 || day.columns.some((column) => column.entries.length > 0));
  shown.forEach((day, index) => {
    if (index > 0) doc.addPage('a4', 'landscape');
    writeDay(doc, theme, logo, texts, day);
  });
  if (shown.length === 0) writeNoAppointments(doc, texts, period);
  writeFooters(doc, texts);
}

function writeDay(doc: jsPDF, theme: Theme, logo: PdfLogo | null, texts: CalendarPdfTexts, day: DayPlan): void {
  writeTitle(doc, theme, logo, texts.dayPlanTitle, '', formatLongDate(day.date));
  const [firstHour, lastHour] = hourRangeOf(
    [...day.columns.flatMap((c) => c.entries.filter((e) => !e.blocked)), ...day.shared.map((s) => s.entry)],
    day.columns.flatMap((c) => c.teachingWindows),
  );
  const top = MARGIN + HEADER_HEIGHT + DAY_HEADER_HEIGHT;
  const bottom = PAGE_HEIGHT - MARGIN - FOOTER_HEIGHT;
  const left = MARGIN + TIME_AXIS_WIDTH;
  const columnWidth = (PAGE_WIDTH - MARGIN - left) / Math.max(1, day.columns.length);
  const mmPerMinute = (bottom - top) / ((lastHour - firstHour) * 60);
  const y = (minutes: number) => top + (minutes - firstHour * 60) * mmPerMinute;
  const columnX = (index: number) => left + index * columnWidth;

  day.columns.forEach((column, i) => {
    doc.setFillColor(theme.primaryLight);
    for (const window of column.teachingWindows) {
      doc.rect(columnX(i), y(minutesOf(window.from)), columnWidth, (minutesOf(window.to) - minutesOf(window.from)) * mmPerMinute, 'F');
    }
    // Mit Raum steht der Name etwas höher, der Raum klein darunter.
    const centerX = columnX(i) + columnWidth / 2;
    doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(TEXT);
    doc.text(fit(doc, column.name, columnWidth - 2), centerX, column.location ? top - 5 : top - 3, { align: 'center' });
    if (column.location) {
      doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(MUTED);
      doc.text(fit(doc, column.location, columnWidth - 2), centerX, top - 1.6, { align: 'center' });
    }
  });

  writeHourLines(doc, firstHour, lastHour, left, y);

  day.columns.forEach((column, i) => {
    for (const blocker of column.entries.filter((e) => e.blocked)) {
      writeBlocker(doc, blocker, columnX(i), columnWidth, y, firstHour, lastHour);
    }
  });
  // Ein allgemeiner Termin reicht als ein Kasten über benachbarte Spalten. Überschneidet er sich dort mit Unterricht,
  // bekommt er stattdessen in jeder Spalte eine eigene Bahn neben dem Unterricht, damit nichts verdeckt wird.
  const sharedInColumn = day.columns.map((): ScheduleEntry[] => []);
  for (const span of day.shared) {
    for (const [first, last] of runsOf(span.columns)) {
      const columns = Array.from({ length: last - first + 1 }, (_, k) => first + k);
      if (columns.some((i) => day.columns[i].entries.some((e) => !e.blocked && overlaps(e, span.entry)))) {
        columns.forEach((i) => sharedInColumn[i].push(span.entry));
      } else {
        writeBlock(doc, theme, { ...span.entry, lane: 0, lanes: 1 }, columnX(first), columnWidth * columns.length, y);
      }
    }
  }
  day.columns.forEach((column, i) => {
    for (const block of withLanes([...column.entries.filter((e) => !e.blocked), ...sharedInColumn[i]])) {
      writeBlock(doc, theme, block, columnX(i), columnWidth, y);
    }
  });

  doc.setDrawColor(LINE).setLineWidth(0.3);
  for (let i = 0; i <= day.columns.length; i++) doc.line(columnX(i), top - DAY_HEADER_HEIGHT, columnX(i), bottom);
  doc.line(left, top, PAGE_WIDTH - MARGIN, top);
  doc.line(left, bottom, PAGE_WIDTH - MARGIN, bottom);
}

function overlaps(a: ScheduleEntry, b: ScheduleEntry): boolean {
  return a.startMinutes < b.startMinutes + b.durationMinutes && b.startMinutes < a.startMinutes + a.durationMinutes;
}

/** Zusammenhängende Spalten, z. B. [0, 1, 3] → [[0, 1], [3, 3]] */
function runsOf(columns: SharedSpan['columns']): [number, number][] {
  const sorted = [...columns].sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const column of sorted) {
    const last = runs.at(-1);
    if (last && column === last[1] + 1) last[1] = column;
    else runs.push([column, column]);
  }
  return runs;
}

function writeWeek(
  doc: jsPDF,
  theme: Theme,
  logo: PdfLogo | null,
  teacher: ScheduleTeacher,
  week: string[],
  period: SchedulePeriod,
  [firstHour, lastHour]: [number, number],
): void {
  writeHeader(doc, theme, logo, teacher, week);
  const top = MARGIN + HEADER_HEIGHT + DAY_HEADER_HEIGHT;
  const bottom = PAGE_HEIGHT - MARGIN - FOOTER_HEIGHT;
  const left = MARGIN + TIME_AXIS_WIDTH;
  const columnWidth = (PAGE_WIDTH - MARGIN - left) / week.length;
  const mmPerMinute = (bottom - top) / ((lastHour - firstHour) * 60);
  const y = (minutes: number) => top + (minutes - firstHour * 60) * mmPerMinute;

  week.forEach((date, i) => {
    const x = left + i * columnWidth;
    const inPeriod = date >= period.from && date <= period.to;
    // Unterrichtszeiten hell hinterlegen
    doc.setFillColor(theme.primaryLight);
    for (const window of teacher.windowsByDate[date] ?? []) {
      doc.rect(x, y(minutesOf(window.from)), columnWidth, (minutesOf(window.to) - minutesOf(window.from)) * mmPerMinute, 'F');
    }
    doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(inPeriod ? TEXT : MUTED);
    doc.text(`${WEEKDAY_NAMES[weekday(date)]}, ${shortDate(date)}`, x + columnWidth / 2, top - 3, { align: 'center' });
  });

  writeHourLines(doc, firstHour, lastHour, left, y);

  week.forEach((date, i) => {
    const x = left + i * columnWidth;
    const entries = entriesOn(teacher, date);
    for (const blocker of entries.filter((e) => e.blocked)) {
      writeBlocker(doc, blocker, x, columnWidth, y, firstHour, lastHour);
    }
    for (const block of withLanes(entries.filter((e) => !e.blocked))) {
      writeBlock(doc, theme, block, x, columnWidth, y);
    }
  });

  // Spaltentrenner und Rahmen
  doc.setDrawColor(LINE).setLineWidth(0.3);
  for (let i = 0; i <= week.length; i++) doc.line(left + i * columnWidth, top - DAY_HEADER_HEIGHT, left + i * columnWidth, bottom);
  doc.line(left, top, PAGE_WIDTH - MARGIN, top);
  doc.line(left, bottom, PAGE_WIDTH - MARGIN, bottom);
}

function writeHeader(doc: jsPDF, theme: Theme, logo: PdfLogo | null, teacher: ScheduleTeacher, week: string[]): void {
  const [first, last] = [week[0], week.at(-1)!];
  // Beginnt die Woche nicht am Montag, reicht sie in die nächste Kalenderwoche.
  const weeks = isoWeek(first) === isoWeek(last) ? `KW ${isoWeek(first)}` : `KW ${isoWeek(first)}/${isoWeek(last)}`;
  writeTitle(doc, theme, logo, teacher.name, teacher.location, `${weeks} · ${formatDate(first)} – ${formatDate(last)}`);
}

/** Band, Logo, Überschrift mit Zusatz (z. B. dem Raum) links und Zeitangabe rechts */
function writeTitle(doc: jsPDF, theme: Theme, logo: PdfLogo | null, title: string, detail: string, when: string): void {
  // Schwarzweiß: dünne Linie statt farbigem Band
  doc.setFillColor(theme.primary).rect(0, 0, PAGE_WIDTH, theme === GRAYSCALE_THEME ? 0.8 : 5, 'F');
  const { left, right } = writeLogo(doc, logo);
  doc.setFont('helvetica', 'bold').setFontSize(16).setTextColor(TEXT);
  doc.text(title, left, MARGIN + 3, { baseline: 'top' });
  const titleWidth = doc.getTextWidth(title);
  if (detail.trim()) {
    doc.setFont('helvetica', 'normal').setFontSize(11).setTextColor(MUTED);
    doc.text(`· ${detail}`, left + titleWidth + 3, MARGIN + 4, { baseline: 'top' });
  }
  doc.setFont('helvetica', 'bold').setFontSize(12).setTextColor(theme.primaryText);
  doc.text(when, right, MARGIN + 4, { align: 'right', baseline: 'top' });
}

/**
 * Kopflogo oben links, mittig oder rechts. Liefert, wo Lehrername (links) und Woche (rechts) daneben noch
 * beginnen bzw. enden.
 */
function writeLogo(doc: jsPDF, logo: PdfLogo | null): { left: number; right: number } {
  const edges = { left: MARGIN, right: PAGE_WIDTH - MARGIN };
  if (!logo) return edges;
  const { width, height } = logoSize(logo, Math.min(logo.heightMm, MAX_LOGO_HEIGHT), MAX_LOGO_WIDTH);
  const x = { left: MARGIN, center: (PAGE_WIDTH - width) / 2, right: PAGE_WIDTH - MARGIN - width }[logo.align];
  doc.addImage(logo.dataUrl, logo.dataUrl.startsWith('data:image/png') ? 'PNG' : 'JPEG', x, MARGIN, width, height);
  if (logo.align === 'left') edges.left += width + 4;
  if (logo.align === 'right') edges.right -= width + 4;
  return edges;
}

function writeHourLines(doc: jsPDF, firstHour: number, lastHour: number, left: number, y: (m: number) => number): void {
  for (let hour = firstHour; hour <= lastHour; hour++) {
    doc.setDrawColor(LINE).setLineWidth(0.2).line(left, y(hour * 60), PAGE_WIDTH - MARGIN, y(hour * 60));
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(MUTED);
    doc.text(timeOf(hour * 60), left - 2, y(hour * 60), { align: 'right', baseline: 'middle' });
    if (hour < lastHour) {
      doc.setDrawColor(LINE_LIGHT).setLineWidth(0.1).line(left, y(hour * 60 + 30), PAGE_WIDTH - MARGIN, y(hour * 60 + 30));
    }
  }
}

/** Termin als Kasten; Uhrzeit und Name stehen darin, so weit der Platz reicht. */
function writeBlock(doc: jsPDF, theme: Theme, block: Block, columnX: number, columnWidth: number, y: (m: number) => number): void {
  const laneWidth = columnWidth / block.lanes;
  const x = columnX + block.lane * laneWidth + 0.6;
  const width = laneWidth - 1.2;
  const top = y(block.startMinutes) + 0.3;
  const height = y(block.startMinutes + block.durationMinutes) - top - 0.3;
  // Allgemeine Termine: hell gefüllt mit dunklerem Rahmen, damit sie sich vom Unterricht abheben
  const accent = block.shared ? theme.primaryText : theme.primary;
  doc.setFillColor(block.shared ? theme.primaryLight : '#ffffff').setDrawColor(accent).setLineWidth(block.shared ? 0.6 : 0.4);
  doc.roundedRect(x, top, width, height, 1, 1, 'FD');
  doc.setFillColor(accent).rect(x, top, 1.2, height, 'F');

  const textX = x + 2.4;
  const textWidth = width - 3.4;
  const time = `${timeOf(block.startMinutes)}–${timeOf(block.startMinutes + block.durationMinutes)}`;
  if (block.shared) {
    // Allgemeine Termine knapp: Zeit und Bezeichnung in einer Zeile oben im Kasten – passt die Zeile nicht (z. B.
    // in einer schmalen Bahn neben Unterricht), stehen sie wie beim Unterricht untereinander.
    doc.setFont('helvetica', 'bold').setFontSize(7.5).setTextColor(TEXT);
    const line = `${time} ${block.name}`;
    if (doc.getTextWidth(line) <= textWidth || height < 7) {
      doc.text(fit(doc, line, textWidth), textX, top + Math.min(height / 2, 2.6), { baseline: 'middle' });
      return;
    }
  }
  if (height < 7) {
    doc.setFont('helvetica', 'bold').setFontSize(7).setTextColor(TEXT);
    doc.text(fit(doc, `${timeOf(block.startMinutes)} ${block.name}`, textWidth), textX, top + height / 2, { baseline: 'middle' });
    return;
  }
  doc.setFont('helvetica', 'normal').setFontSize(7).setTextColor(theme.primaryText);
  doc.text(fit(doc, time, textWidth), textX, top + 1.2, { baseline: 'top' });
  doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(TEXT);
  const lines = doc.splitTextToSize(block.name, textWidth) as string[];
  const lineHeight = 3.6;
  const room = Math.max(1, Math.floor((height - 4.6) / lineHeight));
  // Passt nicht alles, bekommt die letzte Zeile den Rest, gekürzt mit „…“.
  const shown = lines.length > room ? [...lines.slice(0, room - 1), lines.slice(room - 1).join(' ')] : lines;
  shown.forEach((line, i) => doc.text(fit(doc, line, textWidth), textX, top + 4.4 + i * lineHeight, { baseline: 'top' }));
}

/** Blocker als graue, schraffierte Fläche über die ganze Spalte, auf den sichtbaren Ausschnitt begrenzt */
function writeBlocker(
  doc: jsPDF,
  entry: ScheduleEntry,
  x: number,
  width: number,
  y: (minutes: number) => number,
  firstHour: number,
  lastHour: number,
): void {
  const start = Math.max(entry.startMinutes, firstHour * 60);
  const end = Math.min(entry.startMinutes + entry.durationMinutes, lastHour * 60);
  if (end <= start) return;
  const [top, bottom] = [y(start), y(end)];
  doc.setFillColor('#eef0f2').rect(x, top, width, bottom - top, 'F');
  doc.setDrawColor('#c9ced4').setLineWidth(0.2);
  // Schraffur: diagonale Linien, auf die Fläche zugeschnitten
  for (let offset = -(bottom - top); offset < width; offset += 4) {
    const x1 = x + Math.max(0, offset);
    const y1 = top + Math.max(0, -offset);
    const length = Math.min(width - Math.max(0, offset), bottom - top - Math.max(0, -offset));
    if (length > 0) doc.line(x1, y1, x1 + length, y1 + length);
  }
  doc.setFont('helvetica', 'bold').setFontSize(8).setTextColor(MUTED);
  doc.text(fit(doc, entry.name, width - 3), x + 1.5, top + 1.5, { baseline: 'top' });
}

function writeFooters(doc: jsPDF, texts: CalendarPdfTexts): void {
  const total = doc.getNumberOfPages();
  for (let page = 1; page <= total; page++) {
    doc.setPage(page);
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(MUTED);
    if (texts.footer.trim()) doc.text(texts.footer, MARGIN, PAGE_HEIGHT - MARGIN + 2);
    doc.text(`Seite ${page} von ${total}`, PAGE_WIDTH - MARGIN, PAGE_HEIGHT - MARGIN + 2, { align: 'right' });
  }
}

/** Ganze Stunden, die alle Termine und Unterrichtszeiten des Lehrers umfassen; mindestens vier Stunden. */
function hourRange(teacher: ScheduleTeacher): [number, number] {
  return hourRangeOf(
    teacher.days.flatMap((day) => day.entries.filter((e) => !e.blocked)),
    Object.values(teacher.windowsByDate).flat(),
  );
}

function hourRangeOf(appointments: ScheduleEntry[], windows: { from: string; to: string }[]): [number, number] {
  const starts = [...appointments.map((e) => e.startMinutes), ...windows.map((w) => minutesOf(w.from))];
  const ends = [...appointments.map((e) => e.startMinutes + e.durationMinutes), ...windows.map((w) => minutesOf(w.to))];
  if (starts.length === 0) return [8, 18];
  const first = Math.floor(Math.min(...starts) / 60);
  const last = Math.max(Math.ceil(Math.max(...ends) / 60), first + MIN_HOURS);
  return last > 24 ? [24 - MIN_HOURS, 24] : [first, last];
}

function entriesOn(teacher: ScheduleTeacher, date: string): ScheduleEntry[] {
  return teacher.days.find((day) => day.date === date)?.entries ?? [];
}

/** Wochen ab dem Beginn des Zeitraums; jede beginnt am selben Wochentag wie er. */
function weeksOf(period: SchedulePeriod): string[] {
  const weeks: string[] = [];
  for (let start = period.from; start <= period.to; start = addDays(start, 7)) weeks.push(start);
  return weeks;
}

function isWeekend(date: string): boolean {
  const day = new Date(date + 'T00:00:00Z').getUTCDay();
  return day === 0 || day === 6;
}

/** Kalenderwoche nach ISO 8601: Woche mit dem Donnerstag zählt zum Jahr. */
function isoWeek(date: string): number {
  const day = new Date(date + 'T00:00:00Z');
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  return Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

function shortDate(date: string): string {
  return `${Number(date.slice(8, 10))}.${Number(date.slice(5, 7))}.`;
}

/** Kürzt Text mit „…“, bis er in die Breite passt. */
function fit(doc: jsPDF, text: string, width: number): string {
  if (doc.getTextWidth(text) <= width) return text;
  let shortened = text;
  while (shortened.length > 1 && doc.getTextWidth(shortened + '…') > width) shortened = shortened.slice(0, -1);
  return shortened + '…';
}
