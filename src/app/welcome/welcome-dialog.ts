import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import { ActiveTeacher } from '../active-teacher';
import { BackupService } from '../backup';
import { WEEKDAY_NAMES } from '../calendar/appointments';
import { ConfigStore, isPeriod } from '../config.store';
import { newId, ReportPeriodEntry, schoolHalfYear, TeachingWindow, today } from '../model';
import { ReportPeriod } from '../report-period';
import { DEFAULT_THEME_COLOR } from '../theme';

/** Ein Wochentag in der Begrüßung: angehakt mit einem Zeitfenster */
interface SetupDay {
  weekday: number;
  name: string;
  active: boolean;
  from: string;
  to: string;
}

/** Vorschläge für die Lieblingsfarbe; jede andere Farbe geht über den Farbwähler. */
const COLOR_PRESETS = [DEFAULT_THEME_COLOR, '#d32f2f', '#c2185b', '#7b1fa2', '#3949ab', '#0277bd', '#00897b', '#2e7d32'];

/**
 * Begrüßung beim allerersten Start: Statt eines vorläufigen Lehrers legt man sich selbst an (Name, Instrument,
 * optional Unterrichtszeiten und Lieblingsfarbe) oder spielt eine Sicherung bzw. Konfiguration ein. Danach wählt
 * man sich unter den Lehrern aus der Datei aus oder legt sich dort neu an, z. B. als neuer Lehrer mit der
 * Sicherung eines Berichtszeitraums.
 */
@Component({
  selector: 'app-welcome-dialog',
  templateUrl: './welcome-dialog.html',
  styleUrl: './welcome-dialog.scss',
})
export class WelcomeDialog {
  private readonly configStore = inject(ConfigStore);
  private readonly backup = inject(BackupService);
  private readonly router = inject(Router);
  private readonly activeTeacher = inject(ActiveTeacher);
  protected readonly selectedPeriod = inject(ReportPeriod);

  protected readonly colorPresets = COLOR_PRESETS;
  protected readonly color = signal(DEFAULT_THEME_COLOR);
  protected readonly days = signal<SetupDay[]>(
    WEEKDAY_NAMES.map((name, weekday) => ({ weekday, name, active: weekday < 5, from: '14:00', to: '18:30' })),
  );
  protected readonly reportPeriod = signal(schoolHalfYear(today()));
  protected readonly error = signal<string | null>(null);
  protected readonly importing = signal(false);
  protected readonly helpOpen = signal(false);
  /** Nach dem Einspielen: Wer bist du? */
  protected readonly choosingTeacher = signal(false);
  protected readonly teachers = computed(() => this.configStore.config().teachers);
  /** Gewählter Lehrer; `new` legt einen neuen an */
  protected readonly chosenTeacherId = signal<string>('new');

  constructor() {
    // Nur die Hilfe ist vor der Einrichtung erreichbar: Wer von dort weiternavigiert, landet wieder im Dialog.
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe((event) => {
        if (!event.urlAfterRedirects.startsWith('/hilfe')) this.helpOpen.set(false);
      });
  }

  protected openHelp(): void {
    this.helpOpen.set(true);
    this.router.navigate(['/hilfe']);
  }

  protected closeHelp(): void {
    this.helpOpen.set(false);
  }

  protected setColor(color: string): void {
    this.color.set(color);
    // Vorschau: Die App nimmt die Farbe sofort an.
    this.configStore.setThemeColor(color);
  }

  protected updateDay(weekday: number, change: Partial<SetupDay>): void {
    this.days.update((days) => days.map((day) => (day.weekday === weekday ? { ...day, ...change } : day)));
  }

  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected start(event: Event): void {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    const name = String(form.get('name') ?? '').trim();
    const instrument = String(form.get('instrument') ?? '').trim();
    if (!name || !instrument) {
      this.error.set('Bitte gib deinen Namen und dein Instrument an.');
      return;
    }
    const invalid = this.days().find((day) => day.active && !(day.from && day.to && day.from < day.to));
    if (invalid) {
      this.error.set(`${invalid.name}: Die Unterrichtszeit muss später enden, als sie beginnt.`);
      return;
    }
    const period = this.reportPeriod();
    if (!period.name.trim() || !isPeriod(period)) {
      this.error.set('Der Berichtszeitraum braucht einen Namen und darf nicht enden, bevor er beginnt.');
      return;
    }
    this.configStore.completeSetup({
      name,
      instrument,
      teachingWindows: this.teachingWindows(),
      themeColor: this.color(),
      reportPeriod: { name: period.name, from: period.from, to: period.to },
    });
  }

  protected updatePeriod(change: Partial<ReportPeriodEntry>): void {
    this.reportPeriod.update((period) => ({ ...period, ...change }));
  }

  private teachingWindows(): TeachingWindow[] {
    return this.days()
      .filter((day) => day.active)
      .map((day) => ({ id: newId(), weekday: day.weekday, from: day.from, to: day.to }));
  }

  /**
   * Eine ZIP-Datei oder JSON-Datei mit Personen ist eine Komplettsicherung; jede andere JSON-Datei wird als
   * Konfiguration gelesen. Danach ist die Einrichtung erledigt, die Lehrer kommen aus der Datei.
   */
  protected async restore(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.importing.set(true);
    this.error.set(null);
    try {
      if (await isFullBackup(file)) {
        await this.backup.importFile(file);
      } else {
        this.configStore.importFromJson(await file.text());
      }
      this.chosenTeacherId.set('new');
      this.choosingTeacher.set(true);
    } catch (e) {
      const reason =
        e instanceof SyntaxError
          ? 'Die Datei ist keine Sicherung und keine Konfiguration dieser App.'
          : e instanceof Error
            ? e.message
            : String(e);
      this.error.set(`„${file.name}“ ließ sich nicht einspielen: ${reason}`);
    } finally {
      this.importing.set(false);
    }
  }

  /** Wählt den eigenen Lehrer aus der Datei oder legt ihn an; ein neuer ist im gewählten Zeitraum aktiv. */
  protected chooseTeacher(event: Event): void {
    event.preventDefault();
    let teacherId = this.chosenTeacherId();
    if (teacherId === 'new') {
      const form = new FormData(event.target as HTMLFormElement);
      const name = String(form.get('name') ?? '').trim();
      const instrument = String(form.get('instrument') ?? '').trim();
      if (!name || !instrument) {
        this.error.set('Bitte gib deinen Namen und dein Instrument an.');
        return;
      }
      teacherId = this.configStore.addTeacher(name, instrument);
      const period = this.selectedPeriod.period();
      if (!period.teacherIds.includes(teacherId)) this.configStore.toggleReportPeriodTeacher(period.id, teacherId);
    }
    this.activeTeacher.select(teacherId);
    this.error.set(null);
    this.configStore.setupPending.set(false);
  }
}

async function isFullBackup(file: File): Promise<boolean> {
  if (file.name.toLowerCase().endsWith('.zip')) return true;
  const data = JSON.parse(await file.text());
  return typeof data === 'object' && data !== null && 'students' in data;
}
