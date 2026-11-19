import { Component, computed, inject, signal } from '@angular/core';
import { demoMode, storageKey, storedSignal } from '../stored-signal';
import { suggestHomeScreen } from './home-screen';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import { ActiveTeacher } from '../active-teacher';
import { BackupService } from '../backup';
import { WEEKDAY_NAMES } from '../calendar/appointments';
import { ConfigStore, isPeriod } from '../config.store';
import {
  formatShortDate,
  locationIn,
  roleIn,
  newId,
  ReportPeriodEntry,
  schoolHalfYear,
  teacherInstrument,
  TeachingWindow,
  teachingWindowsFor,
  today,
} from '../model';
import { InstrumentSelect } from '../instrument-select';
import { ReportPeriod } from '../report-period';
import { Connected, ServerLoginPanel } from '../sync/server-login-panel';
import { ServerSync } from '../sync/server-sync';
import { DEFAULT_THEME_COLOR } from '../theme';

/** Ein Wochentag in der Begrüßung: angehakt mit einem Zeitfenster */
interface SetupDay {
  weekday: number;
  name: string;
  active: boolean;
  from: string;
  to: string;
}

const SERVER_STEPS = ['none', 'login', 'setup', 'teacher', 'welcome'] as const;
type ServerStep = (typeof SERVER_STEPS)[number];
const SETUP_STEP_KEY = 'feedback.setupStep';

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
  imports: [ServerLoginPanel, InstrumentSelect],
  templateUrl: './welcome-dialog.html',
  styleUrl: './welcome-dialog.scss',
})
export class WelcomeDialog {
  /** Im Demomodus keine Server-Anmeldung, damit die Beispieldaten nicht auf den Server gelangen */
  protected readonly demoMode = demoMode;
  /** Auf iPhone und iPad im Browser: zum Home-Bildschirm hinzufügen, damit Safari die Daten nicht löscht */
  protected readonly homeScreenHint = suggestHomeScreen();
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

  // --- Server ---
  private readonly sync = inject(ServerSync);
  /**
   * - `none`: ohne Server einrichten
   * - `login`: Einladungscode einlösen oder anmelden
   * - `setup`: verbunden, der Server ist noch leer: wie gewohnt einrichten (erster Lehrer)
   * - `teacher`: verbunden, der eigene Lehrer fehlt noch in den Daten: Name und Instrument angeben
   * - `welcome`: verbunden, die einladende Lehrkraft hat einen schon angelegt: zeigen, was eingerichtet ist, und nur
   *   noch Name, Instrument und Farbe bestätigen
   *
   * Gespeichert, damit ein Neuladen mitten in der Einrichtung (angemeldet, aber noch nicht fertig) beim selben Schritt
   * weitermacht, statt die Einrichtung ohne Server anzubieten; ohne Anmeldung gelten die Schritte danach nicht.
   */
  protected readonly serverStep = storedSignal<ServerStep>(SETUP_STEP_KEY, () => 'none', (data) =>
    SERVER_STEPS.includes(data as ServerStep) && (this.sync.login() || data === 'none' || data === 'login')
      ? (data as ServerStep)
      : 'none',
  );
  protected readonly serverBusy = signal(false);
  /** Der Lehrer dieser frischen App; ihn bekommt ein Konto aus einer Einladung, die an keinen Lehrer gebunden ist */
  protected readonly ownTeacherId = computed(() => this.configStore.config().teachers[0].id);
  /** Die eigene, schon angelegte Lehrkraft (Schritt `welcome`) */
  protected readonly ownTeacher = computed(() => {
    const id = this.sync.login()?.teacherId;
    return this.configStore.config().teachers.find((teacher) => teacher.id === id);
  });
  /** Was für die eigene Lehrkraft schon eingerichtet ist: Instrument, Funktion, Zeiträume, Ort und Unterrichtszeiten */
  protected readonly prepared = computed(() => {
    const teacher = this.ownTeacher();
    if (!teacher) return null;
    const config = this.configStore.config();
    const periods = config.reportPeriods
      .filter((period) => !period.placeholder && period.teacherIds.includes(teacher.id))
      .sort((a, b) => a.from.localeCompare(b.from));
    const current = periods.find((period) => period.id === this.selectedPeriod.period().id) ?? periods.at(-1);
    const windows = current ? (current.sharedWindows ?? teachingWindowsFor(teacher, current.id)) : [];
    return {
      instrumentId: teacherInstrument(teacher, config).id,
      role: current ? roleIn(teacher, current.id) : '',
      periods: periods.map((period) => `${period.name} (${formatShortDate(period.from)} – ${formatShortDate(period.to)})`),
      currentName: current?.name ?? '',
      location: current ? locationIn(teacher, current.id) : '',
      windows: windowsText(windows),
    };
  });
  protected readonly serverName = computed(() => {
    const login = this.sync.login();
    return login ? new URL(login.url).host : '';
  });

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
    // Vorschau: Die App nimmt die Farbe sofort an; sie gehört der eigenen (beim ersten Start noch vorläufigen) Lehrkraft.
    const own = this.serverStep() === 'welcome' ? this.ownTeacher() : undefined;
    this.configStore.setTeacherColor(own?.id ?? this.configStore.config().teachers[0].id, color);
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
    this.serverStep.set('none');
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

  /**
   * Angemeldet: Daten vom Server übernehmen. Ist der Server noch leer, richtet man sich wie gewohnt ein (die Daten
   * gehen dann an den Server); kennt er den eigenen Lehrer, ist die Einrichtung erledigt; sonst fehlen nur Name und
   * Instrument.
   */
  protected async serverConnected({ login }: Connected): Promise<void> {
    this.serverBusy.set(true);
    this.error.set(null);
    try {
      await this.sync.connect(login, 'load');
    } finally {
      this.serverBusy.set(false);
    }
    if (this.sync.status() === 'error') {
      this.error.set(`Die Daten ließen sich nicht laden: ${this.sync.error()}`);
      return;
    }
    if (this.sync.serverEmpty()) {
      this.serverStep.set('setup');
      return;
    }
    const own = this.teachers().find((t) => t.id === login.teacherId);
    if (own) {
      // Von der einladenden Lehrkraft angelegt: zeigen, was schon da ist, statt noch einmal danach zu fragen.
      this.activeTeacher.select(login.teacherId);
      if (own.themeColor) this.color.set(own.themeColor);
      this.serverStep.set('welcome');
      return;
    }
    this.serverStep.set('teacher');
  }

  /** Schritt `welcome`: Name wie angezeigt übernehmen; Instrument und Farbe sind schon gesetzt. */
  protected confirmPrepared(event: Event): void {
    event.preventDefault();
    const teacher = this.ownTeacher();
    if (!teacher) return;
    const name = String(new FormData(event.target as HTMLFormElement).get('name') ?? '').trim();
    if (!name) {
      this.error.set('Bitte gib deinen Namen an.');
      return;
    }
    if (name !== teacher.name) this.configStore.updateTeacher(teacher.id, { name });
    this.error.set(null);
    this.finishSetup();
  }

  /** Einrichtung fertig: Dialog zu, beim nächsten Mal (z. B. nach „Alles zurücksetzen“) wieder von vorn */
  private finishSetup(): void {
    this.serverStep.set('none');
    // Der Dialog verschwindet gleich, bevor sein Effekt den Schritt speichern kann; deshalb direkt entfernen.
    localStorage.removeItem(storageKey(SETUP_STEP_KEY));
    this.configStore.setupPending.set(false);
  }

  protected setOwnInstrument(instrumentId: string): void {
    const teacher = this.ownTeacher();
    if (teacher) this.configStore.updateTeacher(teacher.id, { instrumentId });
  }

  /**
   * Neuer Lehrer auf einem Server mit Daten: Er legt sich mit der ID seines Kontos an. In Berichtszeiträume trägt ihn
   * ein anderer Lehrer ein; selbst darf er nur neue anlegen.
   */
  protected createOwnTeacher(event: Event): void {
    event.preventDefault();
    const login = this.sync.login();
    if (!login) return;
    const form = new FormData(event.target as HTMLFormElement);
    const name = String(form.get('name') ?? '').trim();
    const instrument = String(form.get('instrument') ?? '').trim();
    if (!name || !instrument) {
      this.error.set('Bitte gib deinen Namen und dein Instrument an.');
      return;
    }
    this.configStore.addTeacher(name, { instrument, id: login.teacherId, period: null });
    this.activeTeacher.select(login.teacherId);
    this.error.set(null);
    this.finishSetup();
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
      teacherId = this.configStore.addTeacher(name, { instrument });
      const period = this.selectedPeriod.period();
      if (!period.teacherIds.includes(teacherId)) this.configStore.toggleReportPeriodTeacher(period.id, teacherId);
    }
    this.activeTeacher.select(teacherId);
    this.error.set(null);
    this.finishSetup();
  }
}

/** Unterrichtszeiten kurz, gleiche Zeiten an Tagen in Folge zusammengefasst: „Mo–Fr 14:00–18:30, Sa 10:00–12:00“ */
function windowsText(windows: TeachingWindow[]): string {
  const days = new Map<string, number[]>();
  for (const window of [...windows].sort((a, b) => a.weekday - b.weekday || a.from.localeCompare(b.from))) {
    const time = `${window.from}–${window.to}`;
    days.set(time, [...(days.get(time) ?? []), window.weekday]);
  }
  return [...days].map(([time, weekdays]) => `${dayRanges(weekdays)} ${time}`).join(', ');
}

/** [0, 1, 2, 4] → „Mo–Mi, Fr“ */
function dayRanges(weekdays: number[]): string {
  const short = (day: number) => WEEKDAY_NAMES[day].slice(0, 2);
  const ranges: [number, number][] = [];
  for (const day of new Set(weekdays)) {
    const last = ranges.at(-1);
    if (last && day === last[1] + 1) last[1] = day;
    else ranges.push([day, day]);
  }
  return ranges.map(([from, to]) => (from === to ? short(from) : `${short(from)}–${short(to)}`)).join(', ');
}

async function isFullBackup(file: File): Promise<boolean> {
  if (file.name.toLowerCase().endsWith('.zip')) return true;
  const data = JSON.parse(await file.text());
  return typeof data === 'object' && data !== null && 'students' in data;
}
