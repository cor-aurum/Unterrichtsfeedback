import { formatLongDate, Lesson, newId, Student } from '../model';

/** Geplanter Unterricht einer Person. Mit `weekly` wiederholt er sich ab `date` jede Woche ohne Ende. */
export interface Appointment {
  id: string;
  studentId: string;
  /** ISO-Datum (YYYY-MM-DD) des (ersten) Termins */
  date: string;
  /** Beginn als HH:MM */
  start: string;
  durationMinutes: number;
  weekly: boolean;
  /**
   * Gesetzt, wenn der Termin aus einer erfassten Stunde mit Uhrzeit entstanden ist. Er folgt dann der Stunde
   * (siehe `withLessonAppointments`) und verschwindet mit ihr.
   */
  lessonId?: string;
}

/** Freier Slot, in den sich eine Person eintragen lässt. */
export type FreeSlot = Omit<Appointment, 'id' | 'studentId'>;

/** z. B. „Montag, 16. November 2026, 14:45–15:30, jede Woche“ */
export function slotText(slot: FreeSlot): string {
  const end = timeOf(minutesOf(slot.start) + slot.durationMinutes);
  return `${formatLongDate(slot.date)}, ${slot.start}–${end}${slot.weekly ? ', jede Woche' : ''}`;
}

/** Ein Termin an einem bestimmten Tag; bei wöchentlichen Terminen eine der Wiederholungen. */
export interface Occurrence {
  date: string;
  appointment: Appointment;
}

export function occursOn(appointment: Appointment, date: string): boolean {
  if (appointment.weekly) {
    return date >= appointment.date && weekday(date) === weekday(appointment.date);
  }
  return date === appointment.date;
}

export function startMinutes(appointment: Appointment): number {
  return minutesOf(appointment.start);
}

export function endTime(appointment: Appointment): string {
  return timeOf(startMinutes(appointment) + appointment.durationMinutes);
}

/** „HH:MM“ → Minuten seit Mitternacht */
export function minutesOf(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/** Minuten seit Mitternacht → „HH:MM“ */
export function timeOf(minutes: number): string {
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Tage als ISO-Datum; gerechnet in UTC, damit die Zeitumstellung keinen Tag verschiebt. */
export function addDays(date: string, days: number): string {
  const day = new Date(date + 'T00:00:00Z');
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

export const WEEKDAY_NAMES = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

/** 0 = Montag … 6 = Sonntag */
export function weekday(date: string): number {
  return (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7;
}

export function mondayOf(date: string): string {
  return addDays(date, -weekday(date));
}

export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

export function parseAppointments(data: unknown): Appointment[] {
  if (!Array.isArray(data)) return [];
  return data
    .filter(
      (a: Partial<Appointment>) =>
        typeof a?.studentId === 'string' &&
        typeof a.date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(a.date) &&
        typeof a.start === 'string' &&
        /^\d{2}:\d{2}$/.test(a.start),
    )
    .map((a: Appointment) => ({
      id: typeof a.id === 'string' ? a.id : newId(),
      studentId: a.studentId,
      date: a.date,
      start: a.start,
      durationMinutes: Number(a.durationMinutes) > 0 ? Number(a.durationMinutes) : 45,
      weekly: a.weekly === true,
      ...(typeof a.lessonId === 'string' ? { lessonId: a.lessonId } : {}),
    }));
}

/**
 * Ergänzt die Termine so, dass jede erfasste Stunde mit Uhrzeit im Kalender steht: Deckt kein anderer Termin der
 * Person Tag und Beginn ab, bekommt die Stunde einen eigenen einmaligen Termin. Dieser folgt Datum und Uhrzeit der
 * Stunde und entfällt, wenn die Stunde gelöscht wird, keine Uhrzeit mehr hat oder ein anderer Termin sie abdeckt.
 * Gibt dieselbe Liste zurück, wenn nichts zu ändern ist.
 */
export function withLessonAppointments(
  appointments: Appointment[],
  students: Student[],
  defaultDurationMinutes: number,
): Appointment[] {
  const timedLessons = new Map(
    students.flatMap((student) =>
      student.lessons.filter((lesson) => lesson.start).map((lesson) => [lesson.id, { student, lesson }] as const),
    ),
  );
  const planned = appointments.filter((appointment) => !appointment.lessonId);
  const covered = (studentId: string, lesson: Lesson) =>
    planned.some((a) => a.studentId === studentId && a.start === lesson.start && occursOn(a, lesson.date));

  const result = [...planned];
  for (const [lessonId, { student, lesson }] of timedLessons) {
    if (covered(student.id, lesson)) continue;
    const existing = appointments.find((a) => a.lessonId === lessonId);
    result.push({
      id: existing?.id ?? `lesson-${lessonId}`,
      studentId: student.id,
      date: lesson.date,
      start: lesson.start!,
      durationMinutes: lesson.durationMinutes ?? existing?.durationMinutes ?? defaultDurationMinutes,
      weekly: false,
      lessonId,
    });
  }
  const unchanged =
    result.length === appointments.length &&
    result.every((a) => {
      const before = appointments.find((b) => b.id === a.id);
      return before !== undefined && JSON.stringify(before) === JSON.stringify(a);
    });
  return unchanged ? appointments : result;
}
