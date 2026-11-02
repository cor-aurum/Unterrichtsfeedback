import { Injectable } from '@angular/core';
import { CalendarSettings, newId, Teacher, today } from '../model';
import { storedSignal } from '../stored-signal';
import {
  addDays,
  Appointment,
  daysBetween,
  FreeSlot,
  minutesOf,
  Occurrence,
  occursOn,
  parseAppointments,
  startMinutes,
  timeOf,
  weekday,
} from './appointments';

/** So weit im Voraus sucht `nextFreeSlot` einen freien Slot. */
const SLOT_SEARCH_DAYS = 8 * 7;
/** In so vielen Wochen muss ein Slot frei sein, damit dort ein wöchentlicher Termin beginnen kann. */
const WEEKLY_CHECK_WEEKS = 12;

@Injectable({ providedIn: 'root' })
export class CalendarStore {
  readonly appointments = storedSignal<Appointment[]>('feedback.appointments', () => [], parseAppointments);

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

  removeForStudent(studentId: string): void {
    this.appointments.update((list) => list.filter((a) => a.studentId !== studentId));
  }

  /**
   * Alle Termine zwischen `from` und `to` (jeweils einschließlich), nach Tag und Uhrzeit sortiert.
   * Mit `studentIds` nur die Termine dieser Personen, z. B. der Kalender eines Lehrers.
   */
  occurrences(from: string, to: string, studentIds?: ReadonlySet<string>): Occurrence[] {
    const appointments = this.appointments()
      .filter((appointment) => !studentIds || studentIds.has(appointment.studentId))
      .sort((a, b) => startMinutes(a) - startMinutes(b));
    return daysBetween(from, to).flatMap((date) =>
      appointments.filter((appointment) => occursOn(appointment, date)).map((appointment) => ({ date, appointment })),
    );
  }

  /**
   * Erster freier Slot ab jetzt. Die Unterrichtszeiten werden ab ihrem Beginn in Slots der Standardlänge
   * geteilt. Ein Slot ist frei, wenn sich kein Termin mit ihm überschneidet – bei wöchentlicher
   * Wiederholung auch in den folgenden Wochen. Es zählen nur die Unterrichtszeiten des Lehrers und
   * die Termine seiner Personen (`studentIds`).
   */
  nextFreeSlot(
    settings: CalendarSettings,
    teacher: Teacher,
    studentIds: ReadonlySet<string>,
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
          if (this.isFree(date, start, duration, weeks, studentIds)) {
            return { date, start: timeOf(start), durationMinutes: duration, weekly: settings.weeklyByDefault };
          }
        }
      }
    }
    return null;
  }

  private isFree(date: string, start: number, duration: number, weeks: number, studentIds: ReadonlySet<string>): boolean {
    for (let week = 0; week < weeks; week++) {
      const day = addDays(date, week * 7);
      const overlaps = this.occurrences(day, day, studentIds).some(({ appointment }) => {
        const otherStart = startMinutes(appointment);
        return start < otherStart + appointment.durationMinutes && otherStart < start + duration;
      });
      if (overlaps) return false;
    }
    return true;
  }
}
