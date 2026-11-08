import { inject, Injectable } from '@angular/core';
import type { jsPDF } from 'jspdf';
import { ActiveTeacher } from './active-teacher';
import {
  BlockContent,
  BlockImage,
  BlockPosition,
  configForTeacher,
  contentFor,
  FeedbackConfig,
  fillPlaceholders,
  FixedBlock,
  formatLongDate,
  Group,
  groupLabel,
  ImageAlign,
  instrumentOf,
  Lesson,
  locationIn,
  logoSize,
  memberNames,
  PdfLayout,
  PdfLogo,
  ReportPeriodEntry,
  Section,
  Student,
  Teacher,
  teacherOf,
  TeachingWindow,
  today,
} from './model';
import { ReportPeriod } from './report-period';
import { openFile, safeFileName, saveFile } from './save-file';
import { sortedLessons } from './students.store';
import { GRAYSCALE_THEME, Theme, themeFrom } from './theme';

const PAGE_WIDTH = 210;
const PAGE_HEIGHT = 297;
const MARGIN = 20;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
/** Unterhalb dieser Höhe beginnt die Fußzeile. */
const CONTENT_BOTTOM = PAGE_HEIGHT - 22;
/** Senkrechte Linie links, an der die Unterrichtsstunden wie auf einer Zeitleiste hängen. */
const RAIL_X = MARGIN + 2;
const LESSON_INDENT = 8;
/** Kleiner als diese Höhe in mm wird ein Bild am Ende nicht, sonst wäre es nicht mehr erkennbar. */
const MIN_SHRUNK_IMAGE_HEIGHT = 15;

interface PdfColors {
  /** Schwarzweiß: statt des farbigen Bands oben nur eine dünne Linie */
  inkSaving: boolean;
  accent: string;
  accentText: string;
  rail: string;
  text: string;
  muted: string;
}

/** Farben des PDFs aus der Themenfarbe, im Schwarzweißmodus Grautöne */
export function pdfTheme(config: FeedbackConfig): Theme {
  return config.pdfLayout.grayscale ? GRAYSCALE_THEME : themeFrom(config.themeColor);
}

function pdfColors(theme: Theme): PdfColors {
  return {
    inkSaving: theme === GRAYSCALE_THEME,
    accent: theme.primary,
    accentText: theme.primaryText,
    rail: theme.rail,
    text: '#1f2933',
    muted: '#66727f',
  };
}

@Injectable({ providedIn: 'root' })
export class PdfExport {
  private readonly reportPeriod = inject(ReportPeriod);
  private readonly activeTeacher = inject(ActiveTeacher);

  /** Wer das PDF erstellt, bekommt es in seiner persönlichen Farbe. */
  private personal(config: FeedbackConfig): FeedbackConfig {
    return { ...config, themeColor: this.activeTeacher.color() };
  }

  /**
   * `open` öffnet das PDF in der Android-App direkt; im Browser wird es in beiden Fällen heruntergeladen.
   * Varianten und {zeitraum} richten sich nach dem Berichtszeitraum dieses Geräts.
   */
  async export(config: FeedbackConfig, students: Student[], fileName: string, action: 'open' | 'share' = 'share'): Promise<void> {
    config = this.personal(config);
    const prepared = await forPrint(config);
    const period = this.reportPeriod.period();
    return this.exportRecipients(prepared, students.map((student) => recipient(prepared, student, period)), fileName, action);
  }

  /**
   * Gruppen-PDF: je Gruppe ein Abschnitt mit den Gruppen-Abschnitten und festen Gruppen-Inhalten. Die Gruppe
   * wird dafür wie eine Person geschrieben (siehe `groupRecipient`).
   */
  async exportGroups(
    config: FeedbackConfig,
    groups: Group[],
    students: Student[],
    fileName: string,
    action: 'open' | 'share' = 'share',
  ): Promise<void> {
    config = this.personal(config);
    const prepared = await forPrint(config);
    const period = this.reportPeriod.period();
    const recipients = groups.map((group) => groupRecipient(group, students, prepared, period));
    return this.exportRecipients(prepared, recipients, fileName, action);
  }

  private async exportRecipients(
    config: FeedbackConfig,
    recipients: Recipient[],
    fileName: string,
    action: 'open' | 'share',
  ): Promise<void> {
    // jsPDF ist groß und wird deshalb erst beim ersten Export geladen.
    const { jsPDF } = await import('jspdf');
    const colors = pdfColors(pdfTheme(config));
    const render = (pageCounts?: number[]) => {
      const writer = new PdfWriter(new jsPDF({ unit: 'mm', format: 'a4' }), colors, config.pdfLayout, pageCounts);
      recipients.forEach((recipient) => writeStudent(writer, recipient));
      writer.addFooters();
      return writer;
    };
    // {seiten} im Text steht erst fest, wenn alle Seiten geschrieben sind. Deshalb zählt ein erster
    // Durchlauf die Seiten je Person, der zweite schreibt die echten Zahlen.
    const writer = render(render().pageCounts());
    await deliver(`${safeFileName(fileName)}_${today()}.pdf`, writer.toBlob(), action);
  }

  /** Terminliste aller Lehrer: je Lehrer Name und Raum, darunter je Tag die Termine mit Uhrzeit und Person. */
  async exportSchedule(
    config: FeedbackConfig,
    teachers: ScheduleTeacher[],
    range: SchedulePeriod,
    action: 'open' | 'share',
  ): Promise<void> {
    config = this.personal(config);
    const list = await listDocument(config, config.calendarPdf.listTitle, range);
    teachers.forEach((teacher, index) => writeScheduleTeacher(list, teacher, index === 0, true));
    list.writer.addFooters();
    await deliver(`Unterrichtsplan_${range.from}_${range.to}.pdf`, list.writer.toBlob(), action);
  }

  /**
   * Terminliste ohne Einzelunterricht: Gruppentermine und allgemeine Termine aller Lehrer, Tag für Tag. Jeder
   * Eintrag nennt seinen Raum (siehe `ScheduleEntry.name`).
   */
  async exportAppointmentList(config: FeedbackConfig, days: ScheduleDay[], range: SchedulePeriod, action: 'open' | 'share'): Promise<void> {
    config = this.personal(config);
    const list = await listDocument(config, config.calendarPdf.eventListTitle, range);
    writeScheduleDays(list, days, true, () => undefined);
    list.writer.addFooters();
    await deliver(`Termine_${range.from}_${range.to}.pdf`, list.writer.toBlob(), action);
  }

  /**
   * Nur Einzelunterricht, alle Lehrer: Jeder Lehrer beginnt auf einer neuen Seite, seine Tage folgen darunter ohne
   * Seitenwechsel.
   */
  async exportIndividualList(
    config: FeedbackConfig,
    teachers: ScheduleTeacher[],
    range: SchedulePeriod,
    action: 'open' | 'share',
  ): Promise<void> {
    config = this.personal(config);
    const list = await listDocument(config, config.calendarPdf.individualListTitle, range);
    teachers.forEach((teacher, index) => writeScheduleTeacher(list, teacher, index === 0, false));
    list.writer.addFooters();
    await deliver(`Einzelunterricht_${range.from}_${range.to}.pdf`, list.writer.toBlob(), action);
  }

  /** Tagesplan im Querformat: je Tag eine Seite mit allen Lehrern als Spalten (siehe `schedule-grid-pdf.ts`). */
  async exportDayGrid(config: FeedbackConfig, days: DayPlan[], range: SchedulePeriod, action: 'open' | 'share'): Promise<void> {
    config = this.personal(config);
    const [{ jsPDF }, { writeDayGrid }, prepared] = await Promise.all([
      import('jspdf'),
      import('./calendar/schedule-grid-pdf'),
      forPrint(config),
    ]);
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
    writeDayGrid(doc, pdfTheme(config), prepared.pdfLayout.headerLogo, config.calendarPdf, days, range);
    await deliver(`Tagesplan_${range.from}_${range.to}.pdf`, doc.output('blob'), action);
  }

  /** Wochenplan als Tabelle im Querformat, je Lehrer und Woche eine Seite (siehe `schedule-grid-pdf.ts`). */
  async exportScheduleGrid(
    config: FeedbackConfig,
    teachers: ScheduleTeacher[],
    range: SchedulePeriod,
    action: 'open' | 'share',
  ): Promise<void> {
    config = this.personal(config);
    const [{ jsPDF }, { writeScheduleGrid }, prepared] = await Promise.all([
      import('jspdf'),
      import('./calendar/schedule-grid-pdf'),
      forPrint(config),
    ]);
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
    writeScheduleGrid(doc, pdfTheme(config), prepared.pdfLayout.headerLogo, config.calendarPdf, teachers, range);
    await deliver(`Wochenplan_${range.from}_${range.to}.pdf`, doc.output('blob'), action);
  }
}

/** Terminliste im Hochformat; `newPage` beginnt eine Seite mit derselben großen Überschrift wie die erste. */
interface ListDocument {
  writer: PdfWriter;
  newPage(): void;
  noAppointments: string;
}

async function listDocument(config: FeedbackConfig, title: string, range: SchedulePeriod): Promise<ListDocument> {
  const [{ jsPDF }, prepared] = await Promise.all([import('jspdf'), forPrint(config)]);
  const writer = new PdfWriter(new jsPDF({ unit: 'mm', format: 'a4' }), pdfColors(pdfTheme(config)), prepared.pdfLayout);
  const heading = [title, range.label].filter((part) => part.trim()).join(' · ');
  writer.beginSection(heading, { left: config.calendarPdf.footer, center: '', right: 'Seite {seite} von {seiten}' });
  const writeTitle = () => {
    if (title.trim()) writer.text(title, { size: 22, bold: true });
    writer.text(range.label, { size: 14, color: writer.colors.accentText, gapAfter: 0 });
    writer.endTitleArea();
    writer.gap(10, false);
  };
  writeTitle();
  return {
    writer,
    noAppointments: config.calendarPdf.noAppointments,
    newPage: () => {
      writer.titlePage();
      writeTitle();
    },
  };
}

/**
 * Jeder Tag eines Lehrers steht auf einer eigenen Seite, mit Name und Raum darüber. Der erste Lehrer beginnt direkt
 * unter der Überschrift der Liste.
 */
function writeScheduleTeacher(list: ListDocument, teacher: ScheduleTeacher, first: boolean, pagePerDay: boolean): void {
  const { writer } = list;
  if (!first) list.newPage();
  const heading = () => {
    writer.text(teacher.name, { size: 15, bold: true, gapAfter: 0.5 });
    if (teacher.location.trim()) {
      writer.text(teacher.location, { size: 11, color: writer.colors.muted, gapAfter: 0 });
    }
    writer.gap(4, false);
  };
  heading();
  writeScheduleDays(list, teacher.days, pagePerDay, heading);
}

/**
 * Je Tag das Datum und darunter die Termine mit Uhrzeit; jeder Tag nach dem ersten beginnt auf einer neuen Seite,
 * unter dem Kopf, den `heading` dort schreibt.
 */
function writeScheduleDays(list: ListDocument, days: ScheduleDay[], pagePerDay: boolean, heading: () => void): void {
  const { writer } = list;
  if (days.length === 0) {
    writer.text(list.noAppointments, { size: 11, italic: true, color: writer.colors.muted });
  }
  days.forEach((day, index) => {
    if (index > 0 && pagePerDay) {
      list.newPage();
      heading();
    } else if (index > 0) {
      // Fortlaufend: Abstand zum vorigen Tag; ein Tag beginnt nicht ganz unten auf der Seite.
      writer.gap(4, false);
      writer.keepTogether(16);
    }
    writer.text(formatLongDate(day.date), { size: 12, bold: true, color: writer.colors.accentText, gapAfter: 1.5 });
    for (const entry of day.entries) {
      writer.text(`${entry.time}    ${entry.name}`, { size: 11, lineHeight: 0.53, indent: 4, gapAfter: 0.5 });
    }
  });
}

/** Ein Lehrer in der Terminliste mit seinen Terminen im Zeitraum. */
export interface ScheduleTeacher {
  name: string;
  location: string;
  /** Für den Wochenplan: Unterrichtszeiten je Tag im Zeitraum, sie werden hinterlegt. */
  windowsByDate: Record<string, { from: string; to: string }[]>;
  days: ScheduleDay[];
}

/** Zeitraum der Terminliste als ISO-Daten und lesbarer Text, z. B. „2. November – 8. November 2026“ */
export interface SchedulePeriod {
  from: string;
  to: string;
  label: string;
}

export interface ScheduleDay {
  date: string;
  entries: ScheduleEntry[];
}

export interface ScheduleEntry {
  /** z. B. „14:00–14:45“ */
  time: string;
  name: string;
  startMinutes: number;
  durationMinutes: number;
  /** Blocker des Lehrers statt eines Termins */
  blocked?: boolean;
  /** Gruppentermin */
  group?: boolean;
  /** Allgemeiner Termin mehrerer Lehrer, z. B. eine Konferenz */
  shared?: boolean;
}

/** Ein Tag im Tagesplan aller Lehrer: je Lehrer eine Spalte, allgemeine Termine über die Spalten ihrer Lehrer */
export interface DayPlan {
  date: string;
  columns: DayColumn[];
  shared: SharedSpan[];
}

export interface DayColumn {
  name: string;
  /** Raum oder Ort des Lehrers; steht im Tagesplan unter dem Namen */
  location: string;
  /** Unterrichtszeiten an diesem Tag */
  teachingWindows: { from: string; to: string }[];
  /** Einzel- und Gruppenunterricht sowie Blocker */
  entries: ScheduleEntry[];
}

/** Allgemeiner Termin mit den Spalten (Indizes in `DayPlan.columns`) der beteiligten Lehrer */
export interface SharedSpan {
  entry: ScheduleEntry;
  columns: number[];
}

/** Empfänger eines Abschnitts im PDF: eine Person mit ihrer Konfiguration oder eine Gruppe (siehe `groupRecipient`) */
interface Recipient {
  config: FeedbackConfig;
  student: Student;
  /** Lehrer im Berichtszeitraum, für die Platzhalter */
  teacher: Teacher;
  /** Wählt die Varianten der festen Inhalte */
  period: ReportPeriodEntry;
}

/**
 * Platzhalter, die für alle Texte eines Empfängers gleich sind, werden vorab in Konfiguration und Notizen
 * ersetzt: {zeitraum} und, was `fill` zusätzlich ersetzt. Die übrigen übernimmt `fillPlaceholders`.
 */
function recipient(
  config: FeedbackConfig,
  student: Student,
  period: ReportPeriodEntry,
  fill: (text: string) => string = (text) => text,
): Recipient {
  const teacher = teacherOf(student, config, period.id);
  const fillAll = (text: string) =>
    fill(text).replace(/\{zeitraum\}/gi, period.name).replace(/\{ort\}/gi, locationIn(teacher, period.id));
  const own = configForTeacher(config, teacher.id);
  return { config: withConfigTexts(own, fillAll), student: withStudentTexts(student, fillAll), teacher, period };
}

function withConfigTexts(config: FeedbackConfig, fill: (text: string) => string): FeedbackConfig {
  const fillContent = <T extends { text: string }>(content: T): T => ({ ...content, text: fill(content.text) });
  const layout = config.pdfLayout;
  return {
    ...config,
    title: fill(config.title),
    pdfLayout: {
      ...layout,
      runningHeader: fill(layout.runningHeader),
      subtitle: fill(layout.subtitle),
      footerLeft: fill(layout.footerLeft),
      footerCenter: fill(layout.footerCenter),
      footerRight: fill(layout.footerRight),
    },
    blocks: config.blocks.map((block) => ({ ...fillContent(block), variants: block.variants.map(fillContent) })),
    sections: config.sections.map((section) => ({ ...section, title: fill(section.title), items: section.items.map(fillContent) })),
  };
}

function withStudentTexts(student: Student, fill: (text: string) => string): Student {
  const fillTexts = (texts: Record<string, string>) =>
    Object.fromEntries(Object.entries(texts).map(([key, text]) => [key, fill(text)]));
  return {
    ...student,
    generalTexts: fillTexts(student.generalTexts),
    lessons: student.lessons.map((lesson) => ({ ...lesson, texts: fillTexts(lesson.texts) })),
  };
}

/**
 * Schreibt eine Gruppe wie eine Person: Name ist der Gruppenname, Stunden sind die Gruppenstunden, Abschnitte und
 * feste Inhalte die der Gruppen. {gruppe} und {mitglieder} werden vorab in allen Texten ersetzt;
 * {name}/{vorname} ergeben den Gruppennamen.
 */
function groupRecipient(group: Group, students: Student[], config: FeedbackConfig, period: ReportPeriodEntry): Recipient {
  const label = groupLabel(group, students);
  const members = memberNames(group, students);
  const groupConfig = { ...config, blocks: config.groupBlocks, sections: config.groupSections };
  const asStudent: Student = {
    id: group.id,
    name: label,
    instrumentId: null,
    periods: { [period.id]: group.teacherId },
    generalTexts: group.generalTexts,
    lessons: group.lessons,
  };
  return recipient(groupConfig, asStudent, period, (text) =>
    text.replace(/\{gruppe\}/gi, label).replace(/\{mitglieder\}/gi, members || label),
  );
}

/**
 * Bereitet die Bilder für jsPDF vor: Das App-Logo wird als Data-URL eingebettet, im Schwarzweißmodus werden die
 * Bilder der festen Inhalte und die Logos in Graustufen umgerechnet.
 */
async function forPrint(config: FeedbackConfig): Promise<FeedbackConfig> {
  const grayscale = config.pdfLayout.grayscale;
  const printableLogo = async (logo: PdfLogo | null) =>
    logo && (grayscale || !logo.dataUrl.startsWith('data:'))
      ? { ...logo, dataUrl: await printableDataUrl(logo.dataUrl, grayscale) }
      : logo;
  const pdfLayout = {
    ...config.pdfLayout,
    headerLogo: await printableLogo(config.pdfLayout.headerLogo),
    footerLogo: await printableLogo(config.pdfLayout.footerLogo),
  };
  if (!grayscale) return { ...config, pdfLayout };
  const gray = async <T extends BlockContent>(content: T): Promise<T> =>
    content.image ? { ...content, image: { ...content.image, dataUrl: await printableDataUrl(content.image.dataUrl, true) } } : content;
  const blocks = (list: FixedBlock[]) =>
    Promise.all(list.map(async (block) => ({ ...(await gray(block)), variants: await Promise.all(block.variants.map(gray)) })));
  return {
    ...config,
    blocks: await blocks(config.blocks),
    groupBlocks: await blocks(config.groupBlocks),
    pdfLayout,
  };
}

/** Lädt ein Bild (Data-URL oder Datei der App) und liefert es als Data-URL, auf Wunsch in Graustufen. */
function printableDataUrl(source: string, grayscale: boolean): Promise<string> {
  const png = source.startsWith('data:image/png') || source.endsWith('.png');
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      if (grayscale) toGrayscale(context, canvas.width, canvas.height);
      resolve(canvas.toDataURL(png ? 'image/png' : 'image/jpeg', 0.9));
    };
    image.onerror = () => reject(new Error('Bild konnte nicht geladen werden.'));
    image.src = source;
  });
}

function toGrayscale(context: CanvasRenderingContext2D, width: number, height: number): void {
  // Pixelweise statt mit `context.filter`, das ältere Safari-Versionen nicht kennen
  const pixels = context.getImageData(0, 0, width, height);
  const data = pixels.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    data[i] = data[i + 1] = data[i + 2] = gray;
  }
  context.putImageData(pixels, 0, 0);
}

function deliver(fileName: string, pdf: Blob, action: 'open' | 'share'): Promise<void> {
  return action === 'open' ? openFile(fileName, pdf) : saveFile(fileName, pdf);
}

/**
 * Mehrere Stunden erscheinen als Zeitleiste mit Datum je Stunde. Bei nur einer Stunde entfällt die
 * Zeitleiste und das Datum steht im Kopf. Hat keine Stunde eigene Notizen, entfällt der Teil mit den
 * Stunden ganz.
 */
function writeStudent(writer: PdfWriter, recipient: Recipient): void {
  const lessons = sortedLessons(recipient.student);
  writeHeader(writer, recipient, lessons);
  writeFixedBlocks(writer, recipient, 'start');
  writeGeneralPart(writer, recipient, lessons);

  if (lessons.length === 0) {
    writer.text('Es sind noch keine Unterrichtsstunden erfasst.', { size: 11, italic: true, color: writer.colors.muted });
  } else if (!lessons.some((lesson) => paragraphsOf(recipient, lesson).length > 0)) {
    // Keine Stunde hat eigene Notizen: weder Zeitleiste noch „keine Notizen“-Hinweise.
  } else if (lessons.length === 1) {
    writeParagraphs(writer, paragraphsOf(recipient, lessons[0]), { indent: 0, rail: false });
    writer.gap(8, false);
  } else {
    lessons.forEach((lesson) => writeTimelineEntry(writer, recipient, lesson));
  }

  writeFixedBlocks(writer, recipient, 'end');
}

function writeFixedBlocks(writer: PdfWriter, { config, student, teacher, period }: Recipient, position: BlockPosition): void {
  const context = { instrument: instrumentOf(student, config), teacher, periodId: period.id };
  for (const block of config.blocks.filter((b) => b.position === position)) {
    const content = contentFor(block, context);
    const text = fillPlaceholders(content.text, student, teacher, config).trim();
    if (block.type === 'image' && content.image) {
      // Am Ende soll ein Bild nicht allein auf eine neue Seite rutschen.
      writer.image(content.image, position === 'end');
    } else if (block.type === 'text' && text) {
      writeFixedText(writer, text);
    } else {
      continue;
    }
    writer.gap(6, false);
  }
}

/**
 * Allgemeiner Teil vor den Stunden, ein Absatz je Abschnitt: Jeder Baustein eines allgemeinen
 * Abschnitts, der in irgendeiner Stunde angehakt ist, erscheint genau einmal; Freitext kommt aus
 * den allgemeinen Texten der Person.
 */
function writeGeneralPart(writer: PdfWriter, { config, student, teacher }: Recipient, lessons: Lesson[]): void {
  const paragraphs = config.sections
    .filter((section) => section.scope === 'general')
    .map((section) => fillPlaceholders(generalSentencesOf(section, lessons, student).join(' '), student, teacher, config))
    .filter((paragraph) => paragraph.length > 0);
  if (paragraphs.length === 0) return;
  writeParagraphs(writer, paragraphs, { indent: 0, rail: false });
  writer.gap(8, false);
}

function generalSentencesOf(section: Section, lessons: Lesson[], student: Student): string[] {
  if (section.type === 'text') {
    return freeTextSentence(section, student.generalTexts[section.id]);
  }
  const checked = new Set(lessons.flatMap((lesson) => lesson.checked[section.id] ?? []));
  return section.items.filter((item) => checked.has(item.id)).map((item) => asSentence(normalize(item.text)));
}

/** Leerzeilen trennen Absätze, einfache Zeilenumbrüche bleiben erhalten. */
function writeFixedText(writer: PdfWriter, text: string): void {
  const paragraphs = text.trim().split(/\n\s*\n/);
  paragraphs.forEach((paragraph, index) => {
    if (index > 0) writer.gap(3, false);
    paragraph.split('\n').forEach((line) => writer.text(line.trim(), { size: 11, lineHeight: 0.53, gapAfter: 0 }));
  });
}

/** Kopf auf der ersten Seite einer Person; Kopf- und Fußzeile der Folgeseiten merkt sich der Writer. */
function writeHeader(writer: PdfWriter, { config, student, teacher }: Recipient, lessons: Lesson[]): void {
  const layout = config.pdfLayout;
  const fill = (text: string) => fillPlaceholders(text, student, teacher, config).trim();
  writer.beginSection(fill(layout.runningHeader), {
    left: fill(layout.footerLeft),
    center: fill(layout.footerCenter),
    right: fill(layout.footerRight),
  });
  writer.text(fill(config.title), { size: 22, bold: true });
  const subtitle = fill(layout.subtitle);
  if (subtitle) writer.text(subtitle, { size: 14, color: writer.colors.accentText, gapAfter: 1.5 });
  if (layout.showInfoLine) writer.text(infoLine(lessons), { size: 10, color: writer.colors.muted, gapAfter: 0 });
  writer.endTitleArea();
  writer.gap(10, false);
}

function infoLine(lessons: Lesson[]): string {
  if (lessons.length === 1) {
    return `Unterrichtsstunde vom ${formatLongDate(lessons[0].date)}`;
  }
  return `${lessons.length} Unterrichtsstunden · Stand ${formatLongDate(today())}`;
}

function writeTimelineEntry(writer: PdfWriter, recipient: Recipient, lesson: Lesson): void {
  writer.keepTogether(22);
  writer.lessonHeading(formatLongDate(lesson.date));
  writeParagraphs(writer, paragraphsOf(recipient, lesson), { indent: LESSON_INDENT, rail: true });
  writer.gap(8, false);
}

function writeParagraphs(writer: PdfWriter, paragraphs: string[], layout: { indent: number; rail: boolean }): void {
  if (paragraphs.length === 0) {
    paragraphs = ['Zu dieser Stunde gibt es keine Notizen.'];
  }
  paragraphs.forEach((paragraph, index) => {
    if (index > 0) writer.gap(2.5, layout.rail);
    writer.text(paragraph, { size: 11, lineHeight: 0.53, ...layout, gapAfter: 0 });
  });
}

/** Jeder Abschnitt der Stunde wird ein eigener Absatz; leere Abschnitte entfallen. */
function paragraphsOf({ config, student, teacher }: Recipient, lesson: Lesson): string[] {
  return config.sections
    .filter((section) => section.scope === 'lesson')
    .map((section) => fillPlaceholders(sentencesOf(section, lesson).join(' '), student, teacher, config, lesson))
    .filter((paragraph) => paragraph.length > 0);
}

/**
 * Liefert die Einträge eines Abschnitts als Sätze für den Fließtext. Textbausteine sind bereits
 * Sätze; Freitext bekommt den Abschnittstitel vorangestellt, wenn das in der Konfiguration
 * eingestellt ist, damit er im Fließtext verständlich bleibt.
 */
function sentencesOf(section: Section, lesson: Lesson): string[] {
  if (section.type === 'text') {
    return freeTextSentence(section, lesson.texts[section.id]);
  }
  const checked = lesson.checked[section.id] ?? [];
  return section.items
    .filter((item) => checked.includes(item.id))
    .map((item) => asSentence(normalize(item.text)));
}

function freeTextSentence(section: Section, text: string | undefined): string[] {
  const normalized = normalize(text ?? '');
  if (!normalized) return [];
  return [asSentence(section.showTitle ? `${section.title}: ${normalized}` : normalized)];
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function asSentence(text: string): string {
  return /[.!?…:]$/.test(text) ? text : `${text}.`;
}

interface TextStyle {
  size: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  /** Zeilenhöhe in mm je pt Schriftgröße */
  lineHeight?: number;
  indent?: number;
  /** Zeichnet links die Linie der Zeitleiste neben jede Zeile. */
  rail?: boolean;
  gapBefore?: number;
  gapAfter?: number;
}

function replacePagePlaceholders(text: string, page: number, pageCount: number): string {
  return text.replace(/\{seite\}/gi, String(page)).replace(/\{seiten\}/gi, String(pageCount));
}

/** Linker Rand eines `width` mm breiten Elements bei der gewählten Ausrichtung im Satzspiegel */
function alignedX(align: ImageAlign, width: number): number {
  return { left: MARGIN, center: MARGIN + (CONTENT_WIDTH - width) / 2, right: MARGIN + CONTENT_WIDTH - width }[align];
}

interface FooterTexts {
  left: string;
  center: string;
  right: string;
}

/**
 * Schreibt Text fortlaufend von oben nach unten und beginnt bei Bedarf eine neue Seite.
 * Jeder Abschnitt (z. B. jede Person) beginnt auf einer neuen Seite und hat eine eigene Seitenzählung.
 *
 * {seite} und {seiten} ersetzt der Writer selbst, Zeile für Zeile, weil erst beim Schreiben feststeht,
 * auf welcher Seite eine Zeile landet. Die Seitenanzahl kommt aus einem vorherigen Durchlauf
 * (`knownPageCounts`); ohne ihn steht vorläufig „99“ da, damit die Zeilen gleich breit umbrechen.
 */
class PdfWriter {
  private y = MARGIN;
  private runningHeader = '';
  /** Neben der Überschrift belegt das Kopflogo diesen Rand, bis `endTitleArea` aufgerufen wird. */
  private logoArea: { side: 'left' | 'right'; width: number; untilY: number } | null = null;
  private readonly students: { footer: FooterTexts; firstPage: number }[] = [];

  constructor(
    private readonly doc: jsPDF,
    readonly colors: PdfColors,
    private readonly logos: Pick<PdfLayout, 'headerLogo' | 'footerLogo'>,
    private readonly knownPageCounts?: number[],
  ) {}

  /** Seitenanzahl je Person in der Reihenfolge des Exports */
  pageCounts(): number[] {
    const total = this.doc.getNumberOfPages();
    return this.students.map((student, index) => (this.students[index + 1]?.firstPage ?? total + 1) - student.firstPage);
  }

  /** `footer` darf noch {seite} und {seiten} enthalten. */
  beginSection(runningHeader: string, footer: FooterTexts): void {
    if (this.students.length > 0) this.doc.addPage();
    this.students.push({ footer, firstPage: this.doc.getNumberOfPages() });
    this.runningHeader = runningHeader;
    this.accentBand(8);
    this.y = MARGIN + 8;
    this.firstPageLogo();
  }

  /** Inhalt beginnt unterhalb des Kopflogos, auch wenn die Überschrift daneben kürzer war. */
  endTitleArea(): void {
    if (this.logoArea) this.y = Math.max(this.y, this.logoArea.untilY);
    this.logoArea = null;
  }

  /** Mittig steht das Logo über der Überschrift, sonst daneben; dann rückt der Titeltext zur Seite. */
  private firstPageLogo(): void {
    const logo = this.logos.headerLogo;
    if (!logo) return;
    const center = logo.align === 'center';
    const { width, height } = logoSize(logo, logo.heightMm, center ? CONTENT_WIDTH : CONTENT_WIDTH / 2);
    this.drawLogo(logo, alignedX(logo.align, width), this.y, width, height);
    if (center) {
      this.y += height + 4;
    } else {
      this.logoArea = { side: logo.align === 'left' ? 'left' : 'right', width: width + 5, untilY: this.y + height + 2 };
    }
  }

  private drawLogo(logo: PdfLogo, x: number, y: number, width: number, height: number): void {
    const format = logo.dataUrl.startsWith('data:image/png') ? 'PNG' : 'JPEG';
    this.doc.addImage(logo.dataUrl, format, x, y, width, height);
  }

  text(text: string, style: TextStyle): void {
    this.y += style.gapBefore ?? 0;
    const area = this.logoArea && this.y < this.logoArea.untilY ? this.logoArea : null;
    const indent = (style.indent ?? 0) + (area?.side === 'left' ? area.width : 0);
    const width = CONTENT_WIDTH - indent - (area?.side === 'right' ? area.width : 0);
    const lineHeight = style.size * (style.lineHeight ?? 0.45);
    this.applyStyle(style);
    for (const line of this.doc.splitTextToSize(text, width) as string[]) {
      if (this.keepTogether(lineHeight)) this.applyStyle(style);
      if (style.rail) this.railSegment(lineHeight);
      this.doc.text(this.fillPagePlaceholders(line), MARGIN + indent, this.y, { baseline: 'top' });
      this.y += lineHeight;
    }
    this.y += style.gapAfter ?? 1;
  }

  /** Vertikaler Abstand; mit `rail` läuft die Linie der Zeitleiste durch. */
  gap(height: number, rail: boolean): void {
    if (rail) this.railSegment(height);
    this.y += height;
  }

  /**
   * Mit `shrinkToFit` wird ein Bild, das nicht mehr auf die Seite passt, auf den restlichen Platz
   * verkleinert statt allein auf die nächste Seite umzubrechen. Nur wenn selbst
   * `MIN_SHRUNK_IMAGE_HEIGHT` nicht mehr passt, folgt doch ein Seitenwechsel.
   */
  image(image: BlockImage, shrinkToFit = false): void {
    const width = Math.min(image.widthMm, CONTENT_WIDTH);
    let height = Math.min(width * (image.heightPx / image.widthPx), CONTENT_BOTTOM - MARGIN - 10);
    const remaining = CONTENT_BOTTOM - this.y;
    if (shrinkToFit && height > remaining && remaining >= MIN_SHRUNK_IMAGE_HEIGHT) {
      height = remaining;
    }
    const scaledWidth = height * (image.widthPx / image.heightPx);
    const x = {
      left: MARGIN,
      center: MARGIN + (CONTENT_WIDTH - scaledWidth) / 2,
      right: MARGIN + CONTENT_WIDTH - scaledWidth,
    }[image.align];
    this.keepTogether(height);
    const format = image.dataUrl.startsWith('data:image/png') ? 'PNG' : 'JPEG';
    this.doc.addImage(image.dataUrl, format, x, this.y, scaledWidth, height);
    this.y += height;
  }

  lessonHeading(text: string): void {
    this.doc.setFillColor(this.colors.accent);
    this.doc.circle(RAIL_X, this.y + 2.2, 1.8, 'F');
    this.text(text, { size: 12, bold: true, color: this.colors.accentText, indent: LESSON_INDENT, gapAfter: 2 });
  }

  /** Beginnt eine neue Seite, wenn weniger als `height` mm Platz bleiben. Liefert true bei Seitenwechsel. */
  keepTogether(height: number): boolean {
    if (this.y + height <= CONTENT_BOTTOM) return false;
    this.newPage();
    return true;
  }

  addFooters(): void {
    const pageCounts = this.pageCounts();
    this.students.forEach((student, index) => {
      for (let page = 1; page <= pageCounts[index]; page++) {
        const fill = (text: string) => replacePagePlaceholders(text, page, pageCounts[index]);
        this.doc.setPage(student.firstPage + page - 1);
        this.footer({ left: fill(student.footer.left), center: fill(student.footer.center), right: fill(student.footer.right) });
      }
    });
  }

  toBlob(): Blob {
    return this.doc.output('blob');
  }

  /** Neue Seite im selben Abschnitt, aufgemacht wie dessen erste: breites Band und Logo neben der Überschrift */
  titlePage(): void {
    this.doc.addPage();
    this.accentBand(8);
    this.y = MARGIN + 8;
    this.firstPageLogo();
  }

  private newPage(): void {
    this.doc.addPage();
    this.accentBand(3);
    let headerX = MARGIN;
    const logo = this.logos.headerLogo;
    if (logo) {
      const { width, height } = logoSize(logo, Math.min(logo.heightMm, 7), CONTENT_WIDTH / 3);
      this.drawLogo(logo, alignedX(logo.align, width), 7.5, width, height);
      if (logo.align === 'left') headerX += width + 4;
    }
    if (this.runningHeader) {
      this.applyStyle({ size: 9, color: this.colors.muted });
      this.doc.text(this.fillPagePlaceholders(this.runningHeader), headerX, 10, { baseline: 'top' });
    }
    this.y = MARGIN + 2;
  }

  /** Setzt Seite und Seitenanzahl der Person ein, für die gerade geschrieben wird. */
  private fillPagePlaceholders(text: string): string {
    const index = this.students.length - 1;
    const page = this.doc.getNumberOfPages() - this.students[index].firstPage + 1;
    return replacePagePlaceholders(text, page, this.knownPageCounts?.[index] ?? 99);
  }

  /** Ohne Text und Logo entfällt auch die Trennlinie. Ein Text an der Stelle des Logos rückt daneben. */
  private footer(texts: FooterTexts): void {
    const logo = this.logos.footerLogo;
    if (!logo && !texts.left && !texts.center && !texts.right) return;
    const y = PAGE_HEIGHT - 14;
    this.doc.setDrawColor(this.colors.rail);
    this.doc.setLineWidth(0.3);
    this.doc.line(MARGIN, y - 3, MARGIN + CONTENT_WIDTH, y - 3);
    this.applyStyle({ size: 9, color: this.colors.muted });
    let leftX = MARGIN;
    let rightX = MARGIN + CONTENT_WIDTH;
    let centerX: number | null = null;
    if (logo) {
      const { width, height } = logoSize(logo, logo.heightMm, CONTENT_WIDTH / 3);
      const centerTextWidth = texts.center ? this.doc.getTextWidth(texts.center) + 3 : 0;
      const x = logo.align === 'center' ? (PAGE_WIDTH - width - centerTextWidth) / 2 : alignedX(logo.align, width);
      this.drawLogo(logo, x, y - 1, width, height);
      if (logo.align === 'left') leftX += width + 3;
      if (logo.align === 'right') rightX -= width + 3;
      if (logo.align === 'center') centerX = x + width + 3;
    }
    if (texts.left) this.doc.text(texts.left, leftX, y, { baseline: 'top' });
    if (texts.center) {
      if (centerX === null) this.doc.text(texts.center, PAGE_WIDTH / 2, y, { baseline: 'top', align: 'center' });
      else this.doc.text(texts.center, centerX, y, { baseline: 'top' });
    }
    if (texts.right) this.doc.text(texts.right, rightX, y, { baseline: 'top', align: 'right' });
  }

  private accentBand(height: number): void {
    this.doc.setFillColor(this.colors.accent);
    this.doc.rect(0, 0, PAGE_WIDTH, this.colors.inkSaving ? 0.8 : height, 'F');
  }

  private railSegment(lineHeight: number): void {
    this.doc.setDrawColor(this.colors.rail);
    this.doc.setLineWidth(0.8);
    this.doc.line(RAIL_X, this.y - 1, RAIL_X, this.y + lineHeight - 1);
  }

  private applyStyle(style: Pick<TextStyle, 'size' | 'bold' | 'italic' | 'color'>): void {
    const fontStyle = style.bold ? 'bold' : style.italic ? 'italic' : 'normal';
    this.doc.setFont('helvetica', fontStyle);
    this.doc.setFontSize(style.size);
    this.doc.setTextColor(style.color ?? this.colors.text);
  }
}
