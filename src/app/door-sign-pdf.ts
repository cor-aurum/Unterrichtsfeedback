import type { jsPDF } from 'jspdf';
import { logoSize, PdfLogo } from './model';
import { GRAYSCALE_THEME, Theme } from './theme';

const PAGE_WIDTH = 297;
const PAGE_HEIGHT = 210;
const MARGIN = 20;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
/** Das Logo darf auf dem Türschild größer sein als im Kopf der anderen PDFs. */
const MAX_LOGO_HEIGHT = 35;
const MAX_LOGO_WIDTH = 140;
const BAND_HEIGHT = 6;
/** Zeilenhöhe in mm je Punkt Schriftgröße (1 pt = 0,3528 mm, dazu etwas Durchschuss) */
const LINE_FACTOR = 0.3528 * 1.15;
const TEXT = '#1f2933';
const MUTED = '#66727f';

/** Ein Türschild: Name, Funktion und Ort einer Lehrkraft in ihrer Farbe */
export interface DoorSign {
  name: string;
  role: string;
  location: string;
  theme: Theme;
}

/** Text in der größten Schrift, mit der er in höchstens `maxLines` Zeilen in die Breite passt */
interface FittedText {
  lines: string[];
  size: number;
  height: number;
}

/** Türschilder im Querformat, je Lehrkraft eine Seite: Logo oben, darunter groß Name, Funktion und Ort. */
export function writeDoorSigns(doc: jsPDF, logo: PdfLogo | null, signs: DoorSign[]): void {
  signs.forEach((sign, index) => {
    if (index > 0) doc.addPage('a4', 'landscape');
    writeDoorSign(doc, logo, sign);
  });
}

function writeDoorSign(doc: jsPDF, logo: PdfLogo | null, sign: DoorSign): void {
  const top = writeLogo(doc, logo);
  const bottom = writeBand(doc, sign.theme);
  const name = fitText(doc, 'bold', sign.name, 72, 28, 2);
  const role = fitText(doc, 'normal', sign.role, 32, 16, 2);
  const location = fitText(doc, 'normal', sign.location, 24, 12, 2);
  const ruleGap = 10;
  const height = name.height + ruleGap + role.height + (location.lines.length ? 4 + location.height : 0);
  // Der Text steht mittig im Platz zwischen Logo und Band.
  let y = top + Math.max(0, (bottom - top - height) / 2);
  y = writeLines(doc, name, 'bold', TEXT, y);
  doc.setFillColor(sign.theme.primary).rect((PAGE_WIDTH - 40) / 2, y + ruleGap / 2 - 0.75, 40, 1.5, 'F');
  y = writeLines(doc, role, 'normal', sign.theme.primaryText, y + ruleGap);
  writeLines(doc, location, 'normal', MUTED, y + 4);
}

/** Logo oben, wie in den PDF-Einstellungen ausgerichtet; liefert, wo der Platz darunter beginnt. */
function writeLogo(doc: jsPDF, logo: PdfLogo | null): number {
  if (!logo) return MARGIN;
  const { width, height } = logoSize(logo, MAX_LOGO_HEIGHT, MAX_LOGO_WIDTH);
  const x = { left: MARGIN, center: (PAGE_WIDTH - width) / 2, right: PAGE_WIDTH - MARGIN - width }[logo.align];
  doc.addImage(logo.dataUrl, logo.dataUrl.startsWith('data:image/png') ? 'PNG' : 'JPEG', x, MARGIN, width, height);
  return MARGIN + height + 8;
}

/** Farbiges Band am unteren Rand, in Schwarzweiß nur eine Linie; liefert, wo der Platz darüber endet. */
function writeBand(doc: jsPDF, theme: Theme): number {
  const y = PAGE_HEIGHT - MARGIN - BAND_HEIGHT;
  if (theme === GRAYSCALE_THEME) {
    doc.setDrawColor(theme.primary).setLineWidth(0.5).line(MARGIN, y + BAND_HEIGHT, PAGE_WIDTH - MARGIN, y + BAND_HEIGHT);
  } else {
    doc.setFillColor(theme.primary).rect(MARGIN, y, CONTENT_WIDTH, BAND_HEIGHT, 'F');
  }
  return y - 8;
}

function fitText(doc: jsPDF, style: 'bold' | 'normal', text: string, maxSize: number, minSize: number, maxLines: number): FittedText {
  const clean = text.trim();
  if (!clean) return { lines: [], size: minSize, height: 0 };
  let size = maxSize;
  let lines = split(doc, style, clean, size);
  while (lines.length > maxLines && size > minSize) {
    size -= 2;
    lines = split(doc, style, clean, size);
  }
  return { lines: lines.slice(0, maxLines), size, height: Math.min(lines.length, maxLines) * size * LINE_FACTOR };
}

function split(doc: jsPDF, style: 'bold' | 'normal', text: string, size: number): string[] {
  return doc.setFont('helvetica', style).setFontSize(size).splitTextToSize(text, CONTENT_WIDTH) as string[];
}

/** Schreibt die Zeilen mittig ab `y`; liefert, wo der Text endet. */
function writeLines(doc: jsPDF, text: FittedText, style: 'bold' | 'normal', color: string, y: number): number {
  const lineHeight = text.size * LINE_FACTOR;
  doc.setFont('helvetica', style).setFontSize(text.size).setTextColor(color);
  text.lines.forEach((line, index) => doc.text(line, PAGE_WIDTH / 2, y + index * lineHeight, { align: 'center', baseline: 'top' }));
  return y + text.lines.length * lineHeight;
}
