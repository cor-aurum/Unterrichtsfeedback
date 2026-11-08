import { Component, computed, effect, inject, linkedSignal, signal, untracked } from '@angular/core';
import { ActiveTeacher } from '../active-teacher';
import { ConfigStore } from '../config.store';
import { Teacher, today } from '../model';
import { ReportPeriod } from '../report-period';
import { isNativeApp, openFile, safeFileName, saveFile } from '../save-file';
import { storedSignal } from '../stored-signal';
import { FeedState, serverApi } from '../sync/server-folder';
import { ServerSync } from '../sync/server-sync';
import { addDays, daysBetween, mondayOf } from './appointments';
import { CalendarEvents } from './calendar-events';
import { toICalendar } from './ical';

/** Längster Zeitraum, damit wöchentliche Termine nicht zu Tausenden Einträgen werden */
const MAX_DAYS = 2 * 366;
const ALL_TEACHERS = 'all';

/**
 * Termine als iCalendar-Datei für den Systemkalender. Wöchentliche Termine werden im Zeitraum einzeln
 * eingetragen; jeder Eintrag behält bei jedem Export dieselbe UID, damit ein erneuter Import ihn aktualisiert.
 */
@Component({
  selector: 'app-ical-export-panel',
  templateUrl: './ical-export-panel.html',
  styleUrl: './ical-export-panel.scss',
})
export class IcalExportPanel {
  private readonly events = inject(CalendarEvents);
  private readonly config = inject(ConfigStore).config;
  private readonly activeTeacher = inject(ActiveTeacher);
  private readonly reportPeriod = inject(ReportPeriod);
  protected readonly nativeApp = isNativeApp;
  protected readonly allTeachers = ALL_TEACHERS;

  protected readonly teachers = this.activeTeacher.visibleTeachers;
  // Über ein `computed`: Der Lehrer ist nach jeder Änderung der Konfiguration ein neues Objekt, die ID bleibt.
  private readonly activeTeacherId = computed(() => this.activeTeacher.teacher().id);
  protected readonly teacherId = linkedSignal(() => this.activeTeacherId());
  protected readonly from = signal(mondayOf(today()));
  /** Bis zum Ende des Berichtszeitraums, mindestens aber vier Wochen */
  protected readonly to = signal(maxDate(this.reportPeriod.period().to, addDays(mondayOf(today()), 27)));
  /** Gilt nur auf diesem Gerät. */
  protected readonly includeBlockers = storedSignal<boolean>('feedback.icalBlockers', () => true, (data) => data !== false);
  protected readonly message = signal<string | null>(null);

  // --- Abo über den Server ---
  protected readonly sync = inject(ServerSync);
  protected readonly feed = signal<FeedState | null>(null);
  protected readonly feedError = signal<string | null>(null);
  protected readonly feedBusy = signal(false);

  constructor() {
    effect(() => {
      const login = this.sync.login();
      this.feed.set(null);
      if (login) untracked(() => this.loadFeed());
    });
  }

  private async loadFeed(): Promise<void> {
    await this.feedAction(async (login) => this.feed.set(await serverApi.feed(login)));
  }

  /** Richtet das Abo ein; mit `replace` bekommt es eine neue Adresse und die alte gilt nicht mehr. */
  protected async newFeedAddress(replace: boolean): Promise<void> {
    const text =
      'Die bisherige Adresse gilt danach nicht mehr: Kalender, die sie abonniert haben, bekommen keine Termine mehr ' +
      'und müssen die neue abonnieren. Neue Adresse erzeugen?';
    if (replace && !confirm(text)) return;
    await this.feedAction(async (login) => {
      this.feed.set(await serverApi.newFeedAddress(login));
      // Damit das Abo nicht leer ist, falls noch kein Abgleich den Kalender geschickt hat
      await this.sync.publishFeed(true);
      this.feed.set(await serverApi.feed(login));
    });
  }

  protected async endFeed(): Promise<void> {
    if (!confirm('Abo beenden? Kalender, die die Adresse abonniert haben, bekommen keine Termine mehr.')) return;
    await this.feedAction(async (login) => {
      await serverApi.endFeed(login);
      this.feed.set({ url: '' });
    });
  }

  private async feedAction(action: (login: NonNullable<ReturnType<ServerSync['login']>>) => Promise<void>): Promise<void> {
    const login = this.sync.login();
    if (!login) return;
    this.feedBusy.set(true);
    this.feedError.set(null);
    try {
      await action(login);
    } catch (e) {
      this.feedError.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.feedBusy.set(false);
    }
  }

  /** Dieselbe Adresse mit webcal://: Ein Klick öffnet die Kalender-App mit dem Abo. */
  protected webcal(url: string): string {
    return url.replace(/^https?:/, 'webcal:');
  }

  protected copy(text: string): void {
    navigator.clipboard?.writeText(text).catch(() => undefined);
  }

  protected selectAll(event: Event): void {
    (event.target as HTMLInputElement).select();
  }

  protected formatTime(iso: string): string {
    return new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  }

  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected async export(action: 'open' | 'share'): Promise<void> {
    const [from, to] = [this.from(), this.to()];
    if (!from || !to || from > to) {
      this.message.set('Bitte einen gültigen Zeitraum wählen („von“ vor „bis“).');
      return;
    }
    if (daysBetween(from, to).length > MAX_DAYS) {
      this.message.set('Der Zeitraum darf höchstens zwei Jahre lang sein.');
      return;
    }
    this.message.set(null);
    const teachers = this.selectedTeachers();
    const options = { withTeacher: teachers.length > 1, blockers: this.includeBlockers() };
    const events = teachers.flatMap((teacher) => this.events.of(teacher, from, to, options));
    const name = teachers.length === 1 ? `Unterricht ${teachers[0].name}` : 'Unterricht';
    const file = new Blob([toICalendar(name, events)], { type: 'text/calendar' });
    const fileName = `${safeFileName(name)}_${from}_${to}.ics`;
    await (action === 'open' ? openFile(fileName, file) : saveFile(fileName, file));
  }

  private selectedTeachers(): Teacher[] {
    const id = this.teacherId();
    return id === ALL_TEACHERS ? this.teachers() : this.teachers().filter((t) => t.id === id);
  }
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}
