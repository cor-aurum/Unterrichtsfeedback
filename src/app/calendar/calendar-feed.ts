import { computed, inject, Injectable, Signal, signal } from '@angular/core';
import { ConfigStore } from '../config.store';
import { reportPeriodEnd, today } from '../model';
import { addDays } from './appointments';
import { CalendarEvents } from './calendar-events';
import { toICalendar } from './ical';

/** Das Abo reicht so weit zurück, dass auch gerade vergangene Stunden noch im Kalender stehen (wie auf dem Server). */
export const FEED_DAYS_BACK = 28;
/** Mindestens so weit voraus, auch kurz vor dem Ende eines Berichtszeitraums */
const MIN_DAYS_AHEAD = 56;
const MAX_DAYS_AHEAD = 366;
/** Vorschlag an die Kalender-App, wie oft sie nachsehen soll; viele halten sich nicht daran. */
const REFRESH_HOURS = 1;

/**
 * Der Kalender für das Abo einer Lehrkraft (siehe `ServerSync.publishFeed`): ihre Termine von vier Wochen zurück bis
 * zum Ende des laufenden Berichtszeitraums, mindestens acht Wochen voraus, mit Blockern. Jedes Gerät erzeugt ihn für
 * die eigene Lehrkraft und für die Kolleg:innen aus denselben Zeiträumen; er sieht überall gleich aus.
 */
@Injectable({ providedIn: 'root' })
export class CalendarFeed {
  private readonly events = inject(CalendarEvents);
  private readonly config = inject(ConfigStore).config;
  // Als Signal, damit ein Kalender nur neu entsteht, wenn sich Daten oder Tag ändern.
  private readonly day = signal(today());
  /** Je Lehrkraft ein eigener Kalender, damit das Wechseln zwischen ihnen nichts neu berechnet */
  private readonly contents = new Map<string, Signal<string | null>>();

  /** iCalendar der Lehrkraft; `null`, solange sie nicht in der Konfiguration steht */
  render(teacherId: string): string | null {
    this.day.set(today());
    let content = this.contents.get(teacherId);
    if (!content) {
      content = computed(() => this.build(teacherId));
      this.contents.set(teacherId, content);
    }
    return content();
  }

  private build(teacherId: string): string | null {
    const config = this.config();
    const teacher = config.teachers.find((t) => t.id === teacherId);
    if (!teacher) return null;
    const day = this.day();
    const from = addDays(day, -FEED_DAYS_BACK);
    const periodEnd = reportPeriodEnd(config.reportPeriods, day);
    const to = [addDays(day, MAX_DAYS_AHEAD), maxDate(periodEnd, addDays(day, MIN_DAYS_AHEAD))].sort()[0];
    const events = this.events.of(teacher, from, to, { withTeacher: false, blockers: true });
    return toICalendar(`Unterricht ${teacher.name}`, events, new Date(), { refreshHours: REFRESH_HOURS });
  }
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}
