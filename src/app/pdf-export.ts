import { Injectable } from '@angular/core';
import type { jsPDF } from 'jspdf';
import {
  BlockImage,
  BlockPosition,
  FeedbackConfig,
  contentFor,
  fillPlaceholders,
  formatLongDate,
  instrumentOf,
  Lesson,
  Section,
  Student,
  today,
} from './model';
import { openFile, safeFileName, saveFile } from './save-file';
import { sortedLessons } from './students.store';
import { Theme, themeFrom } from './theme';

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
  accent: string;
  accentText: string;
  rail: string;
  text: string;
  muted: string;
}

function pdfColors(theme: Theme): PdfColors {
  return {
    accent: theme.primary,
    accentText: theme.primaryText,
    rail: theme.rail,
    text: '#1f2933',
    muted: '#66727f',
  };
}

@Injectable({ providedIn: 'root' })
export class PdfExport {
  /** `open` öffnet das PDF in der Android-App direkt; im Browser wird es in beiden Fällen heruntergeladen. */
  async export(config: FeedbackConfig, students: Student[], fileName: string, action: 'open' | 'share' = 'share'): Promise<void> {
    // jsPDF ist groß und wird deshalb erst beim ersten Export geladen.
    const { jsPDF } = await import('jspdf');
    const colors = pdfColors(themeFrom(config.themeColor));
    const render = (pageCounts?: number[]) => {
      const writer = new PdfWriter(new jsPDF({ unit: 'mm', format: 'a4' }), colors, pageCounts);
      students.forEach((student) => writeStudent(writer, config, student));
      writer.addFooters();
      return writer;
    };
    // {seiten} im Text steht erst fest, wenn alle Seiten geschrieben sind. Deshalb zählt ein erster
    // Durchlauf die Seiten je Person, der zweite schreibt die echten Zahlen.
    const writer = render(render().pageCounts());
    const pdfName = `${safeFileName(fileName)}_${today()}.pdf`;
    await (action === 'open' ? openFile(pdfName, writer.toBlob()) : saveFile(pdfName, writer.toBlob()));
  }
}

/**
 * Mehrere Stunden erscheinen als Zeitleiste mit Datum je Stunde. Bei nur einer Stunde entfällt die
 * Zeitleiste und das Datum steht im Kopf. Hat keine Stunde eigene Notizen, entfällt der Teil mit den
 * Stunden ganz.
 */
function writeStudent(writer: PdfWriter, config: FeedbackConfig, student: Student): void {
  const lessons = sortedLessons(student);
  writeHeader(writer, config, student, lessons);
  writeFixedBlocks(writer, config, 'start', student);
  writeGeneralPart(writer, config, lessons, student);

  if (lessons.length === 0) {
    writer.text('Es sind noch keine Unterrichtsstunden erfasst.', { size: 11, italic: true, color: writer.colors.muted });
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

/** Kopf auf der ersten Seite einer Person; Kopf- und Fußzeile der Folgeseiten merkt sich der Writer. */
function writeHeader(writer: PdfWriter, config: FeedbackConfig, student: Student, lessons: Lesson[]): void {
  const layout = config.pdfLayout;
  const fill = (text: string) => fillPlaceholders(text, student, config).trim();
  writer.beginStudent(fill(layout.runningHeader), {
    left: fill(layout.footerLeft),
    center: fill(layout.footerCenter),
    right: fill(layout.footerRight),
  });
  writer.text(fill(config.title), { size: 22, bold: true });
  const subtitle = fill(layout.subtitle);
  if (subtitle) writer.text(subtitle, { size: 14, color: writer.colors.accentText, gapAfter: 1.5 });
  if (layout.showInfoLine) writer.text(infoLine(lessons), { size: 10, color: writer.colors.muted, gapAfter: 0 });
  writer.gap(10, false);
}

function infoLine(lessons: Lesson[]): string {
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

interface FooterTexts {
  left: string;
  center: string;
  right: string;
}

/**
 * Schreibt Text fortlaufend von oben nach unten und beginnt bei Bedarf eine neue Seite.
 * Jede Person bekommt eigene Seiten mit eigener Seitenzählung in der Fußzeile.
 *
 * {seite} und {seiten} ersetzt der Writer selbst, Zeile für Zeile, weil erst beim Schreiben feststeht,
 * auf welcher Seite eine Zeile landet. Die Seitenanzahl kommt aus einem vorherigen Durchlauf
 * (`knownPageCounts`); ohne ihn steht vorläufig „99“ da, damit die Zeilen gleich breit umbrechen.
 */
class PdfWriter {
  private y = MARGIN;
  private runningHeader = '';
  private readonly students: { footer: FooterTexts; firstPage: number }[] = [];

  constructor(
    private readonly doc: jsPDF,
    readonly colors: PdfColors,
    private readonly knownPageCounts?: number[],
  ) {}

  /** Seitenanzahl je Person in der Reihenfolge des Exports */
  pageCounts(): number[] {
    const total = this.doc.getNumberOfPages();
    return this.students.map((student, index) => (this.students[index + 1]?.firstPage ?? total + 1) - student.firstPage);
  }

  /** `footer` darf noch {seite} und {seiten} enthalten. */
  beginStudent(runningHeader: string, footer: FooterTexts): void {
    if (this.students.length > 0) this.doc.addPage();
    this.students.push({ footer, firstPage: this.doc.getNumberOfPages() });
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

  private newPage(): void {
    this.doc.addPage();
    this.accentBand(3);
    if (this.runningHeader) {
      this.applyStyle({ size: 9, color: this.colors.muted });
      this.doc.text(this.fillPagePlaceholders(this.runningHeader), MARGIN, 10, { baseline: 'top' });
    }
    this.y = MARGIN + 2;
  }

  /** Setzt Seite und Seitenanzahl der Person ein, für die gerade geschrieben wird. */
  private fillPagePlaceholders(text: string): string {
    const index = this.students.length - 1;
    const page = this.doc.getNumberOfPages() - this.students[index].firstPage + 1;
    return replacePagePlaceholders(text, page, this.knownPageCounts?.[index] ?? 99);
  }

  /** Ohne Text entfällt auch die Trennlinie. */
  private footer(texts: FooterTexts): void {
    if (!texts.left && !texts.center && !texts.right) return;
    const y = PAGE_HEIGHT - 14;
    this.doc.setDrawColor(this.colors.rail);
    this.doc.setLineWidth(0.3);
    this.doc.line(MARGIN, y - 3, MARGIN + CONTENT_WIDTH, y - 3);
    this.applyStyle({ size: 9, color: this.colors.muted });
    if (texts.left) this.doc.text(texts.left, MARGIN, y, { baseline: 'top' });
    if (texts.center) this.doc.text(texts.center, PAGE_WIDTH / 2, y, { baseline: 'top', align: 'center' });
    if (texts.right) this.doc.text(texts.right, MARGIN + CONTENT_WIDTH, y, { baseline: 'top', align: 'right' });
  }

  private accentBand(height: number): void {
    this.doc.setFillColor(this.colors.accent);
    this.doc.rect(0, 0, PAGE_WIDTH, height, 'F');
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
