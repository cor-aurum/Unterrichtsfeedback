import { computed, inject, Injectable, signal } from '@angular/core';
import { ConfigStore } from '../config.store';
import { reportPeriodEnd, today } from '../model';
import { addDays } from './appointments';
import { CalendarEvents } from './calendar-events';
import { toICalendar } from './ical';

/** Das Abo reicht so weit zurück, dass auch gerade vergangene Stunden noch im Kalender stehen. */
const DAYS_BACK = 28;
/** Mindestens so weit voraus, auch kurz vor dem Ende eines Berichtszeitraums */
const MIN_DAYS_AHEAD = 56;
const MAX_DAYS_AHEAD = 366;
/** Vorschlag an die Kalender-App, wie oft sie nachsehen soll; viele halten sich nicht daran. */
const REFRESH_HOURS = 1;

/**
 * Der Kalender für das Abo des angemeldeten Lehrers (siehe `ServerSync.publishFeed`): seine Termine von vier Wochen
 * zurück bis zum Ende des laufenden Berichtszeitraums, mindestens acht Wochen voraus, mit Blockern.
 */
@Injectable({ providedIn: 'root' })
export class CalendarFeed {
  private readonly events = inject(CalendarEvents);
  private readonly config = inject(ConfigStore).config;
  // Als Signale, damit der Kalender nur neu entsteht, wenn sich Daten, Tag oder Lehrer ändern.
  private readonly day = signal(today());
  private readonly teacherId = signal<string | null>(null);

  private readonly content = computed(() => {
    const config = this.config();
    const teacher = config.teachers.find((t) => t.id === this.teacherId());
    if (!teacher) return null;
    const day = this.day();
    const from = addDays(day, -DAYS_BACK);
    const periodEnd = reportPeriodEnd(config.reportPeriods, day);
    const to = [addDays(day, MAX_DAYS_AHEAD), maxDate(periodEnd, addDays(day, MIN_DAYS_AHEAD))].sort()[0];
    const events = this.events.of(teacher, from, to, { withTeacher: false, blockers: true });
    return toICalendar(`Unterricht ${teacher.name}`, events, new Date(), { refreshHours: REFRESH_HOURS });
  });

  /** iCalendar des Lehrers; `null`, solange er nicht in der Konfiguration steht */
  render(teacherId: string): string | null {
    this.day.set(today());
    this.teacherId.set(teacherId);
    return this.content();
  }
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}
