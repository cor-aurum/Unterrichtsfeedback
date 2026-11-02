import type { jsPDF } from 'jspdf';
import { formatDate } from '../model';
import type { ScheduleEntry, SchedulePeriod, ScheduleTeacher } from '../pdf-export';
import { Theme } from '../theme';
import { addDays, minutesOf, mondayOf, timeOf, WEEKDAY_NAMES } from './appointments';

const PAGE_WIDTH = 297;
const PAGE_HEIGHT = 210;
const MARGIN = 12;
const HEADER_HEIGHT = 22;
const DAY_HEADER_HEIGHT = 9;
const TIME_AXIS_WIDTH = 13;
const FOOTER_HEIGHT = 8;
/** Kürzester Ausschnitt des Tages, damit wenige Termine nicht riesig werden */
const MIN_HOURS = 4;
const TEXT = '#1f2933';
const MUTED = '#66727f';
const LINE = '#d5dbe1';
const LINE_LIGHT = '#eceff2';

/** Termin in einer Tagesspalte; `lane`/`lanes` teilen die Spalte, wenn sich Termine überschneiden. */
interface Block extends ScheduleEntry {
  lane: number;
  lanes: number;
}

/**
 * Wochenplan als Tabelle im Querformat: je Lehrer und Woche eine Seite, Tage als Spalten, Uhrzeiten als Zeilen.
 * Die Unterrichtszeiten des Lehrers sind hinterlegt, damit freie Zeiten auffallen.
 */
export function writeScheduleGrid(doc: jsPDF, theme: Theme, teachers: ScheduleTeacher[], period: SchedulePeriod): void {
  const weeks = weeksOf(period);
  const showWeekend = teachers.some((teacher) =>
    teacher.days.some((day) => isWeekend(day.date)) || teacher.teachingWindows.some((w) => w.weekday >= 5),
  );
  const dayCount = showWeekend ? 7 : 5;
  let pages = 0;
  for (const teacher of teachers) {
    const range = hourRange(teacher);
    for (const monday of weeks) {
      const week = Array.from({ length: dayCount }, (_, i) => addDays(monday, i));
      if (!week.some((date) => entriesOn(teacher, date).length > 0)) continue;
      if (pages++ > 0) doc.addPage('a4', 'landscape');
      writeWeek(doc, theme, teacher, week, period, range);
    }
  }
  if (pages === 0) {
    doc.setFont('helvetica', 'italic').setFontSize(12).setTextColor(MUTED);
    doc.text(`Zwischen ${formatDate(period.from)} und ${formatDate(period.to)} sind keine Termine geplant.`, MARGIN, MARGIN + 10);
  }
  writeFooters(doc);
}

function writeWeek(
  doc: jsPDF,
  theme: Theme,
  teacher: ScheduleTeacher,
  week: string[],
  period: SchedulePeriod,
  [firstHour, lastHour]: [number, number],
): void {
  writeHeader(doc, theme, teacher, week);
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
    for (const window of teacher.teachingWindows.filter((w) => w.weekday === i)) {
      doc.rect(x, y(minutesOf(window.from)), columnWidth, (minutesOf(window.to) - minutesOf(window.from)) * mmPerMinute, 'F');
    }
    doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(inPeriod ? TEXT : MUTED);
    doc.text(`${WEEKDAY_NAMES[i]}, ${shortDate(date)}`, x + columnWidth / 2, top - 3, { align: 'center' });
  });

  writeHourLines(doc, firstHour, lastHour, left, y);

  week.forEach((date, i) => {
    const x = left + i * columnWidth;
    for (const block of withLanes(entriesOn(teacher, date))) {
      writeBlock(doc, theme, block, x, columnWidth, y);
    }
  });

  // Spaltentrenner und Rahmen
  doc.setDrawColor(LINE).setLineWidth(0.3);
  for (let i = 0; i <= week.length; i++) doc.line(left + i * columnWidth, top - DAY_HEADER_HEIGHT, left + i * columnWidth, bottom);
  doc.line(left, top, PAGE_WIDTH - MARGIN, top);
  doc.line(left, bottom, PAGE_WIDTH - MARGIN, bottom);
}

function writeHeader(doc: jsPDF, theme: Theme, teacher: ScheduleTeacher, week: string[]): void {
  doc.setFillColor(theme.primary).rect(0, 0, PAGE_WIDTH, 5, 'F');
  doc.setFont('helvetica', 'bold').setFontSize(16).setTextColor(TEXT);
  doc.text(teacher.name, MARGIN, MARGIN + 3, { baseline: 'top' });
  const nameWidth = doc.getTextWidth(teacher.name);
  if (teacher.location.trim()) {
    doc.setFont('helvetica', 'normal').setFontSize(11).setTextColor(MUTED);
    doc.text(`· ${teacher.location}`, MARGIN + nameWidth + 3, MARGIN + 4, { baseline: 'top' });
  }
  doc.setFont('helvetica', 'bold').setFontSize(12).setTextColor(theme.primaryText);
  const label = `KW ${isoWeek(week[0])} · ${formatDate(week[0])} – ${formatDate(week.at(-1)!)}`;
  doc.text(label, PAGE_WIDTH - MARGIN, MARGIN + 4, { align: 'right', baseline: 'top' });
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
  doc.setFillColor('#ffffff').setDrawColor(theme.primary).setLineWidth(0.4);
  doc.roundedRect(x, top, width, height, 1, 1, 'FD');
  doc.setFillColor(theme.primary).rect(x, top, 1.2, height, 'F');

  const textX = x + 2.4;
  const textWidth = width - 3.4;
  const time = `${timeOf(block.startMinutes)}–${timeOf(block.startMinutes + block.durationMinutes)}`;
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

function writeFooters(doc: jsPDF): void {
  const total = doc.getNumberOfPages();
  for (let page = 1; page <= total; page++) {
    doc.setPage(page);
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(MUTED);
    doc.text('Unterrichtsplan', MARGIN, PAGE_HEIGHT - MARGIN + 2);
    doc.text(`Seite ${page} von ${total}`, PAGE_WIDTH - MARGIN, PAGE_HEIGHT - MARGIN + 2, { align: 'right' });
  }
}

/** Ganze Stunden, die alle Termine und Unterrichtszeiten des Lehrers umfassen; mindestens vier Stunden. */
function hourRange(teacher: ScheduleTeacher): [number, number] {
  const starts = [
    ...teacher.days.flatMap((day) => day.entries.map((e) => e.startMinutes)),
    ...teacher.teachingWindows.map((w) => minutesOf(w.from)),
  ];
  const ends = [
    ...teacher.days.flatMap((day) => day.entries.map((e) => e.startMinutes + e.durationMinutes)),
    ...teacher.teachingWindows.map((w) => minutesOf(w.to)),
  ];
  if (starts.length === 0) return [8, 18];
  const first = Math.floor(Math.min(...starts) / 60);
  const last = Math.max(Math.ceil(Math.max(...ends) / 60), first + MIN_HOURS);
  return last > 24 ? [24 - MIN_HOURS, 24] : [first, last];
}

/** Verteilt sich überschneidende Termine nebeneinander. */
function withLanes(entries: ScheduleEntry[]): Block[] {
  const sorted = [...entries].sort((a, b) => a.startMinutes - b.startMinutes);
  const blocks: Block[] = [];
  let cluster: Block[] = [];
  let clusterEnd = -1;
  const closeCluster = () => {
    const lanes = Math.max(1, ...cluster.map((b) => b.lane + 1));
    cluster.forEach((b) => (b.lanes = lanes));
    cluster = [];
  };
  for (const entry of sorted) {
    if (entry.startMinutes >= clusterEnd) closeCluster();
    const laneEnds = new Map<number, number>();
    for (const b of cluster) laneEnds.set(b.lane, Math.max(laneEnds.get(b.lane) ?? 0, b.startMinutes + b.durationMinutes));
    let lane = 0;
    while ((laneEnds.get(lane) ?? -1) > entry.startMinutes) lane++;
    const block = { ...entry, lane, lanes: 1 };
    cluster.push(block);
    blocks.push(block);
    clusterEnd = Math.max(clusterEnd, entry.startMinutes + entry.durationMinutes);
  }
  closeCluster();
  return blocks;
}

function entriesOn(teacher: ScheduleTeacher, date: string): ScheduleEntry[] {
  return teacher.days.find((day) => day.date === date)?.entries ?? [];
}

function weeksOf(period: SchedulePeriod): string[] {
  const weeks: string[] = [];
  for (let monday = mondayOf(period.from); monday <= period.to; monday = addDays(monday, 7)) weeks.push(monday);
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
