import { Component, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ActiveTeacher } from './active-teacher';
import { appVersion, AppUpdate } from './app-update';
import { ConfigStore } from './config.store';
import { byPeriodOrder, formatLongDate, homeLinkOf, today } from './model';
import { DEMO_PERIOD_ID, endDemo, startDemoPeriodToday } from './demo';
import { demoMode } from './stored-signal';
import { ReportPeriod } from './report-period';
import { ServerSync } from './sync/server-sync';
import { isNativeApp } from './save-file';
import { WelcomeDialog } from './welcome/welcome-dialog';
import { ShareSheet } from './share-sheet';
import { StudentPlanning } from './planning/student-planning';
import { StudentPlanningPage } from './planning/student-planning-page';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, WelcomeDialog, StudentPlanningPage, ShareSheet],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly configStore = inject(ConfigStore);
  /** Jede Lehrkraft hat ihre eigene Farbe; es gilt die der aktiven. */
  private readonly theme = computed(() => this.activeTeacher.theme());
  /** Die Lehrer des gewählten Zeitraums zuerst, in seiner Reihenfolge */
  protected readonly teachers = computed(() =>
    byPeriodOrder(this.configStore.config().teachers, this.reportPeriod.period().teacherIds),
  );
  /** Erster Start: Die Begrüßung legt den eigenen Lehrer an oder spielt eine Sicherung ein. */
  protected readonly setupPending = this.configStore.setupPending;
  protected readonly activeTeacher = inject(ActiveTeacher);
  /** Jede Lehrkraft legt unter Konfiguration → Allgemein fest, wohin das Logo führt. */
  protected readonly homeLink = computed(() => homeLinkOf(this.activeTeacher.teacher()));
  protected readonly reportPeriod = inject(ReportPeriod);
  /** Nach Beginn sortiert */
  protected readonly periods = computed(() =>
    [...this.reportPeriod.periods()].sort((a, b) => a.from.localeCompare(b.from)),
  );
  /** Startet den Abgleich mit dem Server, falls die App mit einem verbunden ist */
  protected readonly serverSync = inject(ServerSync);
  protected readonly syncNeedsAttention = computed(() =>
    ['reconnect', 'initial', 'conflict', 'error'].includes(this.serverSync.status()),
  );
  protected readonly serverName = computed(() => {
    const login = this.serverSync.login();
    return login ? new URL(login.url).host : '';
  });
  protected readonly nativeApp = isNativeApp;
  /** Im Demomodus zeigt die Leiste das deutlich und beendet ihn mit einem Klick (die Demo wird verworfen). */
  protected readonly demoMode = demoMode;
  protected readonly endDemo = endDemo;
  protected readonly startDemoPeriodToday = startDemoPeriodToday;
  /** Beginn des Demolehrgangs, solange er noch in der Zukunft liegt, z. B. „Montag, 16. November 2026“ */
  protected readonly demoPeriodStart = computed(() => {
    if (!demoMode) return null;
    const period = this.configStore.config().reportPeriods.find((p) => p.id === DEMO_PERIOD_ID);
    return period && period.from > today() ? formatLongDate(period.from) : null;
  });
  /** Läuft die Schüler-Planung, zeigt die App nur sie. */
  protected readonly planning = inject(StudentPlanning);
  /** Hinweis auf eine neuere Android-App */
  protected readonly update = inject(AppUpdate);
  protected readonly appVersion = appVersion;
  /** Neueste APK aus den GitHub-Releases (siehe .github/workflows/android.yml) */
  protected readonly apkUrl =
    'https://github.com/cor-aurum/Unterrichtsfeedback/releases/latest/download/Unterrichtsfeedback.apk';

  /** Menü auf schmalen Bildschirmen; nach dem Wechsel der Seite klappt es wieder zu. */
  protected readonly menuOpen = signal(false);

  protected valueOf(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  constructor() {
    inject(Router)
      .events.pipe(takeUntilDestroyed())
      .subscribe((event) => {
        if (event instanceof NavigationEnd) this.menuOpen.set(false);
      });
    // Überschreibt die Standardwerte der CSS-Variablen aus styles.scss mit der konfigurierten Farbe.
    effect(() => {
      const theme = this.theme();
      const style = document.documentElement.style;
      style.setProperty('--primary', theme.primary);
      style.setProperty('--on-primary', theme.onPrimary);
      style.setProperty('--primary-text', theme.primaryText);
      style.setProperty('--primary-light', theme.primaryLight);
    });
  }
}
