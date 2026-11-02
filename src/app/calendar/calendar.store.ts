import { effect, inject, Injectable } from '@angular/core';
import { ConfigStore } from '../config.store';
import { CalendarSettings, newId, Teacher, today } from '../model';
import { storedSignal } from '../stored-signal';
import { StudentsStore } from '../students.store';
import {
  addDays,
  Appointment,
  daysBetween,
  FreeSlot,
  minutesOf,
  Occurrence,
  occursOn,
  ownerOf,
  parseAppointments,
  startMinutes,
  timeOf,
  weekday,
  withLessonAppointments,
} from './appointments';
import { Blocker, blocks, parseBlockers } from './blockers';

/** So weit im Voraus sucht `nextFreeSlot` einen freien Slot. */
const SLOT_SEARCH_DAYS = 8 * 7;
/** In so vielen Wochen muss ein Slot frei sein, damit dort ein wöchentlicher Termin beginnen kann. */
const WEEKLY_CHECK_WEEKS = 12;

@Injectable({ providedIn: 'root' })
export class CalendarStore {
  readonly appointments = storedSignal<Appointment[]>('feedback.appointments', () => [], parseAppointments);
  readonly blockers = storedSignal<Blocker[]>('feedback.blockers', () => [], parseBlockers);
  private readonly students = inject(StudentsStore).students;
  private readonly config = inject(ConfigStore).config;

  constructor() {
    // Erfasste Stunden mit Uhrzeit stehen immer im Kalender, auch nachträglich angelegte (Gruppen: GroupsStore).
    effect(() => {
      const appointments = this.appointments();
      const next = withLessonAppointments(appointments, this.students(), 'student', this.config().calendar.defaultDurationMinutes);
      if (next !== appointments) this.appointments.set(next);
    });
  }

  add(appointment: Omit<Appointment, 'id'>): void {
    this.appointments.update((list) => [...list, { ...appointment, id: newId() }]);
  }

  /** Bei wöchentlichen Terminen gilt die Änderung für alle Wiederholungen. */
  update(id: string, change: Omit<Appointment, 'id'>): void {
    this.appointments.update((list) => list.map((a) => (a.id === id ? { ...change, id } : a)));
  }

  remove(id: string): void {
    this.appointments.update((list) => list.filter((a) => a.id !== id));
  }

  addBlocker(blocker: Omit<Blocker, 'id'>): void {
    this.blockers.update((list) => [...list, { ...blocker, id: newId() }]);
  }

  updateBlocker(id: string, change: Omit<Blocker, 'id'>): void {
    this.blockers.update((list) => list.map((b) => (b.id === id ? { ...change, id } : b)));
  }

  removeBlocker(id: string): void {
    this.blockers.update((list) => list.filter((b) => b.id !== id));
  }

  /** Blocker des Lehrers, die den Zeitraum (Tage einschließlich) berühren, nach Beginn sortiert */
  blockersOf(teacherId: string, from: string, to: string): Blocker[] {
    return this.blockers()
      .filter((b) => b.teacherId === teacherId && b.from < `${to}T24:00` && b.to > `${from}T00:00`)
      .sort((a, b) => a.from.localeCompare(b.from));
  }

  /** Entfernt alle Termine einer Person oder Gruppe. */
  removeForOwner(ownerId: string): void {
    this.appointments.update((list) => list.filter((a) => ownerOf(a) !== ownerId));
  }

  /**
   * Alle Termine zwischen `from` und `to` (jeweils einschließlich), nach Tag und Uhrzeit sortiert.
   * Mit `ownerIds` nur die Termine dieser Personen und Gruppen, z. B. der Kalender eines Lehrers.
   */
  occurrences(from: string, to: string, ownerIds?: ReadonlySet<string>): Occurrence[] {
    const appointments = this.appointments()
      .filter((appointment) => !ownerIds || ownerIds.has(ownerOf(appointment)))
      .sort((a, b) => startMinutes(a) - startMinutes(b));
    return daysBetween(from, to).flatMap((date) =>
      appointments.filter((appointment) => occursOn(appointment, date)).map((appointment) => ({ date, appointment })),
    );
  }

  /**
   * Erster freier Slot ab jetzt. Die Unterrichtszeiten werden ab ihrem Beginn in Slots der Standardlänge
   * geteilt. Ein Slot ist frei, wenn sich kein Termin mit ihm überschneidet – bei wöchentlicher
   * Wiederholung auch in den folgenden Wochen. Es zählen nur die Unterrichtszeiten des Lehrers, seine Blocker
   * und die Termine seiner Personen und Gruppen (`ownerIds`).
   */
  nextFreeSlot(
    settings: CalendarSettings,
    teacher: Teacher,
    ownerIds: ReadonlySet<string>,
    now = new Date(),
  ): FreeSlot | null {
    const duration = settings.defaultDurationMinutes;
    const weeks = settings.weeklyByDefault ? WEEKLY_CHECK_WEEKS : 1;
    const firstDay = today();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    for (let offset = 0; offset < SLOT_SEARCH_DAYS; offset++) {
      const date = addDays(firstDay, offset);
      const windows = teacher.teachingWindows
        .filter((w) => w.weekday === weekday(date))
        .sort((a, b) => a.from.localeCompare(b.from));
      for (const window of windows) {
        for (let start = minutesOf(window.from); start + duration <= minutesOf(window.to); start += duration) {
          if (offset === 0 && start <= nowMinutes) continue;
          if (this.isFree(teacher, date, start, duration, weeks, ownerIds, true)) {
            return { date, start: timeOf(start), durationMinutes: duration, weekly: settings.weeklyByDefault };
          }
        }
      }
    }
    return null;
  }

  /**
   * Alle freien wöchentlichen Slots der ersten Woche ab `from` (einschließlich), wie bei `nextFreeSlot`: die
   * Unterrichtszeiten in Slots der Standardlänge geteilt, frei über `WEEKLY_CHECK_WEEKS` Wochen. Blocker zählen
   * hier nicht (siehe `isFree`).
   */
  freeWeeklySlots(settings: CalendarSettings, teacher: Teacher, ownerIds: ReadonlySet<string>, from: string): FreeSlot[] {
    const days = Array.from({ length: 7 }, (_, offset) => addDays(from, offset));
    return this.freeSlots(settings, teacher, ownerIds, days, true);
  }

  /** Alle freien einmaligen Slots zwischen `from` und `to` (einschließlich); bereits vergangene zählen nicht. */
  freeSlotsInPeriod(
    settings: CalendarSettings,
    teacher: Teacher,
    ownerIds: ReadonlySet<string>,
    from: string,
    to: string,
    now = new Date(),
  ): FreeSlot[] {
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    return this.freeSlots(settings, teacher, ownerIds, daysBetween(from, to), false).filter(
      (slot) => slot.date > today() || (slot.date === today() && minutesOf(slot.start) > nowMinutes),
    );
  }

  private freeSlots(
    settings: CalendarSettings,
    teacher: Teacher,
    ownerIds: ReadonlySet<string>,
    days: string[],
    weekly: boolean,
  ): FreeSlot[] {
    const duration = settings.defaultDurationMinutes;
    const weeks = weekly ? WEEKLY_CHECK_WEEKS : 1;
    const slots: FreeSlot[] = [];
    for (const date of days) {
      const windows = teacher.teachingWindows
        .filter((w) => w.weekday === weekday(date))
        .sort((a, b) => a.from.localeCompare(b.from));
      for (const window of windows) {
        for (let start = minutesOf(window.from); start + duration <= minutesOf(window.to); start += duration) {
          if (this.isFree(teacher, date, start, duration, weeks, ownerIds, !weekly)) {
            slots.push({ date, start: timeOf(start), durationMinutes: duration, weekly });
          }
        }
      }
    }
    return slots;
  }

  /**
   * Mit `respectBlockers` darf der Slot an seinem Tag nicht blockiert sein. Beim wöchentlichen Verteilen bleibt
   * das aus: Eine einmalige Abwesenheit soll keinen Wochentermin für immer verhindern.
   */
  private isFree(
    teacher: Teacher,
    date: string,
    start: number,
    duration: number,
    weeks: number,
    ownerIds: ReadonlySet<string>,
    respectBlockers: boolean,
  ): boolean {
    if (respectBlockers && this.blockersOf(teacher.id, date, date).some((b) => blocks(b, date, start, duration))) {
      return false;
    }
    for (let week = 0; week < weeks; week++) {
      const day = addDays(date, week * 7);
      const overlaps = this.occurrences(day, day, ownerIds).some(({ appointment }) => {
        const otherStart = startMinutes(appointment);
        return start < otherStart + appointment.durationMinutes && otherStart < start + duration;
      });
      if (overlaps) return false;
    }
    return true;
  }
}
