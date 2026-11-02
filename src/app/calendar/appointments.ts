import { formatLongDate, Group, Lesson, newId, Student } from '../model';

/**
 * Geplanter Unterricht einer Person (`studentId`) oder einer Gruppe (`groupId`); genau eins von beiden ist
 * gesetzt, siehe `ownerOf`. Mit `weekly` wiederholt er sich ab `date` jede Woche ohne Ende.
 */
export interface Appointment {
  id: string;
  studentId?: string;
  groupId?: string;
  /** ISO-Datum (YYYY-MM-DD) des (ersten) Termins */
  date: string;
  /** Beginn als HH:MM */
  start: string;
  durationMinutes: number;
  weekly: boolean;
  /**
   * Gesetzt, wenn der Termin aus einer erfassten Stunde mit Uhrzeit entstanden ist, bei Gruppen aus einer
   * Gruppenstunde. Er folgt dann der Stunde (siehe `withLessonAppointments`) und verschwindet mit ihr.
   */
  lessonId?: string;
}

/** ID der Person oder Gruppe, der der Termin gehört; IDs sind eindeutig, beide passen in eine Menge. */
export function ownerOf(appointment: Appointment): string {
  return appointment.studentId ?? appointment.groupId ?? '';
}

/** Termin, der einer erfassten Stunde folgt und deshalb nicht von Hand gelöscht wird */
export function followsLesson(appointment: Appointment): boolean {
  return !!appointment.lessonId;
}

/** Freier Slot, in den sich eine Person eintragen lässt. */
export type FreeSlot = Omit<Appointment, 'id' | 'studentId' | 'groupId'>;

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
      (a: Partial<Appointment> & { fromGroupLesson?: boolean }) =>
        // Termine früherer Gruppenstunden (je Mitglied eine Stunde) entfallen; sie entstehen bei Bedarf neu.
        !a?.fromGroupLesson &&
        (typeof a?.studentId === 'string' || typeof a?.groupId === 'string') &&
        typeof a.date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(a.date) &&
        typeof a.start === 'string' &&
        /^\d{2}:\d{2}$/.test(a.start),
    )
    .map((a: Appointment) => ({
      id: typeof a.id === 'string' ? a.id : newId(),
      ...(typeof a.studentId === 'string' ? { studentId: a.studentId } : { groupId: a.groupId }),
      date: a.date,
      start: a.start,
      durationMinutes: Number(a.durationMinutes) > 0 ? Number(a.durationMinutes) : 45,
      weekly: a.weekly === true,
      ...(typeof a.lessonId === 'string' ? { lessonId: a.lessonId } : {}),
    }));
}

/**
 * Ergänzt die Termine so, dass jede erfasste Stunde mit Uhrzeit im Kalender steht: Deckt kein anderer Termin der
 * Person (oder Gruppe) Tag und Beginn ab, bekommt die Stunde einen eigenen einmaligen Termin. Dieser folgt Datum
 * und Uhrzeit der Stunde und entfällt, wenn die Stunde gelöscht wird, keine Uhrzeit mehr hat oder ein anderer
 * Termin sie abdeckt. Personen und Gruppen werden getrennt abgeglichen (`kind`); die Termine der anderen Art
 * bleiben unverändert. Gibt dieselbe Liste zurück, wenn nichts zu ändern ist.
 */
export function withLessonAppointments(
  appointments: Appointment[],
  owners: Student[] | Group[],
  kind: 'student' | 'group',
  defaultDurationMinutes: number,
): Appointment[] {
  const ownerKey = kind === 'student' ? 'studentId' : 'groupId';
  const isOwnFollower = (a: Appointment) => !!a.lessonId && !!a[ownerKey];
  const kept = appointments.filter((a) => !isOwnFollower(a));
  const planned = kept.filter((a) => !a.lessonId);
  const covered = (owner: string, lesson: Lesson) =>
    planned.some((a) => ownerOf(a) === owner && a.start === lesson.start && occursOn(a, lesson.date));

  const result = [...kept];
  for (const owner of owners) {
    for (const lesson of owner.lessons.filter((l) => l.start)) {
      if (covered(owner.id, lesson)) continue;
      const existing = appointments.find((a) => a.lessonId === lesson.id);
      result.push({
        id: existing?.id ?? `lesson-${lesson.id}`,
        [ownerKey]: owner.id,
        date: lesson.date,
        start: lesson.start!,
        durationMinutes: lesson.durationMinutes ?? existing?.durationMinutes ?? defaultDurationMinutes,
        weekly: false,
        lessonId: lesson.id,
      });
    }
  }
  const unchanged =
    result.length === appointments.length &&
    result.every((a) => {
      const before = appointments.find((b) => b.id === a.id);
      return before !== undefined && JSON.stringify(before) === JSON.stringify(a);
    });
  return unchanged ? appointments : result;
}
