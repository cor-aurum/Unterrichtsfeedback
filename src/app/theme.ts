export const DEFAULT_THEME_COLOR = '#f57115';

/** Aus der Themenfarbe abgeleitete Farben für App und PDF. */
export interface Theme {
  /** Flächen: Kopfleiste, Buttons, PDF-Band und Punkte der Zeitleiste */
  primary: string;
  /** Text auf Flächen in `primary` */
  onPrimary: string;
  /** Text in Themenfarbe auf hellem Grund; dunkel genug für Kontrast 4,5 : 1 zu Weiß */
  primaryText: string;
  /** Heller Hintergrund, z. B. ausgewählte Einträge */
  primaryLight: string;
  /** Linien, z. B. Zeitleiste im PDF */
  rail: string;
}

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
const DARK_TEXT: Rgb = [31, 41, 51];
/**
 * Weiße Schrift auf der Themenfarbe bleibt, solange sie halbwegs lesbar ist (wie beim Standard-Orange
 * mit 2,9 : 1). Erst bei sehr hellen Farben wie Gelb wird die Schrift dunkel.
 */
const MIN_WHITE_ON_PRIMARY_CONTRAST = 2.5;

type Rgb = [number, number, number];

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

export function themeFrom(color: string): Theme {
  const primary = toRgb(isHexColor(color) ? color : DEFAULT_THEME_COLOR);
  return {
    primary: toHex(primary),
    onPrimary: toHex(contrast(WHITE, primary) >= MIN_WHITE_ON_PRIMARY_CONTRAST ? WHITE : DARK_TEXT),
    primaryText: toHex(darkenForText(primary)),
    primaryLight: toHex(mix(primary, WHITE, 0.9)),
    rail: toHex(mix(primary, WHITE, 0.7)),
  };
}

function darkenForText(color: Rgb): Rgb {
  for (let amount = 0; amount <= 1; amount += 0.05) {
    const darker = mix(color, BLACK, amount);
    if (contrast(WHITE, darker) >= 4.5) return darker;
  }
  return BLACK;
}

/** Mischt `amount` (0–1) von `other` in `color`. */
function mix(color: Rgb, other: Rgb, amount: number): Rgb {
  return color.map((channel, i) => Math.round(channel * (1 - amount) + other[i] * amount)) as Rgb;
}

/** Kontrastverhältnis nach WCAG */
function contrast(a: Rgb, b: Rgb): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(color: Rgb): number {
  const [r, g, b] = color.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function toRgb(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

function toHex(color: Rgb): string {
  return '#' + color.map((channel) => channel.toString(16).padStart(2, '0')).join('');
}
