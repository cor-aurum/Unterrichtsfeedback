import { computed, Injectable } from '@angular/core';
import {
  BlockContent,
  BlockImage,
  BlockPosition,
  BlockVariant,
  CalendarSettings,
  DEFAULT_PDF_LAYOUT,
  defaultCalendarSettings,
  defaultTeachingWindows,
  defaultInstrument,
  FeedbackConfig,
  FixedBlock,
  Instrument,
  PdfLayout,
  newId,
  Section,
  SectionScope,
  SectionType,
  Teacher,
  TeachingWindow,
  TimeWindow,
  standardWindowsFor,
} from './model';
import { saveFile } from './save-file';
import { storedSignal } from './stored-signal';
import { DEFAULT_THEME_COLOR, isHexColor, themeFrom } from './theme';

/** Standardinhalt (`variantId` = null) oder eine Variante eines festen Blocks */
export interface ContentTarget {
  blockId: string;
  variantId: string | null;
}

@Injectable({ providedIn: 'root' })
export class ConfigStore {
  readonly config = storedSignal<FeedbackConfig>('feedback.config', defaultConfig, parseConfig);

  readonly theme = computed(() => themeFrom(this.config().themeColor));

  setTitle(title: string): void {
    this.mutate((config) => (config.title = title));
  }

  setPdfLayout(change: Partial<PdfLayout>): void {
    this.mutate((config) => Object.assign(config.pdfLayout, change));
  }

  resetPdfLayout(): void {
    this.mutate((config) => (config.pdfLayout = { ...DEFAULT_PDF_LAYOUT }));
  }

  setThemeColor(color: string): void {
    if (isHexColor(color)) this.mutate((config) => (config.themeColor = color.toLowerCase()));
  }

  setCalendarDefaults(change: Partial<CalendarSettings>): void {
    this.mutate((config) => Object.assign(config.calendar, change));
  }

  addTeacher(name: string): void {
    this.mutate((config) =>
      config.teachers.push({
        id: newId(),
        name,
        instrumentId: config.defaultInstrumentId,
        location: '',
        teachingWindows: defaultTeachingWindows(config.calendar),
      }),
    );
  }

  updateTeacher(teacherId: string, change: Partial<Pick<Teacher, 'name' | 'instrumentId' | 'location'>>): void {
    this.mutateTeacher(teacherId, (teacher) => Object.assign(teacher, change));
  }

  /**
   * Entfernt den Lehrer auch aus allen Varianten. Personen dieses Lehrers gehören danach zum ersten Lehrer.
   * Der letzte Lehrer bleibt immer erhalten.
   */
  removeTeacher(teacherId: string): void {
    this.mutate((config) => {
      if (config.teachers.length <= 1) return;
      config.teachers = config.teachers.filter((t) => t.id !== teacherId);
      config.blocks
        .flatMap((block) => block.variants)
        .forEach((variant) => (variant.teacherIds = variant.teacherIds.filter((id) => id !== teacherId)));
    });
  }

  moveTeacher(teacherId: string, offset: -1 | 1): void {
    this.mutate((config) => move(config.teachers, teacherId, offset));
  }

  addTeachingWindow(teacherId: string, weekday: number): void {
    this.mutateTeacher(teacherId, (teacher) =>
      teacher.teachingWindows.push({ id: newId(), weekday, from: '14:00', to: '18:00' }),
    );
  }

  updateTeachingWindow(teacherId: string, windowId: string, change: Partial<Pick<TeachingWindow, 'from' | 'to'>>): void {
    this.mutateTeacher(teacherId, (teacher) => {
      const window = teacher.teachingWindows.find((w) => w.id === windowId);
      if (window) Object.assign(window, change);
    });
  }

  removeTeachingWindow(teacherId: string, windowId: string): void {
    this.mutateTeacher(
      teacherId,
      (teacher) => (teacher.teachingWindows = teacher.teachingWindows.filter((w) => w.id !== windowId)),
    );
  }

  /** Ersetzt die Unterrichtszeiten des Lehrers an diesem Wochentag durch die Standardunterrichtszeiten. */
  applyStandardWindows(teacherId: string, weekday: number): void {
    this.mutate((config) => {
      const teacher = config.teachers.find((t) => t.id === teacherId);
      if (!teacher) return;
      teacher.teachingWindows = [
        ...teacher.teachingWindows.filter((w) => w.weekday !== weekday),
        ...standardWindowsFor(config.calendar, weekday),
      ];
    });
  }

  addStandardWindow(): void {
    this.mutate((config) => config.calendar.defaultWindows.push({ id: newId(), from: '14:00', to: '18:00' }));
  }

  updateStandardWindow(windowId: string, change: Partial<Pick<TimeWindow, 'from' | 'to'>>): void {
    this.mutate((config) => {
      const window = config.calendar.defaultWindows.find((w) => w.id === windowId);
      if (window) Object.assign(window, change);
    });
  }

  removeStandardWindow(windowId: string): void {
    this.mutate(
      (config) => (config.calendar.defaultWindows = config.calendar.defaultWindows.filter((w) => w.id !== windowId)),
    );
  }

  private mutateTeacher(teacherId: string, change: (teacher: Teacher) => void): void {
    this.mutate((config) => {
      const teacher = config.teachers.find((t) => t.id === teacherId);
      if (teacher) change(teacher);
    });
  }

  addSection(type: SectionType): void {
    this.mutate((config) =>
      config.sections.push({
        id: newId(),
        title: type === 'checklist' ? 'Neue Textbausteine' : 'Neues Freitextfeld',
        type,
        scope: 'lesson',
        showTitle: true,
        items: [],
      }),
    );
  }

  renameSection(sectionId: string, title: string): void {
    this.mutateSection(sectionId, (section) => (section.title = title));
  }

  setSectionScope(sectionId: string, scope: SectionScope): void {
    this.mutateSection(sectionId, (section) => (section.scope = scope));
  }

  setShowTitle(sectionId: string, showTitle: boolean): void {
    this.mutateSection(sectionId, (section) => (section.showTitle = showTitle));
  }

  removeSection(sectionId: string): void {
    this.mutate((config) => (config.sections = config.sections.filter((s) => s.id !== sectionId)));
  }

  moveSection(sectionId: string, offset: -1 | 1): void {
    this.mutate((config) => move(config.sections, sectionId, offset));
  }

  addItem(sectionId: string, text: string): void {
    this.mutateSection(sectionId, (section) => section.items.push({ id: newId(), text }));
  }

  updateItem(sectionId: string, itemId: string, text: string): void {
    this.mutateSection(sectionId, (section) => {
      const item = section.items.find((i) => i.id === itemId);
      if (item) item.text = text;
    });
  }

  removeItem(sectionId: string, itemId: string): void {
    this.mutateSection(sectionId, (section) => (section.items = section.items.filter((i) => i.id !== itemId)));
  }

  moveItem(sectionId: string, itemId: string, offset: -1 | 1): void {
    this.mutateSection(sectionId, (section) => move(section.items, itemId, offset));
  }

  exportToFile(): Promise<void> {
    const json = JSON.stringify(this.config(), null, 2);
    return saveFile('feedback-konfiguration.json', new Blob([json], { type: 'application/json' }));
  }

  /** Übernimmt eine exportierte Konfiguration. Wirft einen Fehler, wenn die Datei kein gültiges Format hat. */
  importFromJson(json: string): void {
    this.config.set(parseConfig(JSON.parse(json)));
  }

  resetToDefault(): void {
    this.config.set(defaultConfig());
  }

  addInstrument(name: string): void {
    this.mutate((config) => config.instruments.push({ id: newId(), name }));
  }

  renameInstrument(instrumentId: string, name: string): void {
    this.mutate((config) => {
      const instrument = config.instruments.find((i) => i.id === instrumentId);
      if (instrument) instrument.name = name;
    });
  }

  setDefaultInstrument(instrumentId: string): void {
    this.mutate((config) => (config.defaultInstrumentId = instrumentId));
  }

  /**
   * Entfernt das Instrument auch aus allen Varianten. Personen mit diesem Instrument bekommen das
   * Standardinstrument. Das letzte Instrument bleibt immer erhalten.
   */
  removeInstrument(instrumentId: string): void {
    this.mutate((config) => {
      if (config.instruments.length <= 1) return;
      config.instruments = config.instruments.filter((i) => i.id !== instrumentId);
      config.defaultInstrumentId = defaultInstrument(config).id;
      config.blocks
        .flatMap((block) => block.variants)
        .forEach((variant) => (variant.instrumentIds = variant.instrumentIds.filter((id) => id !== instrumentId)));
    });
  }

  moveInstrument(instrumentId: string, offset: -1 | 1): void {
    this.mutate((config) => move(config.instruments, instrumentId, offset));
  }

  addTextBlock(): void {
    this.mutate((config) =>
      config.blocks.push({ id: newId(), type: 'text', position: 'start', text: '', variants: [] }),
    );
  }

  addImageBlock(image: BlockImage): void {
    this.mutate((config) =>
      config.blocks.push({ id: newId(), type: 'image', position: 'start', text: '', image, variants: [] }),
    );
  }

  setBlockPosition(blockId: string, position: BlockPosition): void {
    this.mutateBlock(blockId, (block) => (block.position = position));
  }

  removeBlock(blockId: string): void {
    this.mutate((config) => (config.blocks = config.blocks.filter((b) => b.id !== blockId)));
  }

  moveBlock(blockId: string, offset: -1 | 1): void {
    this.mutate((config) => move(config.blocks, blockId, offset));
  }

  addVariant(blockId: string): void {
    this.mutateBlock(blockId, (block) =>
      block.variants.push({ id: newId(), instrumentIds: [], teacherIds: [], text: '' }),
    );
  }

  removeVariant(blockId: string, variantId: string): void {
    this.mutateBlock(blockId, (block) => (block.variants = block.variants.filter((v) => v.id !== variantId)));
  }

  /** Hakt ein Instrument (`instrumentIds`) oder einen Lehrer (`teacherIds`) einer Variante an oder ab. */
  toggleVariantCondition(blockId: string, variantId: string, list: 'instrumentIds' | 'teacherIds', id: string): void {
    this.mutateBlock(blockId, (block) => {
      const variant = block.variants.find((v) => v.id === variantId);
      if (!variant) return;
      variant[list] = variant[list].includes(id) ? variant[list].filter((x) => x !== id) : [...variant[list], id];
    });
  }

  /** Ändert den Standardinhalt (`target.variantId` = null) oder eine Variante eines Blocks. */
  updateContent(target: ContentTarget, change: Partial<BlockContent>): void {
    this.mutateContent(target, (content) => Object.assign(content, change));
  }

  updateContentImage(target: ContentTarget, change: Partial<Pick<BlockImage, 'widthMm' | 'align'>>): void {
    this.mutateContent(target, (content) => content.image && Object.assign(content.image, change));
  }

  private mutateContent(target: ContentTarget, change: (content: BlockContent) => void): void {
    this.mutateBlock(target.blockId, (block) => {
      const content = target.variantId ? block.variants.find((v) => v.id === target.variantId) : block;
      if (content) change(content);
    });
  }

  private mutateBlock(blockId: string, change: (block: FixedBlock) => void): void {
    this.mutate((config) => {
      const block = config.blocks.find((b) => b.id === blockId);
      if (block) change(block);
    });
  }

  private mutateSection(sectionId: string, change: (section: Section) => void): void {
    this.mutate((config) => {
      const section = config.sections.find((s) => s.id === sectionId);
      if (section) change(section);
    });
  }

  private mutate(change: (config: FeedbackConfig) => void): void {
    const copy = structuredClone(this.config());
    change(copy);
    this.config.set(copy);
  }
}

function move<T extends { id: string }>(list: T[], id: string, offset: -1 | 1): void {
  const from = list.findIndex((entry) => entry.id === id);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= list.length) return;
  [list[from], list[to]] = [list[to], list[from]];
}

export function parseConfig(data: unknown): FeedbackConfig {
  const config = data as Partial<FeedbackConfig>;
  if (!config || typeof config !== 'object' || !Array.isArray(config.sections)) {
    throw new Error('Die Datei enthält keine Abschnitte.');
  }
  // Ältere Konfigurationen haben noch keine Instrumente; es muss aber immer eins geben.
  const instruments = Array.isArray(config.instruments) ? config.instruments.map(parseInstrument) : [];
  if (instruments.length === 0) instruments.push({ id: newId(), name: 'Instrument' });
  const defaultInstrumentId = instruments.some((i) => i.id === config.defaultInstrumentId)
    ? config.defaultInstrumentId!
    : instruments[0].id;
  return {
    version: 1,
    title: typeof config.title === 'string' ? config.title : 'Unterrichtsfeedback',
    themeColor: isHexColor(config.themeColor) ? config.themeColor : DEFAULT_THEME_COLOR,
    pdfLayout: parsePdfLayout(config.pdfLayout),
    calendar: parseCalendarSettings(config.calendar),
    teachers: parseTeachers(config),
    instruments,
    defaultInstrumentId,
    // Ältere Konfigurationen haben noch keine festen Blöcke.
    blocks: Array.isArray(config.blocks) ? config.blocks.map(parseBlock) : [],
    sections: config.sections.map(parseSection),
  };
}

/** Ältere Konfigurationen haben noch keine Kalender-Einstellungen; dann gilt der Standard. */
function parseCalendarSettings(data: Partial<CalendarSettings> | undefined): CalendarSettings {
  if (!data || typeof data !== 'object') return defaultCalendarSettings();
  return {
    defaultDurationMinutes: Number(data.defaultDurationMinutes) > 0 ? Number(data.defaultDurationMinutes) : 45,
    weeklyByDefault: data.weeklyByDefault !== false,
    // Ältere Konfigurationen haben noch keine Standardunterrichtszeiten.
    defaultWindows: Array.isArray(data.defaultWindows)
      ? parseTimeWindows(data.defaultWindows)
      : defaultCalendarSettings().defaultWindows,
  };
}

/**
 * Es gibt immer mindestens einen Lehrer. Ältere Konfigurationen bekommen einen Lehrer „Lehrkraft“, der die
 * bisher gemeinsamen Unterrichtszeiten (`calendar.teachingWindows`) übernimmt.
 */
function parseTeachers(config: Partial<FeedbackConfig>): Teacher[] {
  const teachers = Array.isArray(config.teachers) ? config.teachers.filter((t) => typeof t?.name === 'string') : [];
  if (teachers.length > 0) {
    return teachers.map((t: Teacher) => ({
      id: typeof t.id === 'string' ? t.id : newId(),
      name: t.name,
      instrumentId: typeof t.instrumentId === 'string' ? t.instrumentId : null,
      location: typeof t.location === 'string' ? t.location : '',
      teachingWindows: parseTeachingWindows(t.teachingWindows),
    }));
  }
  const legacyWindows = (config.calendar as { teachingWindows?: unknown } | undefined)?.teachingWindows;
  return [{
    id: newId(),
    name: 'Lehrkraft',
    instrumentId: null,
    location: '',
    teachingWindows: legacyWindows === undefined ? defaultTeachingWindows() : parseTeachingWindows(legacyWindows),
  }];
}

function parseTeachingWindows(data: unknown): TeachingWindow[] {
  return (Array.isArray(data) ? data : [])
    .filter((w) => Number.isInteger(w?.weekday) && w.weekday >= 0 && w.weekday <= 6)
    .flatMap((w) => parseTimeWindows([w]).map((window) => ({ ...window, weekday: w.weekday })));
}

function parseTimeWindows(data: unknown[]): TimeWindow[] {
  const time = (value: unknown) => typeof value === 'string' && /^\d{2}:\d{2}$/.test(value);
  return (data as Partial<TimeWindow>[])
    .filter((w) => time(w?.from) && time(w?.to))
    .map((w) => ({ id: typeof w.id === 'string' ? w.id : newId(), from: w.from!, to: w.to! }));
}

/** Ältere Konfigurationen haben noch keine Kopf- und Fußzeile; fehlende Werte kommen vom Standard. */
function parsePdfLayout(data: Partial<PdfLayout> | undefined): PdfLayout {
  const text = (key: Exclude<keyof PdfLayout, 'showInfoLine'>) =>
    typeof data?.[key] === 'string' ? data[key] : DEFAULT_PDF_LAYOUT[key];
  return {
    subtitle: text('subtitle'),
    showInfoLine: typeof data?.showInfoLine === 'boolean' ? data.showInfoLine : DEFAULT_PDF_LAYOUT.showInfoLine,
    runningHeader: text('runningHeader'),
    footerLeft: text('footerLeft'),
    footerCenter: text('footerCenter'),
    footerRight: text('footerRight'),
  };
}

function parseInstrument(data: Partial<Instrument>): Instrument {
  if (typeof data?.name !== 'string') {
    throw new Error('Ein Instrument hat keinen Namen.');
  }
  return { id: typeof data.id === 'string' ? data.id : newId(), name: data.name };
}

function parseBlock(data: Partial<FixedBlock>): FixedBlock {
  if (data?.type !== 'text' && data?.type !== 'image') {
    throw new Error('Ein fester Block hat einen unbekannten Typ.');
  }
  return {
    id: typeof data.id === 'string' ? data.id : newId(),
    type: data.type,
    position: data.position === 'end' ? 'end' : 'start',
    ...parseContent(data),
    variants: Array.isArray(data.variants) ? data.variants.map(parseVariant) : [],
  };
}

function parseVariant(data: Partial<BlockVariant>): BlockVariant {
  return {
    id: typeof data?.id === 'string' ? data.id : newId(),
    instrumentIds: Array.isArray(data?.instrumentIds) ? data.instrumentIds.filter((id) => typeof id === 'string') : [],
    // Ältere Varianten kennen nur Instrumente.
    teacherIds: Array.isArray(data?.teacherIds) ? data.teacherIds.filter((id) => typeof id === 'string') : [],
    ...parseContent(data),
  };
}

function parseContent(data: Partial<BlockContent>): BlockContent {
  if (data.image !== undefined && typeof data.image?.dataUrl !== 'string') {
    throw new Error('Ein festes Bild enthält keine Bilddaten.');
  }
  return { text: typeof data.text === 'string' ? data.text : '', image: data.image };
}

function parseSection(data: Partial<Section>): Section {
  if (typeof data?.title !== 'string' || (data.type !== 'checklist' && data.type !== 'text')) {
    throw new Error('Ein Abschnitt hat keinen Titel oder einen unbekannten Typ.');
  }
  const items = Array.isArray(data.items) ? data.items : [];
  return {
    id: typeof data.id === 'string' ? data.id : newId(),
    title: data.title,
    type: data.type,
    // Ältere Konfigurationen kennen den allgemeinen Teil noch nicht.
    scope: data.scope === 'general' ? 'general' : 'lesson',
    showTitle: data.showTitle !== false,
    items: items
      .filter((item) => typeof item?.text === 'string')
      .map((item) => ({ id: typeof item.id === 'string' ? item.id : newId(), text: item.text })),
  };
}

function defaultConfig(): FeedbackConfig {
  const checklist = (title: string, texts: string[], scope: SectionScope = 'lesson'): Section => ({
    id: newId(),
    title,
    type: 'checklist',
    scope,
    showTitle: true,
    items: texts.map((text) => ({ id: newId(), text })),
  });
  const text = (title: string): Section => ({ id: newId(), title, type: 'text', scope: 'lesson', showTitle: true, items: [] });

  const piano = { id: newId(), name: 'Klavier' };
  const guitar = { id: newId(), name: 'Gitarre' };
  const violin = { id: newId(), name: 'Violine' };

  return {
    version: 1,
    title: 'Dein Feedback zum Unterricht',
    themeColor: DEFAULT_THEME_COLOR,
    pdfLayout: { ...DEFAULT_PDF_LAYOUT },
    calendar: defaultCalendarSettings(),
    teachers: [
      { id: newId(), name: 'Lehrkraft', instrumentId: piano.id, location: '', teachingWindows: defaultTeachingWindows() },
    ],
    instruments: [piano, guitar, violin],
    defaultInstrumentId: piano.id,
    blocks: [
      {
        id: newId(),
        type: 'text',
        position: 'start',
        text: 'Hallo {vorname},\n\nhier ist meine Rückmeldung zu unserem Unterricht. Lies sie dir in Ruhe durch und nimm die Aufgaben mit in deine Übezeit.',
        variants: [],
      },
      {
        id: newId(),
        type: 'text',
        position: 'end',
        text: 'Viel Spaß beim Üben und bis zur nächsten Stunde!',
        variants: [
          {
            id: newId(),
            instrumentIds: [guitar.id, violin.id],
            teacherIds: [],
            text: 'Viel Spaß beim Üben und bis zur nächsten Stunde! Denk daran, deine {instrument} vor dem Spielen zu stimmen.',
          },
        ],
      },
    ],
    sections: [
      checklist(
        'Das zeichnet dich aus',
        [
          'Du kommst mit viel Freude und Neugier in den Unterricht.',
          'Du stellst gute Fragen und willst die Dinge wirklich verstehen.',
          'Auch bei schwierigen Stellen bleibst du geduldig dran.',
        ],
        'general',
      ),
      text('Unser Thema heute'),
      checklist('Vorbereitung', [
        'Du hast gut geübt und warst sehr gut vorbereitet.',
        'Du hast geübt, an einigen Stellen dürfen wir noch weiterarbeiten.',
        'Diese Woche bist du wenig zum Üben gekommen. Nimm dir bis zur nächsten Stunde etwas mehr Zeit dafür.',
      ]),
      checklist('Mitarbeit', [
        'Du hast konzentriert und motiviert mitgearbeitet.',
        'Du hast meine Anregungen schnell umgesetzt.',
        'Heute warst du etwas unkonzentriert, das kommt vor.',
      ]),
      checklist('Fortschritt', [
        'Seit der letzten Stunde hast du deutliche Fortschritte gemacht.',
        'Deine Technik hat sich verbessert.',
        'Rhythmus und Timing sind bei dir sicherer geworden.',
        'Dein Ausdruck und deine Gestaltung sind gewachsen.',
      ]),
      text('Das ist mir aufgefallen'),
      text('Deine Aufgaben bis zur nächsten Stunde'),
    ],
  };
}
