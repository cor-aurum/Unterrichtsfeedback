import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject, linkedSignal, signal } from '@angular/core';
import { ActiveTeacher } from '../active-teacher';
import { blocksOf, ConfigStore, sectionsOf } from '../config.store';
import {
  APP_LOGO,
  BlockVariant,
  byPeriodOrder,
  CalendarPdfTexts,
  ContentKind,
  DEFAULT_CALENDAR_PDF_TEXTS,
  DEFAULT_PDF_LAYOUT,
  defaultInstrument,
  FixedBlock,
  GROUP_PLACEHOLDERS,
  ImageAlign,
  Instrument,
  isVisibleTo,
  locationIn,
  LOGO_HEIGHT_LIMITS,
  PdfLogo,
  PLACEHOLDERS,
  ReportPeriodEntry,
  Section,
  Teacher,
  teacherInstrument,
  TimeWindow,
} from '../model';
import { BlockContentEditor } from './block-content-editor';
import { readImageFile } from './image-file';
import { InstrumentSelect } from '../instrument-select';
import { TeachingWindowsEditor } from './teaching-windows-editor';
import { PlanLinkPanel } from '../plans/plan-link-panel';
import { realServerLogin } from '../plans/plan-access';
import { labelOf, ReportPeriod } from '../report-period';
import { demoMode, storedSignal } from '../stored-signal';
import { serverApi } from '../sync/server-folder';
import { ServerSync } from '../sync/server-sync';
import { DEFAULT_THEME_COLOR, isHexColor } from '../theme';

const CONFIG_TABS = [
  { id: 'general', label: 'Allgemein' },
  { id: 'sections', label: 'Abschnitte' },
  { id: 'blocks', label: 'Feste Inhalte' },
  { id: 'groupSections', label: 'Gruppen-Abschnitte' },
  { id: 'groupBlocks', label: 'Gruppen-Inhalte' },
  { id: 'layout', label: 'Kopf- & Fußzeile' },
  { id: 'instruments', label: 'Instrumente' },
  { id: 'teachers', label: 'Lehrer:innen' },
  { id: 'calendar', label: 'Kalender' },
] as const;

type ConfigTab = (typeof CONFIG_TABS)[number]['id'];

const LOGO_SLOTS = [
  {
    key: 'headerLogo',
    label: 'Logo in der Kopfzeile',
    hint: 'Steht auf der ersten Seite neben der Überschrift (mittig: darüber), auf den Folgeseiten kleiner neben der Kopfzeile.',
    limits: LOGO_HEIGHT_LIMITS.headerLogo,
    defaultHeight: 15,
  },
  {
    key: 'footerLogo',
    label: 'Logo in der Fußzeile',
    hint: 'Steht auf jeder Seite in der Fußzeile; ein Text an derselben Stelle rückt daneben.',
    limits: LOGO_HEIGHT_LIMITS.footerLogo,
    defaultHeight: 8,
  },
] as const;

type LogoSlot = (typeof LOGO_SLOTS)[number];

@Component({
  selector: 'app-config-editor',
  imports: [BlockContentEditor, NgTemplateOutlet, InstrumentSelect, TeachingWindowsEditor, PlanLinkPanel],
  templateUrl: './config-editor.html',
  styleUrl: './config-editor.scss',
})
export class ConfigEditor {
  protected readonly store = inject(ConfigStore);
  protected readonly sync = inject(ServerSync);
  /** Download-Links gibt es mit Server; im Demomodus mit der echten Anmeldung (siehe `PlanLinkPanel`). */
  protected readonly planLinkLogin = demoMode ? signal(realServerLogin()).asReadonly() : this.sync.login;
  protected readonly reportPeriod = inject(ReportPeriod);
  protected readonly activeTeacher = inject(ActiveTeacher);
  protected readonly tabs = CONFIG_TABS;
  /** Zuletzt geöffneter Bereich; gilt nur auf diesem Gerät. */
  protected readonly tab = storedSignal<ConfigTab>('feedback.configTab', () => 'general', (data) =>
    CONFIG_TABS.some((t) => t.id === data) ? (data as ConfigTab) : 'general',
  );
  protected readonly placeholders = PLACEHOLDERS;
  protected readonly groupPlaceholderHint =
    'Platzhalter: ' + GROUP_PLACEHOLDERS.map((p) => p.key).join(', ') + '; {name} und {vorname} stehen für den Gruppennamen.';
  protected readonly defaultThemeColor = DEFAULT_THEME_COLOR;
  protected readonly isDefaultPdfLayout = computed(
    () =>
      JSON.stringify({ ...this.store.config().pdfLayout, headerLogo: null, footerLogo: null, grayscale: false }) ===
      JSON.stringify(DEFAULT_PDF_LAYOUT),
  );
  protected readonly logoSlots = LOGO_SLOTS;
  protected readonly calendarPdfFields: { key: keyof CalendarPdfTexts; label: string }[] = [
    { key: 'listTitle', label: 'Überschrift der Liste' },
    { key: 'eventListTitle', label: 'Überschrift der Liste ohne Einzelunterricht' },
    { key: 'individualListTitle', label: 'Überschrift der Liste nur mit Einzelunterricht' },
    { key: 'dayPlanTitle', label: 'Überschrift des Tagesplans' },
    { key: 'footer', label: 'Fußzeile links (alle Kalender-PDFs)' },
    { key: 'noAppointments', label: 'Hinweis, wenn der Zeitraum keine Termine hat' },
    { key: 'blocked', label: 'Bezeichnung für Blocker (auch in der iCal-Datei)' },
  ];
  protected readonly isDefaultCalendarPdfTexts = computed(
    () => JSON.stringify(this.store.config().calendarPdf) === JSON.stringify(DEFAULT_CALENDAR_PDF_TEXTS),
  );
  protected readonly appLogo = APP_LOGO;
  protected readonly message = signal<{ text: string; error: boolean } | null>(null);
  protected readonly defaultInstrumentId = computed(() => defaultInstrument(this.store.config()).id);

  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  /** Berichtszeitraum, dessen Unterrichtszeiten bearbeitet werden; außerhalb der Zeiträume gibt es keinen Unterricht. */
  // Über ein `computed`: Der Zeitraum ist nach jeder Änderung der Konfiguration ein neues Objekt, die ID bleibt.
  private readonly activePeriodId = computed(() => this.reportPeriod.period().id);
  protected readonly windowsPeriodId = linkedSignal<string>(() => this.activePeriodId());
  protected readonly windowsPeriodName = computed(
    () => this.store.config().reportPeriods.find((p) => p.id === this.windowsPeriodId())?.name ?? '',
  );
  protected readonly periodLabel = labelOf;

  /** Im gewählten Zeitraum gelten gemeinsame Unterrichtszeiten für alle Lehrer. */
  protected readonly windowsPeriodShared = computed(
    () => !!this.store.config().reportPeriods.find((p) => p.id === this.windowsPeriodId())?.sharedWindows,
  );

  /** Beim Zurückschalten auf eigene Zeiten gehen die gemeinsamen verloren; deshalb wird nachgefragt. */
  protected setSharedWindows(period: ReportPeriodEntry, event: Event): void {
    const select = event.target as HTMLSelectElement;
    const shared = select.value === 'shared';
    const text =
      `Die gemeinsamen Unterrichtszeiten von „${period.name}“ verwerfen? Danach gelten wieder die Zeiten der ` +
      'einzelnen Lehrer:innen.';
    if (!shared && period.sharedWindows && !confirm(text)) {
      select.value = 'shared';
      return;
    }
    this.store.setSharedWindows(period.id, shared);
  }

  /** Der gewählte Zeitraum hat beim Lehrer noch keine eigenen Zeiten. */
  protected inheritsWindows(teacher: Teacher): boolean {
    const periodId = this.windowsPeriodId();
    return !teacher.periodWindows[periodId];
  }

  protected teacherInstrumentId(teacher: Teacher): string {
    return teacherInstrument(teacher, this.store.config()).id;
  }

  /** Mit Server darf man Lehrer nur in Zeiträume eintragen, in denen man selbst aktiv ist. */
  /**
   * Gibt es die Lehrkraft schon, nur nicht in den eigenen Berichtszeiträumen (mit Server unsichtbar), wird sie
   * wiederverwendet statt doppelt angelegt.
   */
  protected addTeacher(input: HTMLInputElement): void {
    const name = input.value.trim();
    if (!name) return;
    const login = this.sync.login();
    const hidden = login && this.hiddenTeacherNamed(name);
    if (login && hidden) {
      this.store.joinTeacherToPeriods(hidden.id, login.teacherId);
      this.showError(`${hidden.name} gab es schon; die Lehrkraft ist jetzt in deinen laufenden Berichtszeiträumen.`);
    } else {
      this.store.addTeacher(name, login ? { joinPeriodsOf: login.teacherId } : {});
    }
    input.value = '';
  }

  private hiddenTeacherNamed(name: string): Teacher | undefined {
    const key = name.toLowerCase();
    return this.store
      .config()
      .teachers.find((t) => t.name.trim().toLowerCase() === key && !this.activeTeacher.isVisible(t.id));
  }

  // --- Server: Konten, Einladungen, Rechte ---

  /** Lehrer-ID → Benutzername der Lehrer, die schon ein Konto haben */
  protected readonly accounts = signal(new Map<string, string>());
  protected readonly invites = signal<Record<string, { code: string; expires: string }>>({});
  protected readonly lockedText = 'Ändern darf nur, wer in diesem Berichtszeitraum aktive Lehrkraft ist.';

  constructor() {
    // Konten auf dem Server laden, sobald der Tab „Lehrer“ offen ist
    effect(() => {
      if (this.tab() === 'teachers' && this.sync.login()) void this.loadAccounts();
    });
  }

  private async loadAccounts(): Promise<void> {
    const login = this.sync.login();
    if (!login) return;
    try {
      const list = await serverApi.accounts(login);
      this.accounts.set(new Map(list.map((a) => [a.teacherId, a.username])));
    } catch {
      // Offline: Die Knöpfe zum Einladen erscheinen trotzdem; der Server lehnt doppelte Konten ab.
    }
  }

  protected async invite(teacher: Teacher): Promise<void> {
    const login = this.sync.login();
    if (!login) return;
    try {
      const { code, expiresAt } = await serverApi.invite(login, teacher.id);
      const expires = new Date(expiresAt).toLocaleDateString('de-DE');
      this.invites.update((all) => ({ ...all, [teacher.id]: { code, expires } }));
    } catch (e) {
      this.showError(e instanceof Error ? e.message : String(e));
    }
  }

  protected selectAll(event: Event): void {
    (event.target as HTMLTextAreaElement).select();
  }

  protected copy(text: string): void {
    navigator.clipboard?.writeText(text).catch(() => undefined);
  }

  /** Mit Server: Zeiträume, in denen man nicht aktiv ist, lassen sich nicht ändern oder löschen. */
  protected locked(period: ReportPeriodEntry): boolean {
    const login = this.sync.login();
    return !!login && !period.teacherIds.includes(login.teacherId);
  }

  /** Ein neuer Zeitraum enthält mit Server immer den eigenen Lehrer, sonst nähme der Server ihn nicht an. */
  protected addPeriod(): void {
    const id = this.store.addReportPeriod();
    const login = this.sync.login();
    const period = this.store.config().reportPeriods.find((p) => p.id === id);
    if (login && period && !period.teacherIds.includes(login.teacherId)) {
      this.store.toggleReportPeriodTeacher(id, login.teacherId);
    }
  }

  protected setTeacherName(teacher: Teacher, event: Event): void {
    const name = this.valueOf(event).trim();
    if (name) {
      this.store.updateTeacher(teacher.id, { name });
    } else {
      (event.target as HTMLInputElement).value = teacher.name;
    }
  }

  protected removeTeacher(teacher: Teacher): void {
    if (confirm(`Lehrkraft „${teacher.name}“ löschen? Ihre Personen und deren Termine gehören danach zur ersten Lehrkraft.`)) {
      this.store.removeTeacher(teacher.id);
    }
  }

  protected setDefaultDuration(event: Event): void {
    const minutes = Number(this.valueOf(event));
    if (minutes >= 5) {
      this.store.setCalendarDefaults({ defaultDurationMinutes: Math.round(minutes) });
    } else {
      (event.target as HTMLInputElement).value = String(this.store.config().calendar.defaultDurationMinutes);
      this.showError('Die Standardlänge muss mindestens 5 Minuten betragen.');
    }
  }

  protected standardWindows(): TimeWindow[] {
    return [...this.store.config().calendar.defaultWindows].sort((a, b) => a.from.localeCompare(b.from));
  }

  protected setStandardWindowTime(window: TimeWindow, key: 'from' | 'to', event: Event): void {
    if (this.isValidWindowChange(window, key, event)) {
      this.store.updateStandardWindow(window.id, { [key]: this.valueOf(event) });
    }
  }

  /** Ein Zeitfenster muss enden, nachdem es beginnt; sonst bleibt der alte Wert und es gibt einen Hinweis. */
  private isValidWindowChange(window: TimeWindow, key: 'from' | 'to', event: Event): boolean {
    const value = this.valueOf(event);
    const changed = { ...window, [key]: value };
    if (value && changed.from < changed.to) return true;
    (event.target as HTMLInputElement).value = window[key];
    this.showError('Ein Zeitfenster muss später enden, als es beginnt.');
    return false;
  }

  protected setCalendarPdfText(key: keyof CalendarPdfTexts, event: Event): void {
    this.store.setCalendarPdfTexts({ [key]: this.valueOf(event) });
  }

  protected setPeriodName(period: ReportPeriodEntry, event: Event): void {
    const input = event.target as HTMLInputElement;
    const name = input.value.trim();
    if (name) {
      this.store.updateReportPeriod(period.id, { name });
    } else {
      input.value = period.name;
      this.showError('Ein Berichtszeitraum braucht einen Namen.');
    }
  }

  protected setPeriodDate(period: ReportPeriodEntry, key: 'from' | 'to', event: Event): void {
    const input = event.target as HTMLInputElement;
    const changed = { ...period, [key]: input.value };
    if (input.value && changed.from <= changed.to) {
      this.store.updateReportPeriod(period.id, { [key]: input.value });
    } else {
      input.value = period[key];
      this.showError('Der Berichtszeitraum darf nicht enden, bevor er beginnt.');
    }
  }

  protected removePeriod(period: ReportPeriodEntry): void {
    if (confirm(`Berichtszeitraum „${period.name}“ löschen? Varianten der festen Inhalte gelten danach nicht mehr für ihn.`)) {
      this.store.removeReportPeriod(period.id);
    }
  }

  /** Die Farbe gehört der aktiven Lehrkraft; andere behalten ihre. */
  protected setColor(color: string): void {
    this.store.setTeacherColor(this.activeTeacher.teacher().id, color);
  }

  protected setThemeColorFromText(event: Event): void {
    const input = event.target as HTMLInputElement;
    const color = input.value.trim().replace(/^#?/, '#');
    if (isHexColor(color)) {
      this.setColor(color);
    } else {
      input.value = this.activeTeacher.color();
      this.showError('Bitte die Farbe als Hex-Wert angeben, z. B. #f57115.');
    }
  }

  protected showError(text: string): void {
    this.message.set({ text, error: true });
  }

  protected addInstrument(input: HTMLInputElement): void {
    const name = input.value.trim();
    if (!name) return;
    this.store.addInstrument(name);
    input.value = '';
  }

  protected removeInstrument(instrument: Instrument): void {
    if (confirm(`Instrument „${instrument.name}“ löschen? Personen mit diesem Instrument bekommen das Standardinstrument.`)) {
      this.store.removeInstrument(instrument.id);
    }
  }

  protected addItem(section: Section, input: HTMLInputElement): void {
    const text = input.value.trim();
    if (!text) return;
    this.store.addItem(section.id, text);
    input.value = '';
  }

  protected removeSection(section: Section): void {
    if (confirm(`Abschnitt „${section.title}“ löschen? Bereits erfasste Einträge dazu erscheinen nicht mehr im PDF.`)) {
      this.store.removeSection(section.id);
    }
  }

  /** Gemeinsame und die eigenen des gewählten Lehrers; die eigenen anderer Lehrer bleiben verborgen. */
  protected sectionsOf(kind: ContentKind): Section[] {
    return sectionsOf(this.store.config(), kind).filter((section) => isVisibleTo(section, this.activeTeacher.teacher().id));
  }

  protected blocksOf(kind: ContentKind): FixedBlock[] {
    return blocksOf(this.store.config(), kind).filter((block) => isVisibleTo(block, this.activeTeacher.teacher().id));
  }

  protected readonly hasPlaceholderPeriod = computed(() => this.store.config().reportPeriods.some((p) => p.placeholder));

  /** Eigene Unterrichtszeiten ändert jede Lehrkraft nur selbst (die aktive bzw. angemeldete). */
  protected ownsWindows(teacher: Teacher): boolean {
    return teacher.id === this.activeTeacher.teacher().id;
  }

  /** Die aktiven Lehrer des Zeitraums in seiner Reihenfolge, danach die übrigen */
  protected teachersOf(period: ReportPeriodEntry): Teacher[] {
    // Lehrkräfte des Zeitraums immer, dazu die sichtbaren zum Aufnehmen
    const teachers = this.store.config().teachers.filter((t) => period.teacherIds.includes(t.id) || this.activeTeacher.isVisible(t.id));
    return byPeriodOrder(teachers, period.teacherIds);
  }

  /** Ort im oben gewählten Berichtszeitraum; ein neuer Zeitraum übernimmt ihn aus dem vorigen. */
  protected locationOf(teacher: Teacher): string {
    return locationIn(teacher, this.windowsPeriodId());
  }

  /** Mit Server sind gemeinsame Inhalte und Varianten gesperrt; jede Lehrkraft ändert nur eigene. */
  protected readonly sharedEditable = computed(() => !this.sync.login());

  protected canEdit(entry: { ownerId?: string }): boolean {
    return entry.ownerId ? entry.ownerId === this.activeTeacher.teacher().id : this.sharedEditable();
  }

  /** Mit Server gehört Neues immer der eigenen Lehrkraft. */
  protected newOwner(): string | undefined {
    return this.sharedEditable() ? undefined : this.activeTeacher.teacher().id;
  }

  /** Gemeinsame Varianten und die eigenen des gewählten Lehrers */
  protected variantsOf(block: FixedBlock): BlockVariant[] {
    return block.variants.filter((variant) => isVisibleTo(variant, this.activeTeacher.teacher().id));
  }

  /** Eigener Abschnitt oder Inhalt des gewählten Lehrers, oder wieder einer für alle */
  protected ownerFor(event: Event): string | null {
    return (event.target as HTMLInputElement).checked ? this.activeTeacher.teacher().id : null;
  }

  protected async addImage(input: HTMLInputElement, kind: ContentKind = 'single'): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      this.store.addImageBlock(await readImageFile(file), kind, this.newOwner());
    } catch (e) {
      this.showError(`Bild konnte nicht geladen werden: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  protected async chooseLogo(slot: LogoSlot, input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const { dataUrl, widthPx, heightPx } = await readImageFile(file);
      const current = this.store.config().pdfLayout[slot.key];
      this.store.setPdfLayout({
        [slot.key]: { dataUrl, widthPx, heightPx, heightMm: current?.heightMm ?? slot.defaultHeight, align: current?.align ?? 'right' },
      });
    } catch (e) {
      this.showError(`Bild konnte nicht geladen werden: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  protected setLogoHeight(slot: LogoSlot, logo: PdfLogo, event: Event): void {
    const input = event.target as HTMLInputElement;
    const height = Number(input.value);
    if (height >= slot.limits.min && height <= slot.limits.max) {
      this.store.setPdfLayout({ [slot.key]: { ...logo, heightMm: height } });
    } else {
      input.value = String(logo.heightMm);
      this.showError(`Die Höhe muss zwischen ${slot.limits.min} und ${slot.limits.max} mm liegen.`);
    }
  }

  protected setLogoAlign(slot: LogoSlot, logo: PdfLogo, event: Event): void {
    this.store.setPdfLayout({ [slot.key]: { ...logo, align: this.valueOf(event) as ImageAlign } });
  }

  protected removeLogo(slot: LogoSlot): void {
    if (confirm(`${slot.label} entfernen?`)) this.store.setPdfLayout({ [slot.key]: null });
  }

  protected removeBlock(block: FixedBlock): void {
    const what = block.type === 'image' ? 'das Bild' : 'den Text';
    if (confirm(`Möchtest du ${what} mit allen Varianten wirklich löschen?`)) this.store.removeBlock(block.id);
  }

  protected async importFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file || !confirm('Die aktuelle Konfiguration wird ersetzt. Fortfahren?')) return;
    try {
      this.store.importFromJson(await file.text());
      this.message.set({ text: `Konfiguration aus „${file.name}“ importiert.`, error: false });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.message.set({ text: `Import fehlgeschlagen: ${reason}`, error: true });
    }
  }

  protected reset(): void {
    if (confirm('Texte, Abschnitte und Gestaltung auf die Beispielvorlage zurücksetzen? Lehrkräfte, Instrumente und Berichtszeiträume bleiben erhalten.')) {
      this.store.resetToDefault();
      this.message.set(null);
    }
  }
}
