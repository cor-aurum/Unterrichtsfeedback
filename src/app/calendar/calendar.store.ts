import { effect, inject, Injectable } from '@angular/core';
import { ConfigStore } from '../config.store';
import {
  CalendarSettings,
  containsDate,
  isTeachingDay,
  newId,
  ReportPeriodEntry,
  Teacher,
  teachingWindowsOn,
  today,
} from '../model';
import { storedSignal } from '../stored-signal';
import { ReportPeriod } from '../report-period';
import { StudentsStore } from '../students.store';
import {
  addDays,
  Appointment,
  AppointmentFilter,
  daysBetween,
  FreeSlot,
  lastDate,
  minutesOf,
  Occurrence,
  occurrenceDates,
  matchesFilter,
  occursOn,
  ownerOf,
  parseAppointments,
  Recurrence,
  recurrenceUntilPeriodEnd,
  startMinutes,
  timeOf,
  weekday,
  withLessonAppointments,
} from './appointments';
import { Blocker, blocks, parseBlockers } from './blockers';
import { parseSharedAppointments, SharedAppointment, SharedOccurrence, sharedOverlaps } from './shared-appointments';

/** So weit im Voraus sucht `nextFreeSlot` einen freien Slot. */
const SLOT_SEARCH_DAYS = 8 * 7;
/** Neue Serien wiederholen sich so oft wie in der Begrüßung gewünscht: täglich, bis der Berichtszeitraum endet. */
const DEFAULT_REPEAT_DAYS = 1;

@Injectable({ providedIn: 'root' })
export class CalendarStore {
  // Vor den Terminen: Frühere wöchentliche Termine bekommen beim Laden das Ende ihres Berichtszeitraums.
  private readonly config = inject(ConfigStore).config;
  /** Auch Personen anderer Zeiträume, damit ihre Stunden im Kalender bleiben */
  private readonly students = inject(StudentsStore).allStudents;
  private readonly reportPeriod = inject(ReportPeriod);
  readonly appointments = storedSignal<Appointment[]>('feedback.appointments', () => [], (data) =>
    parseAppointments(data, this.config().reportPeriods),
  );
  readonly blockers = storedSignal<Blocker[]>('feedback.blockers', () => [], parseBlockers);
  /** Termine für mehrere Lehrer, z. B. Konferenzen */
  readonly sharedAppointments = storedSignal<SharedAppointment[]>('feedback.sharedAppointments', () => [], (data) =>
    parseSharedAppointments(data, this.config().reportPeriods),
  );

  constructor() {
    // Erfasste Stunden mit Uhrzeit stehen immer im Kalender, auch nachträglich angelegte (Gruppen: GroupsStore).
    effect(() => {
      const appointments = this.appointments();
      const next = withLessonAppointments(appointments, this.students(), 'student', this.config().calendar.defaultDurationMinutes);
      if (next !== appointments) this.appointments.set(next);
    });
  }

  /**
   * Liefert die ID des neuen Termins. Termine von Personen gehören zum gewählten Berichtszeitraum, wenn nichts
   * anderes angegeben ist (z. B. der einer Planung).
   */
  add(appointment: Omit<Appointment, 'id'>): string {
    const id = newId();
    const periodId = appointment.studentId ? (appointment.periodId ?? this.reportPeriod.period().id) : undefined;
    this.appointments.update((list) => [...list, { ...appointment, id, ...(periodId ? { periodId } : {}) }]);
    return id;
  }

  /** Bei Terminserien gilt die Änderung für alle Wiederholungen. Der Berichtszeitraum bleibt, wenn er nicht mitkommt. */
  update(id: string, change: Omit<Appointment, 'id'>): void {
    this.appointments.update((list) =>
      list.map((a) => {
        if (a.id !== id) return a;
        const periodId = change.studentId ? (change.periodId ?? a.periodId) : undefined;
        const { periodId: _, ...rest } = change;
        return { ...rest, id, ...(periodId ? { periodId } : {}) };
      }),
    );
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

  addShared(appointment: Omit<SharedAppointment, 'id'>): void {
    this.sharedAppointments.update((list) => [...list, { ...appointment, id: newId() }]);
  }

  /** Bei Terminserien gilt die Änderung für alle Wiederholungen. */
  updateShared(id: string, change: Omit<SharedAppointment, 'id'>): void {
    this.sharedAppointments.update((list) => list.map((a) => (a.id === id ? { ...change, id } : a)));
  }

  removeShared(id: string): void {
    this.sharedAppointments.update((list) => list.filter((a) => a.id !== id));
  }

  /**
   * Allgemeine Termine im Zeitraum (Tage einschließlich), mit `teacherId` nur die dieses Lehrers. Bei Terminen für
   * alle Lehrer des Berichtszeitraums (`allTeachers`) stehen deren Lehrer am Tag in `teacherIds`, auch später
   * dazugekommene.
   */
  sharedOccurrences(from: string, to: string, teacherId?: string): SharedOccurrence[] {
    const appointments = [...this.sharedAppointments()].sort((a, b) => a.start.localeCompare(b.start));
    const periods = this.config().reportPeriods;
    return daysBetween(from, to).flatMap((date) =>
      appointments
        .filter((appointment) => occursOn(appointment, date))
        .map((appointment) =>
          appointment.allTeachers ? { ...appointment, teacherIds: teachersOfPeriodsOn(periods, date) } : appointment,
        )
        .filter((appointment) => !teacherId || appointment.teacherIds.includes(teacherId))
        .map((appointment) => ({ date, appointment })),
    );
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

  /** Nach dem Zusammenführen zweier Personen gehören ihre Termine der verbleibenden. */
  replaceStudent(from: string, into: string): void {
    this.appointments.update((list) => list.map((a) => (a.studentId === from ? { ...a, studentId: into } : a)));
  }

  /**
   * Alle Termine zwischen `from` und `to` (jeweils einschließlich), nach Tag und Uhrzeit sortiert.
   * Mit `filter` nur bestimmte Termine, z. B. die im Kalender eines Lehrers (`GroupsStore.calendarFilter`).
   */
  /** Unterrichtstermine finden nur an Tagen in einem Berichtszeitraum statt, auch Wiederholungen einer Serie. */
  occurrences(from: string, to: string, filter?: AppointmentFilter): Occurrence[] {
    const appointments = this.appointments()
      .filter((appointment) => matchesFilter(appointment, filter))
      .sort((a, b) => startMinutes(a) - startMinutes(b));
    const config = this.config();
    return daysBetween(from, to)
      .filter((date) => isTeachingDay(config, date))
      .flatMap((date) =>
      appointments.filter((appointment) => occursOn(appointment, date)).map((appointment) => ({ date, appointment })),
    );
  }

  /**
   * Einzeltermine der Person, die sich mit dem geplanten Termin überschneiden – egal bei welchem Lehrer. Bei
   * Terminserien zählt jede Wiederholung. `excludeId`: der Termin, der gerade bearbeitet wird. Gruppentermine
   * zählen hier nicht.
   */
  studentClashes(studentId: string, planned: Omit<Appointment, 'id'>, excludeId?: string | null): Occurrence[] {
    const start = minutesOf(planned.start);
    return this.occurrences(planned.date, lastDate(planned), (a) => a.studentId === studentId && a.id !== excludeId).filter(
      ({ date, appointment }) =>
        occursOn(planned, date) &&
        start < startMinutes(appointment) + appointment.durationMinutes &&
        startMinutes(appointment) < start + planned.durationMinutes,
    );
  }

  /**
   * Erster freier Slot ab jetzt. Die Unterrichtszeiten werden ab ihrem Beginn in Slots der Standardlänge
   * geteilt. Ein Slot ist frei, wenn sich kein Termin mit ihm überschneidet – bei einer Serie (wenn neue Termine
   * standardmäßig wiederholt werden) an jedem Termintag. Es zählen nur die Unterrichtszeiten des Lehrers, seine
   * Blocker und die Termine in seinem Kalender (`filter`).
   */
  nextFreeSlot(
    settings: CalendarSettings,
    teacher: Teacher,
    filter: AppointmentFilter,
    now = new Date(),
  ): FreeSlot | null {
    const duration = settings.defaultDurationMinutes;
    const firstDay = today();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    for (let offset = 0; offset < SLOT_SEARCH_DAYS; offset++) {
      const date = addDays(firstDay, offset);
      const windows = teachingWindowsOn(teacher, this.config(), date, this.reportPeriod.period().id);
      for (const window of windows) {
        for (let start = minutesOf(window.from); start + duration <= minutesOf(window.to); start += duration) {
          if (offset === 0 && start <= nowMinutes) continue;
          const repeat = settings.repeatByDefault ? this.untilPeriodEnd(date, DEFAULT_REPEAT_DAYS) : undefined;
          if (this.isFree(teacher, date, start, duration, repeat, filter, true)) {
            return { date, start: timeOf(start), durationMinutes: duration, ...(repeat ? { repeat } : {}) };
          }
        }
      }
    }
    return null;
  }

  /**
   * Alle freien wöchentlichen Slots der ersten Woche ab `from` (einschließlich), wie bei `nextFreeSlot`: die
   * Unterrichtszeiten in Slots der Standardlänge geteilt, frei in jeder Woche bis zum Ende des Berichtszeitraums.
   * Blocker zählen hier nicht (siehe `isFree`).
   */
  freeWeeklySlots(settings: CalendarSettings, teacher: Teacher, filter: AppointmentFilter, from: string): FreeSlot[] {
    const days = Array.from({ length: 7 }, (_, offset) => addDays(from, offset));
    return this.freeSlots(settings, teacher, filter, days, true);
  }

  /** Alle freien einmaligen Slots zwischen `from` und `to` (einschließlich), auch an vergangenen Tagen */
  freeSlotsInPeriod(settings: CalendarSettings, teacher: Teacher, filter: AppointmentFilter, from: string, to: string): FreeSlot[] {
    return this.freeSlots(settings, teacher, filter, daysBetween(from, to), false);
  }

  private freeSlots(
    settings: CalendarSettings,
    teacher: Teacher,
    filter: AppointmentFilter,
    days: string[],
    weekly: boolean,
  ): FreeSlot[] {
    const duration = settings.defaultDurationMinutes;
    const slots: FreeSlot[] = [];
    for (const date of days) {
      const windows = teachingWindowsOn(teacher, this.config(), date, this.reportPeriod.period().id);
      for (const window of windows) {
        for (let start = minutesOf(window.from); start + duration <= minutesOf(window.to); start += duration) {
          const repeat = weekly ? this.untilPeriodEnd(date, 7) : undefined;
          if (this.isFree(teacher, date, start, duration, repeat, filter, !weekly)) {
            slots.push({ date, start: timeOf(start), durationMinutes: duration, ...(repeat ? { repeat } : {}) });
          }
        }
      }
    }
    return slots;
  }

  /**
   * Frei an jedem Tag der geplanten Serie (`repeat`). Mit `respectBlockers` darf der Slot an seinem ersten Tag
   * nicht blockiert sein. Beim wöchentlichen Verteilen bleibt das aus: Eine einmalige Abwesenheit soll keinen
   * Wochentermin verhindern. Allgemeine Termine, die die Planung blockieren, zählen genauso: einmalige wie
   * Blocker, Serien an jedem ihrer Tage.
   */
  private isFree(
    teacher: Teacher,
    date: string,
    start: number,
    duration: number,
    repeat: Recurrence | undefined,
    filter: AppointmentFilter,
    respectBlockers: boolean,
  ): boolean {
    if (respectBlockers && this.blockersOf(teacher.id, date, date).some((b) => blocks(b, date, start, duration))) {
      return false;
    }
    for (const day of occurrenceDates({ date, repeat })) {
      const overlaps = this.occurrences(day, day, filter).some(({ appointment }) => {
        const otherStart = startMinutes(appointment);
        return start < otherStart + appointment.durationMinutes && otherStart < start + duration;
      });
      if (overlaps || this.sharedBlocks(teacher, day, start, duration, respectBlockers)) return false;
    }
    return true;
  }

  private untilPeriodEnd(date: string, everyDays: number): Recurrence {
    return recurrenceUntilPeriodEnd(this.config().reportPeriods, date, everyDays);
  }

  private sharedBlocks(teacher: Teacher, date: string, start: number, duration: number, includeOneOff: boolean): boolean {
    return this.sharedOccurrences(date, date, teacher.id).some(
      ({ appointment }) =>
        appointment.blocksPlanning &&
        (!!appointment.repeat || includeOneOff) &&
        sharedOverlaps(appointment, start, duration),
    );
  }
}

/** Lehrer aller Berichtszeiträume, in denen der Tag liegt, in deren Reihenfolge */
function teachersOfPeriodsOn(periods: ReportPeriodEntry[], date: string): string[] {
  return [...new Set(periods.filter((period) => containsDate(period, date)).flatMap((period) => period.teacherIds))];
}
