import { Injectable } from '@angular/core';
import type { jsPDF } from 'jspdf';
import {
  BlockImage,
  BlockPosition,
  FeedbackConfig,
  contentFor,
  fillPlaceholders,
  instrumentOf,
  Lesson,
  Section,
  Student,
  today,
} from './model';
import { downloadFile, safeFileName } from './stored-signal';
import { sortedLessons } from './students.store';

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

const COLORS = {
  accent: '#f57115',
  accentText: '#b34f00',
  rail: '#fbd3b4',
  text: '#1f2933',
  muted: '#66727f',
};

@Injectable({ providedIn: 'root' })
export class PdfExport {
  async export(config: FeedbackConfig, students: Student[], fileName: string): Promise<void> {
    // jsPDF ist groß und wird deshalb erst beim ersten Export geladen.
    const { jsPDF } = await import('jspdf');
    const writer = new PdfWriter(new jsPDF({ unit: 'mm', format: 'a4' }));
    students.forEach((student) => writeStudent(writer, config, student));
    writer.addFooters();
    downloadFile(`${safeFileName(fileName)}_${today()}.pdf`, writer.toBlob());
  }
}

/**
 * Mehrere Stunden erscheinen als Zeitleiste mit Datum je Stunde. Bei nur einer Stunde entfällt die
 * Zeitleiste und das Datum steht im Kopf. Hat keine Stunde eigene Notizen, entfällt der Teil mit den
 * Stunden ganz.
 */
function writeStudent(writer: PdfWriter, config: FeedbackConfig, student: Student): void {
  const lessons = sortedLessons(student);
  writer.beginStudent(student.name, `${config.title} · ${student.name}`);
  writer.text(config.title, { size: 22, bold: true });
  writer.text(`für ${student.name}`, { size: 14, color: COLORS.accentText, gapAfter: 1.5 });
  writer.text(subtitle(lessons), { size: 10, color: COLORS.muted, gapAfter: 10 });
  writeFixedBlocks(writer, config, 'start', student);
  writeGeneralPart(writer, config, lessons, student);

  if (lessons.length === 0) {
    writer.text('Es sind noch keine Unterrichtsstunden erfasst.', { size: 11, italic: true, color: COLORS.muted });
  } else if (!lessons.some((lesson) => paragraphsOf(config, lesson, student).length > 0)) {
    // Keine Stunde hat eigene Notizen: weder Zeitleiste noch „keine Notizen“-Hinweise.
  } else if (lessons.length === 1) {
    writeParagraphs(writer, paragraphsOf(config, lessons[0], student), { indent: 0, rail: false });
    writer.gap(8, false);
  } else {
    lessons.forEach((lesson) => writeTimelineEntry(writer, config, lesson, student));
  }

  writeFixedBlocks(writer, config, 'end', student);
}

function writeFixedBlocks(writer: PdfWriter, config: FeedbackConfig, position: BlockPosition, student: Student): void {
  for (const block of config.blocks.filter((b) => b.position === position)) {
    const content = contentFor(block, instrumentOf(student, config));
    const text = fillPlaceholders(content.text, student, config).trim();
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
function writeGeneralPart(writer: PdfWriter, config: FeedbackConfig, lessons: Lesson[], student: Student): void {
  const paragraphs = config.sections
    .filter((section) => section.scope === 'general')
    .map((section) => fillPlaceholders(generalSentencesOf(section, lessons, student).join(' '), student, config))
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

function subtitle(lessons: Lesson[]): string {
  if (lessons.length === 1) {
    return `Unterrichtsstunde vom ${formatLongDate(lessons[0].date)}`;
  }
  return `${lessons.length} Unterrichtsstunden · Stand ${formatLongDate(today())}`;
}

function writeTimelineEntry(writer: PdfWriter, config: FeedbackConfig, lesson: Lesson, student: Student): void {
  writer.keepTogether(22);
  writer.lessonHeading(formatLongDate(lesson.date));
  writeParagraphs(writer, paragraphsOf(config, lesson, student), { indent: LESSON_INDENT, rail: true });
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
function paragraphsOf(config: FeedbackConfig, lesson: Lesson, student: Student): string[] {
  return config.sections
    .filter((section) => section.scope === 'lesson')
    .map((section) => fillPlaceholders(sentencesOf(section, lesson).join(' '), student, config))
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

function formatLongDate(isoDate: string): string {
  return new Date(isoDate + 'T00:00:00').toLocaleDateString('de-DE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
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

/**
 * Schreibt Text fortlaufend von oben nach unten und beginnt bei Bedarf eine neue Seite.
 * Jede Person bekommt eigene Seiten mit eigener Seitenzählung in der Fußzeile.
 */
class PdfWriter {
  private y = MARGIN;
  private runningHeader = '';
  private readonly students: { name: string; firstPage: number }[] = [];

  constructor(private readonly doc: jsPDF) {}

  beginStudent(name: string, runningHeader: string): void {
    if (this.students.length > 0) this.doc.addPage();
    this.students.push({ name, firstPage: this.doc.getNumberOfPages() });
    this.runningHeader = runningHeader;
    this.accentBand(8);
    this.y = MARGIN + 8;
  }

  text(text: string, style: TextStyle): void {
    this.y += style.gapBefore ?? 0;
    const indent = style.indent ?? 0;
    const lineHeight = style.size * (style.lineHeight ?? 0.45);
    this.applyStyle(style);
    for (const line of this.doc.splitTextToSize(text, CONTENT_WIDTH - indent) as string[]) {
      if (this.keepTogether(lineHeight)) this.applyStyle(style);
      if (style.rail) this.railSegment(lineHeight);
      this.doc.text(line, MARGIN + indent, this.y, { baseline: 'top' });
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
    this.doc.setFillColor(COLORS.accent);
    this.doc.circle(RAIL_X, this.y + 2.2, 1.8, 'F');
    this.text(text, { size: 12, bold: true, color: COLORS.accentText, indent: LESSON_INDENT, gapAfter: 2 });
  }

  /** Beginnt eine neue Seite, wenn weniger als `height` mm Platz bleiben. Liefert true bei Seitenwechsel. */
  keepTogether(height: number): boolean {
    if (this.y + height <= CONTENT_BOTTOM) return false;
    this.newPage();
    return true;
  }

  addFooters(): void {
    const total = this.doc.getNumberOfPages();
    this.students.forEach((student, index) => {
      const lastPage = (this.students[index + 1]?.firstPage ?? total + 1) - 1;
      const pageCount = lastPage - student.firstPage + 1;
      for (let page = student.firstPage; page <= lastPage; page++) {
        this.doc.setPage(page);
        this.footer(student.name, `Seite ${page - student.firstPage + 1} von ${pageCount}`);
      }
    });
  }

  toBlob(): Blob {
    return this.doc.output('blob');
  }

  private newPage(): void {
    this.doc.addPage();
    this.accentBand(3);
    this.applyStyle({ size: 9, color: COLORS.muted });
    this.doc.text(this.runningHeader, MARGIN, 10, { baseline: 'top' });
    this.y = MARGIN + 2;
  }

  private footer(left: string, right: string): void {
    const y = PAGE_HEIGHT - 14;
    this.doc.setDrawColor(COLORS.rail);
    this.doc.setLineWidth(0.3);
    this.doc.line(MARGIN, y - 3, MARGIN + CONTENT_WIDTH, y - 3);
    this.applyStyle({ size: 9, color: COLORS.muted });
    this.doc.text(left, MARGIN, y, { baseline: 'top' });
    this.doc.text(right, MARGIN + CONTENT_WIDTH, y, { baseline: 'top', align: 'right' });
  }

  private accentBand(height: number): void {
    this.doc.setFillColor(COLORS.accent);
    this.doc.rect(0, 0, PAGE_WIDTH, height, 'F');
  }

  private railSegment(lineHeight: number): void {
    this.doc.setDrawColor(COLORS.rail);
    this.doc.setLineWidth(0.8);
    this.doc.line(RAIL_X, this.y - 1, RAIL_X, this.y + lineHeight - 1);
  }

  private applyStyle(style: Pick<TextStyle, 'size' | 'bold' | 'italic' | 'color'>): void {
    const fontStyle = style.bold ? 'bold' : style.italic ? 'italic' : 'normal';
    this.doc.setFont('helvetica', fontStyle);
    this.doc.setFontSize(style.size);
    this.doc.setTextColor(style.color ?? COLORS.text);
  }
}
