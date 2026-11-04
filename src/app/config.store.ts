import { computed, Injectable } from '@angular/core';
import {
  BlockContent,
  BlockImage,
  BlockPosition,
  BlockVariant,
  CalendarSettings,
  ContentKind,
  CalendarPdfTexts,
  DEFAULT_CALENDAR_PDF_TEXTS,
  DEFAULT_PDF_LAYOUT,
  defaultCalendarSettings,
  defaultTeachingWindows,
  defaultInstrument,
  FeedbackConfig,
  FixedBlock,
  APP_LOGO_PATH,
  LEGACY_APP_LOGO_PATH,
  Instrument,
  LOGO_HEIGHT_LIMITS,
  PdfLayout,
  PdfLogo,
  Period,
  ReportPeriodEntry,
  schoolHalfYear,
  today,
  newId,
  Section,
  SectionScope,
  SectionType,
  Teacher,
  TeachingWindow,
  WindowsOwner,
  teachingWindowsFor,
  TimeWindow,
  standardWindowsFor,
} from './model';
import { addDays, daysBetween } from './calendar/appointments';
import { saveFile } from './save-file';
import { storedSignal } from './stored-signal';
import { DEFAULT_THEME_COLOR, isHexColor, themeFrom } from './theme';

/** Angaben aus der Begrüßung beim ersten Start */
export interface TeacherSetup {
  name: string;
  instrument: string;
  teachingWindows: TeachingWindow[];
  themeColor: string;
  reportPeriod: Pick<ReportPeriodEntry, 'name' | 'from' | 'to'>;
}

/** Standardinhalt (`variantId` = null) oder eine Variante eines festen Blocks */
export interface ContentTarget {
  blockId: string;
  variantId: string | null;
}

@Injectable({ providedIn: 'root' })
export class ConfigStore {
  /**
   * Erster Start: Bis die Begrüßung abgeschlossen ist, steht in der Konfiguration nur ein vorläufiger Lehrer.
   * Muss vor `config` stehen, denn nur vor deren erstem Speichern ist erkennbar, ob schon Daten da waren.
   */
  readonly setupPending = storedSignal<boolean>(
    'feedback.setupPending',
    () => localStorage.getItem('feedback.config') === null,
    (data) => data === true,
  );
  readonly config = storedSignal<FeedbackConfig>('feedback.config', defaultConfig, parseConfig);

  readonly theme = computed(() => themeFrom(this.config().themeColor));

  setTitle(title: string): void {
    this.mutate((config) => (config.title = title));
  }

  setPdfLayout(change: Partial<PdfLayout>): void {
    this.mutate((config) => Object.assign(config.pdfLayout, change));
  }

  resetPdfLayout(): void {
    // Nur die Texte: Logos entfernt man einzeln, und der Schwarzweißmodus gehört nicht zu Kopf- und Fußzeile.
    this.mutate(
      (config) =>
        (config.pdfLayout = {
          ...DEFAULT_PDF_LAYOUT,
          headerLogo: config.pdfLayout.headerLogo,
          footerLogo: config.pdfLayout.footerLogo,
          grayscale: config.pdfLayout.grayscale,
        }),
    );
  }

  setThemeColor(color: string): void {
    if (isHexColor(color)) this.mutate((config) => (config.themeColor = color.toLowerCase()));
  }

  setCalendarDefaults(change: Partial<CalendarSettings>): void {
    this.mutate((config) => Object.assign(config.calendar, change));
  }

  setCalendarPdfTexts(change: Partial<CalendarPdfTexts>): void {
    this.mutate((config) => Object.assign(config.calendarPdf, change));
  }

  resetCalendarPdfTexts(): void {
    this.mutate((config) => (config.calendarPdf = { ...DEFAULT_CALENDAR_PDF_TEXTS }));
  }

  /**
   * Ein neuer Lehrer ist in allen laufenden und künftigen Berichtszeiträumen aktiv. Ohne Instrument gilt das
   * Standardinstrument, ein unbekanntes wird angelegt. Gibt die ID des Lehrers zurück.
   */
  addTeacher(name: string, instrumentName?: string): string {
    const instrumentId = instrumentName ? this.ensureInstruments([instrumentName]).get(instrumentName.trim().toLowerCase()) : null;
    const id = newId();
    this.mutate((config) => {
      config.teachers.push({
        id,
        name,
        instrumentId: instrumentId ?? config.defaultInstrumentId,
        location: '',
        teachingWindows: defaultTeachingWindows(config.calendar),
        periodWindows: {},
      });
      config.reportPeriods.filter((period) => period.to >= today()).forEach((period) => period.teacherIds.push(id));
    });
    return id;
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
      config.reportPeriods.forEach((period) => (period.teacherIds = period.teacherIds.filter((id) => id !== teacherId)));
      [...config.blocks, ...config.groupBlocks]
        .flatMap((block) => block.variants)
        .forEach((variant) => (variant.teacherIds = variant.teacherIds.filter((id) => id !== teacherId)));
    });
  }

  /**
   * Kopie direkt hinter dem Lehrer: Instrument, Ort und Unterrichtszeiten gleich, aktiv in denselben
   * Berichtszeiträumen. Personen, Termine und Textvarianten bleiben beim Original. Liefert die ID der Kopie.
   */
  duplicateTeacher(teacherId: string): string | null {
    const original = this.config().teachers.find((t) => t.id === teacherId);
    if (!original) return null;
    const id = newId();
    this.mutate((config) => {
      const copy: Teacher = {
        ...original,
        id,
        name: `${original.name} (Kopie)`,
        teachingWindows: copyWindows(original.teachingWindows),
        periodWindows: Object.fromEntries(
          Object.entries(original.periodWindows).map(([periodId, windows]) => [periodId, copyWindows(windows)]),
        ),
      };
      config.teachers.splice(config.teachers.findIndex((t) => t.id === teacherId) + 1, 0, copy);
      config.reportPeriods.filter((period) => period.teacherIds.includes(teacherId)).forEach((period) => period.teacherIds.push(id));
    });
    return id;
  }

  moveTeacher(teacherId: string, offset: -1 | 1): void {
    this.mutate((config) => move(config.teachers, teacherId, offset));
  }

  /*
   * Unterrichtszeiten gehören einem Lehrer in einem Berichtszeitraum oder, gemeinsam für alle, dem Zeitraum (siehe
   * `WindowsOwner`). Hat der Lehrer im Zeitraum noch keine eigenen, bekommt er dabei eine Kopie seiner Standardzeiten.
   */

  windowsOf(owner: WindowsOwner): TeachingWindow[] {
    const config = this.config();
    if ('sharedPeriodId' in owner) return config.reportPeriods.find((p) => p.id === owner.sharedPeriodId)?.sharedWindows ?? [];
    const teacher = config.teachers.find((t) => t.id === owner.teacherId);
    return teacher ? teachingWindowsFor(teacher, owner.periodId) : [];
  }

  addTeachingWindow(owner: WindowsOwner, weekday: number): void {
    this.mutateWindows(owner, (windows) => [...windows, { id: newId(), weekday, from: '14:00', to: '18:00' }]);
  }

  updateTeachingWindow(owner: WindowsOwner, windowId: string, change: Partial<Pick<TeachingWindow, 'from' | 'to'>>): void {
    this.mutateWindows(owner, (windows) => windows.map((w) => (w.id === windowId ? { ...w, ...change } : w)));
  }

  removeTeachingWindow(owner: WindowsOwner, windowId: string): void {
    this.mutateWindows(owner, (windows) => windows.filter((w) => w.id !== windowId));
  }

  /** Ersetzt die Unterrichtszeiten an diesem Wochentag durch die Standardunterrichtszeiten. */
  applyStandardWindows(owner: WindowsOwner, weekday: number): void {
    const standard = standardWindowsFor(this.config().calendar, weekday);
    this.mutateWindows(owner, (windows) => [...windows.filter((w) => w.weekday !== weekday), ...standard]);
  }

  /**
   * Gemeinsame Unterrichtszeiten für alle Lehrer im Zeitraum ein- oder ausschalten. Beim Einschalten beginnen sie
   * mit den Zeiten des ersten aktiven Lehrers, sonst mit den Standardunterrichtszeiten; beim Ausschalten gelten
   * wieder die eigenen Zeiten der Lehrer, die dabei unverändert geblieben sind.
   */
  setSharedWindows(periodId: string, shared: boolean): void {
    this.mutate((config) => {
      const period = config.reportPeriods.find((p) => p.id === periodId);
      if (!period || shared === !!period.sharedWindows) return;
      if (!shared) {
        delete period.sharedWindows;
        return;
      }
      const teacher = config.teachers.find((t) => period.teacherIds.includes(t.id));
      period.sharedWindows = copyWindows(
        teacher ? teachingWindowsFor(teacher, periodId) : defaultTeachingWindows(config.calendar),
      );
    });
  }

  private mutateWindows(owner: WindowsOwner, change: (windows: TeachingWindow[]) => TeachingWindow[]): void {
    this.mutate((config) => {
      if ('sharedPeriodId' in owner) {
        const period = config.reportPeriods.find((p) => p.id === owner.sharedPeriodId);
        if (period) period.sharedWindows = change(period.sharedWindows ?? []);
        return;
      }
      const teacher = config.teachers.find((t) => t.id === owner.teacherId);
      if (!teacher) return;
      const next = change(teachingWindowsFor(teacher, owner.periodId));
      if (owner.periodId) teacher.periodWindows[owner.periodId] = next;
      else teacher.teachingWindows = next;
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

  addSection(type: SectionType, kind: ContentKind = 'single'): void {
    this.mutate((config) =>
      sectionsOf(config, kind).push({
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
    this.mutate((config) => {
      config.sections = config.sections.filter((s) => s.id !== sectionId);
      config.groupSections = config.groupSections.filter((s) => s.id !== sectionId);
    });
  }

  moveSection(sectionId: string, offset: -1 | 1): void {
    this.mutate((config) => {
      move(config.sections, sectionId, offset);
      move(config.groupSections, sectionId, offset);
    });
  }

  /** Gibt die ID des neuen Textbausteins zurück. */
  addItem(sectionId: string, text: string): string {
    const id = newId();
    this.mutateSection(sectionId, (section) => section.items.push({ id, text }));
    return id;
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

  /** Macht aus dem vorläufigen Lehrer den eigenen; sein Instrument wird zum Standardinstrument. */
  completeSetup(setup: TeacherSetup): void {
    this.mutate((config) => {
      // Die Vorlage hat nur das vorläufige Instrument; es wird zum eigenen.
      const instrument = { id: config.defaultInstrumentId, name: setup.instrument.trim() };
      config.instruments = [instrument];
      config.defaultInstrumentId = instrument.id;
      Object.assign(config.teachers[0], {
        name: setup.name.trim(),
        instrumentId: instrument.id,
        teachingWindows: setup.teachingWindows,
        periodWindows: {},
      });
      if (isHexColor(setup.themeColor)) config.themeColor = setup.themeColor.toLowerCase();
      config.reportPeriods = [
        { id: newId(), ...setup.reportPeriod, name: setup.reportPeriod.name.trim(), teacherIds: [config.teachers[0].id] },
      ];
    });
    this.setupPending.set(false);
  }

  /**
   * Legt einen Zeitraum an und liefert seine ID. Ohne Angabe folgt er direkt auf den spätesten: als nächstes
   * Schulhalbjahr, wenn der späteste mit einem Halbjahr endet, sonst gleich lang.
   */
  addReportPeriod(period: Omit<ReportPeriodEntry, 'id'> = this.followingPeriod()): string {
    const id = newId();
    this.mutate((config) => {
      // Die Lehrer behalten ihre Unterrichtszeiten aus dem spätesten Zeitraum; ändern lassen sie sich danach je Zeitraum.
      const latest = [...config.reportPeriods].sort((a, b) => a.to.localeCompare(b.to)).at(-1);
      config.teachers.forEach((teacher) => (teacher.periodWindows[id] = copyWindows(teachingWindowsFor(teacher, latest?.id ?? null))));
      // Gemeinsame Zeiten übernimmt der neue Zeitraum ebenso.
      const shared = latest?.sharedWindows ? { sharedWindows: copyWindows(latest.sharedWindows) } : {};
      config.reportPeriods.push({ id, ...period, ...shared });
    });
    return id;
  }

  private followingPeriod(): Omit<ReportPeriodEntry, 'id'> {
    const latest = [...this.config().reportPeriods].sort((a, b) => a.to.localeCompare(b.to)).at(-1)!;
    const start = addDays(latest.to, 1);
    const halfYear = schoolHalfYear(start);
    // Wer zuletzt unterrichtet hat, ist meist auch im nächsten Zeitraum dabei.
    const teacherIds = [...latest.teacherIds];
    if (halfYear.from === start) return { name: halfYear.name, from: halfYear.from, to: halfYear.to, teacherIds };
    return { name: 'Neuer Zeitraum', from: start, to: addDays(start, daysBetween(latest.from, latest.to).length - 1), teacherIds };
  }

  updateReportPeriod(periodId: string, change: Partial<Omit<ReportPeriodEntry, 'id'>>): void {
    this.mutate((config) => {
      const period = config.reportPeriods.find((p) => p.id === periodId);
      if (period) Object.assign(period, change);
    });
  }

  toggleReportPeriodTeacher(periodId: string, teacherId: string): void {
    this.mutate((config) => {
      const period = config.reportPeriods.find((p) => p.id === periodId);
      if (!period) return;
      period.teacherIds = period.teacherIds.includes(teacherId)
        ? period.teacherIds.filter((id) => id !== teacherId)
        : [...period.teacherIds, teacherId];
    });
  }

  /** Entfernt den Zeitraum auch aus allen Varianten. Der letzte Zeitraum bleibt immer erhalten. */
  removeReportPeriod(periodId: string): void {
    this.mutate((config) => {
      if (config.reportPeriods.length <= 1) return;
      config.reportPeriods = config.reportPeriods.filter((p) => p.id !== periodId);
      config.teachers.forEach((teacher) => delete teacher.periodWindows[periodId]);
      [...config.blocks, ...config.groupBlocks]
        .flatMap((block) => block.variants)
        .forEach((variant) => (variant.periodIds = variant.periodIds.filter((id) => id !== periodId)));
    });
  }

  /** Setzt Texte, Abschnitte und Gestaltung auf die Vorlage zurück; Lehrer, Instrumente und Zeiträume bleiben. */
  resetToDefault(): void {
    const { teachers, instruments, defaultInstrumentId, reportPeriods } = this.config();
    this.config.set({ ...defaultConfig(), teachers, instruments, defaultInstrumentId, reportPeriods });
  }

  addInstrument(name: string): void {
    this.mutate((config) => config.instruments.push({ id: newId(), name }));
  }

  /**
   * IDs der Instrumente mit diesen Namen (Groß-/Kleinschreibung egal); fehlende werden angelegt. Schlüssel der
   * Ergebnis-Map ist der Name in Kleinbuchstaben.
   */
  ensureInstruments(names: string[]): Map<string, string> {
    const ids = new Map(this.config().instruments.map((i) => [i.name.trim().toLowerCase(), i.id]));
    const missing = [...new Set(names.map((n) => n.trim()).filter((n) => n && !ids.has(n.toLowerCase())))];
    const unique = missing.filter((name, i) => missing.findIndex((m) => m.toLowerCase() === name.toLowerCase()) === i);
    if (unique.length > 0) {
      const created = unique.map((name) => ({ id: newId(), name }));
      created.forEach((i) => ids.set(i.name.toLowerCase(), i.id));
      this.mutate((config) => config.instruments.push(...created));
    }
    return ids;
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
      [...config.blocks, ...config.groupBlocks]
        .flatMap((block) => block.variants)
        .forEach((variant) => (variant.instrumentIds = variant.instrumentIds.filter((id) => id !== instrumentId)));
    });
  }

  moveInstrument(instrumentId: string, offset: -1 | 1): void {
    this.mutate((config) => move(config.instruments, instrumentId, offset));
  }

  addTextBlock(kind: ContentKind = 'single'): void {
    this.mutate((config) =>
      blocksOf(config, kind).push({ id: newId(), type: 'text', position: 'start', text: '', variants: [] }),
    );
  }

  addImageBlock(image: BlockImage, kind: ContentKind = 'single'): void {
    this.mutate((config) =>
      blocksOf(config, kind).push({ id: newId(), type: 'image', position: 'start', text: '', image, variants: [] }),
    );
  }

  setBlockPosition(blockId: string, position: BlockPosition): void {
    this.mutateBlock(blockId, (block) => (block.position = position));
  }

  removeBlock(blockId: string): void {
    this.mutate((config) => {
      config.blocks = config.blocks.filter((b) => b.id !== blockId);
      config.groupBlocks = config.groupBlocks.filter((b) => b.id !== blockId);
    });
  }

  moveBlock(blockId: string, offset: -1 | 1): void {
    this.mutate((config) => {
      move(config.blocks, blockId, offset);
      move(config.groupBlocks, blockId, offset);
    });
  }

  addVariant(blockId: string): void {
    this.mutateBlock(blockId, (block) =>
      block.variants.push({ id: newId(), instrumentIds: [], teacherIds: [], periodIds: [], text: '' }),
    );
  }

  removeVariant(blockId: string, variantId: string): void {
    this.mutateBlock(blockId, (block) => (block.variants = block.variants.filter((v) => v.id !== variantId)));
  }

  /** Hakt ein Instrument, einen Lehrer oder einen Berichtszeitraum einer Variante an oder ab. */
  toggleVariantCondition(
    blockId: string,
    variantId: string,
    list: 'instrumentIds' | 'teacherIds' | 'periodIds',
    id: string,
  ): void {
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
      // IDs sind eindeutig; der Block kann bei Einzelunterricht oder Gruppen stehen.
      const block = [...config.blocks, ...config.groupBlocks].find((b) => b.id === blockId);
      if (block) change(block);
    });
  }

  private mutateSection(sectionId: string, change: (section: Section) => void): void {
    this.mutate((config) => {
      const section = [...config.sections, ...config.groupSections].find((s) => s.id === sectionId);
      if (section) change(section);
    });
  }

  private mutate(change: (config: FeedbackConfig) => void): void {
    const copy = structuredClone(this.config());
    change(copy);
    this.config.set(copy);
  }
}

export function sectionsOf(config: FeedbackConfig, kind: ContentKind): Section[] {
  return kind === 'group' ? config.groupSections : config.sections;
}

export function blocksOf(config: FeedbackConfig, kind: ContentKind): FixedBlock[] {
  return kind === 'group' ? config.groupBlocks : config.blocks;
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
  const teachers = parseTeachers(config);
  const defaultInstrumentId = instruments.some((i) => i.id === config.defaultInstrumentId)
    ? config.defaultInstrumentId!
    : instruments[0].id;
  return {
    version: 1,
    title: typeof config.title === 'string' ? config.title : 'Unterrichtsfeedback',
    themeColor: isHexColor(config.themeColor) ? config.themeColor : DEFAULT_THEME_COLOR,
    pdfLayout: parsePdfLayout(config.pdfLayout),
    calendar: parseCalendarSettings(config.calendar),
    teachers,
    instruments,
    defaultInstrumentId,
    // Ältere Konfigurationen haben noch keine festen Blöcke.
    blocks: Array.isArray(config.blocks) ? config.blocks.map(parseBlock) : [],
    sections: config.sections.map(parseSection),
    // … und noch keine Inhalte für Gruppen; dann gilt die Vorlage.
    groupBlocks: Array.isArray(config.groupBlocks) ? config.groupBlocks.map(parseBlock) : defaultGroupBlocks(),
    groupSections: Array.isArray(config.groupSections) ? config.groupSections.map(parseSection) : defaultGroupSections(),
    reportPeriods: parseReportPeriods(config.reportPeriods, teachers.map((t) => t.id)),
    calendarPdf: parseCalendarPdfTexts(config.calendarPdf),
  };
}

/**
 * Ältere Konfigurationen haben noch keine Berichtszeiträume; dann gilt das aktuelle Schulhalbjahr. Zeiträume ohne
 * Lehrerliste (ebenfalls älter) gelten für alle Lehrer.
 */
function parseReportPeriods(data: unknown, allTeacherIds: string[]): ReportPeriodEntry[] {
  const periods = (Array.isArray(data) ? (data as Partial<ReportPeriodEntry>[]) : [])
    .filter((p) => typeof p?.id === 'string' && typeof p.name === 'string' && isPeriod(p))
    .map((p) => ({
      id: p.id!,
      name: p.name!,
      from: p.from!,
      to: p.to!,
      teacherIds: Array.isArray(p.teacherIds) ? p.teacherIds.filter((id) => typeof id === 'string') : [...allTeacherIds],
      ...(Array.isArray(p.sharedWindows) ? { sharedWindows: parseTeachingWindows(p.sharedWindows) } : {}),
    }));
  return periods.length > 0 ? periods : [{ ...schoolHalfYear(today()), teacherIds: [...allTeacherIds] }];
}

export function isPeriod(data: Partial<Period> | null | undefined): data is Period {
  const isDate = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  return isDate(data?.from) && isDate(data?.to) && data!.from! <= data!.to!;
}


/** Ältere Konfigurationen haben noch keine Texte für die Kalender-PDFs; fehlende kommen vom Standard. */
function parseCalendarPdfTexts(data: Partial<CalendarPdfTexts> | undefined): CalendarPdfTexts {
  const texts = { ...DEFAULT_CALENDAR_PDF_TEXTS };
  for (const key of Object.keys(texts) as (keyof CalendarPdfTexts)[]) {
    if (typeof data?.[key] === 'string') texts[key] = data[key];
  }
  return texts;
}

/** Ältere Konfigurationen haben noch keine Kalender-Einstellungen; dann gilt der Standard. */
function parseCalendarSettings(data: Partial<CalendarSettings> | undefined): CalendarSettings {
  const defaults = defaultCalendarSettings();
  if (!data || typeof data !== 'object') return defaults;
  return {
    defaultDurationMinutes:
      Number(data.defaultDurationMinutes) > 0 ? Number(data.defaultDurationMinutes) : defaults.defaultDurationMinutes,
    // Früher hieß die Einstellung „Jede Woche wiederholen“ (`weeklyByDefault`).
    repeatByDefault: [data.repeatByDefault, (data as { weeklyByDefault?: unknown }).weeklyByDefault].find(
      (value): value is boolean => typeof value === 'boolean',
    ) ?? defaults.repeatByDefault,
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
      // Ältere Lehrer haben noch keine Zeiten je Berichtszeitraum; dort gelten die allgemeinen.
      periodWindows: parsePeriodWindows(t.periodWindows),
    }));
  }
  const legacyWindows = (config.calendar as { teachingWindows?: unknown } | undefined)?.teachingWindows;
  return [{
    id: newId(),
    name: 'Lehrkraft',
    instrumentId: null,
    location: '',
    teachingWindows: legacyWindows === undefined ? defaultTeachingWindows() : parseTeachingWindows(legacyWindows),
    periodWindows: {},
  }];
}

function parsePeriodWindows(data: unknown): Record<string, TeachingWindow[]> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  return Object.fromEntries(Object.entries(data).map(([periodId, windows]) => [periodId, parseTeachingWindows(windows)]));
}

/** Gleiche Zeiten mit neuen IDs, damit sich Kopie und Original unabhängig ändern lassen */
function copyWindows(windows: TeachingWindow[]): TeachingWindow[] {
  return windows.map((window) => ({ ...window, id: newId() }));
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
  const text = (key: 'subtitle' | 'runningHeader' | 'footerLeft' | 'footerCenter' | 'footerRight') =>
    typeof data?.[key] === 'string' ? data[key] : DEFAULT_PDF_LAYOUT[key];
  return {
    subtitle: text('subtitle'),
    showInfoLine: typeof data?.showInfoLine === 'boolean' ? data.showInfoLine : DEFAULT_PDF_LAYOUT.showInfoLine,
    runningHeader: text('runningHeader'),
    footerLeft: text('footerLeft'),
    footerCenter: text('footerCenter'),
    footerRight: text('footerRight'),
    // Fehlt das Feld (ältere Konfiguration), gilt das App-Logo; `null` heißt: bewusst entfernt.
    headerLogo:
      data?.headerLogo === undefined ? DEFAULT_PDF_LAYOUT.headerLogo : parseLogo(data.headerLogo, LOGO_HEIGHT_LIMITS.headerLogo),
    footerLogo: parseLogo(data?.footerLogo, LOGO_HEIGHT_LIMITS.footerLogo),
    grayscale: data?.grayscale === true,
  };
}

/** Nur eingebettete Bilder oder das App-Logo, keine fremden Adressen aus einer synchronisierten Datei */
function isLogoSource(source: unknown): source is string {
  return (
    typeof source === 'string' &&
    (source.startsWith('data:image/') || source === APP_LOGO_PATH || source === LEGACY_APP_LOGO_PATH)
  );
}

function parseLogo(data: Partial<PdfLogo> | null | undefined, limits: { min: number; max: number }): PdfLogo | null {
  if (!data || !isLogoSource(data.dataUrl) || !(Number(data.widthPx) > 0) || !(Number(data.heightPx) > 0)) return null;
  const height = Number(data.heightMm);
  return {
    dataUrl: data.dataUrl === LEGACY_APP_LOGO_PATH ? APP_LOGO_PATH : data.dataUrl,
    widthPx: Number(data.widthPx),
    heightPx: Number(data.heightPx),
    heightMm: Math.min(limits.max, Math.max(limits.min, Number.isFinite(height) ? height : limits.min)),
    align: data.align === 'left' || data.align === 'center' ? data.align : 'right',
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
    // Ältere Varianten kennen nur Instrumente, dann auch Lehrer, aber noch keine Zeiträume.
    teacherIds: Array.isArray(data?.teacherIds) ? data.teacherIds.filter((id) => typeof id === 'string') : [],
    periodIds: Array.isArray(data?.periodIds) ? data.periodIds.filter((id) => typeof id === 'string') : [],
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

const checklist = (title: string, texts: string[], scope: SectionScope = 'lesson'): Section => ({
  id: newId(),
  title,
  type: 'checklist',
  scope,
  showTitle: true,
  items: texts.map((text) => ({ id: newId(), text })),
});
const text = (title: string): Section => ({ id: newId(), title, type: 'text', scope: 'lesson', showTitle: true, items: [] });

/** Vorlage für Gruppenstunden: in der Ihr-Form, an die ganze Gruppe gerichtet */
function defaultGroupSections(): Section[] {
  return [
    checklist(
      'Das zeichnet euch aus',
      [
        'Ihr kommt mit viel Freude in den gemeinsamen Unterricht.',
        'Ihr hört gut aufeinander und unterstützt euch gegenseitig.',
      ],
      'general',
    ),
    text('Unser Thema heute'),
    checklist('Zusammenspiel', [
        'Ihr habt sehr gut zusammengespielt und aufeinander gehört.',
        'Das gemeinsame Tempo war schon sehr sicher.',
        'Beim Zusammenspiel dürfen wir noch genauer aufeinander achten.',
    ]),
    text('Eure Aufgaben bis zur nächsten Stunde'),
  ];
}

function defaultGroupBlocks(): FixedBlock[] {
  return [
    {
      id: newId(),
      type: 'text',
      position: 'start',
      text: 'Hallo {mitglieder},\n\nhier ist meine Rückmeldung zu unserem gemeinsamen Unterricht.',
      variants: [],
    },
    { id: newId(), type: 'text', position: 'end', text: 'Viel Spaß beim gemeinsamen Üben!', variants: [] },
  ];
}

/**
 * Vorlage beim ersten Start. Lehrer und Instrument sind vorläufig, bis die Begrüßung sie ersetzt
 * (`completeSetup`); es muss aber immer mindestens eins von beiden geben.
 */
function defaultConfig(): FeedbackConfig {
  const instrument = { id: newId(), name: 'Instrument' };
  const teacherId = newId();

  return {
    version: 1,
    title: 'Dein Feedback zum Unterricht',
    themeColor: DEFAULT_THEME_COLOR,
    pdfLayout: { ...DEFAULT_PDF_LAYOUT },
    calendar: defaultCalendarSettings(),
    teachers: [
      {
        id: teacherId,
        name: 'Lehrkraft',
        instrumentId: instrument.id,
        location: '',
        teachingWindows: defaultTeachingWindows(),
        periodWindows: {},
      },
    ],
    instruments: [instrument],
    defaultInstrumentId: instrument.id,
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
        variants: [],
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
    groupBlocks: defaultGroupBlocks(),
    groupSections: defaultGroupSections(),
    reportPeriods: [{ ...schoolHalfYear(today()), teacherIds: [teacherId] }],
    calendarPdf: { ...DEFAULT_CALENDAR_PDF_TEXTS },
  };
}
