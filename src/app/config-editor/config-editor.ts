import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { blocksOf, ConfigStore, sectionsOf } from '../config.store';
import {
  ContentKind,
  DEFAULT_PDF_LAYOUT,
  defaultInstrument,
  FixedBlock,
  GROUP_PLACEHOLDERS,
  Instrument,
  PLACEHOLDERS,
  Section,
  Teacher,
  teacherInstrument,
  TeachingWindow,
  TimeWindow,
} from '../model';
import { WEEKDAY_NAMES } from '../calendar/appointments';
import { BlockContentEditor } from './block-content-editor';
import { readImageFile } from './image-file';
import { ReportPeriod } from '../report-period';
import { storedSignal } from '../stored-signal';
import { DEFAULT_THEME_COLOR, isHexColor } from '../theme';

const CONFIG_TABS = [
  { id: 'general', label: 'Allgemein' },
  { id: 'sections', label: 'Abschnitte' },
  { id: 'blocks', label: 'Feste Inhalte' },
  { id: 'groupSections', label: 'Gruppen-Abschnitte' },
  { id: 'groupBlocks', label: 'Gruppen-Inhalte' },
  { id: 'layout', label: 'Kopf- & Fußzeile' },
  { id: 'instruments', label: 'Instrumente' },
  { id: 'teachers', label: 'Lehrer' },
  { id: 'calendar', label: 'Kalender' },
] as const;

type ConfigTab = (typeof CONFIG_TABS)[number]['id'];

@Component({
  selector: 'app-config-editor',
  imports: [BlockContentEditor, NgTemplateOutlet],
  templateUrl: './config-editor.html',
  styleUrl: './config-editor.scss',
})
export class ConfigEditor {
  protected readonly store = inject(ConfigStore);
  protected readonly reportPeriod = inject(ReportPeriod);
  protected readonly tabs = CONFIG_TABS;
  /** Zuletzt geöffneter Bereich; gilt nur auf diesem Gerät. */
  protected readonly tab = storedSignal<ConfigTab>('feedback.configTab', () => 'general', (data) =>
    CONFIG_TABS.some((t) => t.id === data) ? (data as ConfigTab) : 'general',
  );
  protected readonly placeholders = PLACEHOLDERS;
  protected readonly groupPlaceholderHint =
    'Platzhalter: ' + GROUP_PLACEHOLDERS.map((p) => p.key).join(', ') + '; {name} und {vorname} stehen für den Gruppennamen.';
  protected readonly defaultThemeColor = DEFAULT_THEME_COLOR;
  protected readonly weekdays = WEEKDAY_NAMES.map((name, index) => ({ name, index }));
  protected readonly isDefaultPdfLayout = computed(
    () => JSON.stringify(this.store.config().pdfLayout) === JSON.stringify(DEFAULT_PDF_LAYOUT),
  );
  protected readonly message = signal<{ text: string; error: boolean } | null>(null);
  protected readonly defaultInstrumentId = computed(() => defaultInstrument(this.store.config()).id);

  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected windowsOf(teacher: Teacher, weekday: number): TeachingWindow[] {
    return teacher.teachingWindows.filter((w) => w.weekday === weekday).sort((a, b) => a.from.localeCompare(b.from));
  }

  protected teacherInstrumentId(teacher: Teacher): string {
    return teacherInstrument(teacher, this.store.config()).id;
  }

  protected addTeacher(input: HTMLInputElement): void {
    const name = input.value.trim();
    if (!name) return;
    this.store.addTeacher(name);
    input.value = '';
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
    if (confirm(`Lehrer „${teacher.name}“ löschen? Seine Personen und deren Termine gehören danach zum ersten Lehrer.`)) {
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

  protected setWindowTime(teacher: Teacher, window: TeachingWindow, key: 'from' | 'to', event: Event): void {
    if (this.isValidWindowChange(window, key, event)) {
      this.store.updateTeachingWindow(teacher.id, window.id, { [key]: this.valueOf(event) });
    }
  }

  protected setPeriod(key: 'from' | 'to', event: Event): void {
    const input = event.target as HTMLInputElement;
    const period = { ...this.reportPeriod.period(), [key]: input.value };
    if (input.value && period.from <= period.to) {
      this.reportPeriod.set(period);
    } else {
      input.value = this.reportPeriod.period()[key];
      this.showError('Der Berichtszeitraum darf nicht enden, bevor er beginnt.');
    }
  }

  protected setThemeColorFromText(event: Event): void {
    const input = event.target as HTMLInputElement;
    const color = input.value.trim().replace(/^#?/, '#');
    if (isHexColor(color)) {
      this.store.setThemeColor(color);
    } else {
      input.value = this.store.config().themeColor;
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

  protected sectionsOf(kind: ContentKind): Section[] {
    return sectionsOf(this.store.config(), kind);
  }

  protected blocksOf(kind: ContentKind): FixedBlock[] {
    return blocksOf(this.store.config(), kind);
  }

  protected async addImage(input: HTMLInputElement, kind: ContentKind = 'single'): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      this.store.addImageBlock(await readImageFile(file), kind);
    } catch (e) {
      this.showError(`Bild konnte nicht geladen werden: ${e instanceof Error ? e.message : String(e)}`);
    }
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
    if (confirm('Konfiguration auf die Beispielvorlage zurücksetzen?')) {
      this.store.resetToDefault();
      this.message.set(null);
    }
  }
}
