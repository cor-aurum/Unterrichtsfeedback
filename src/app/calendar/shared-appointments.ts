import { newId, Period } from '../model';
import { minutesOf, parseRecurrence, Recurrence, timeOf, withRepeat } from './appointments';

/**
 * Termin für mehrere Lehrer, z. B. eine Konferenz oder ein Vorspiel. Er steht im Kalender jedes beteiligten
 * Lehrers. Mit `repeat` wiederholt er sich ab `date`; ohne ist er einmalig.
 */
export interface SharedAppointment {
  id: string;
  title: string;
  /** ISO-Datum (YYYY-MM-DD) des (ersten) Termins */
  date: string;
  /** Beginn als HH:MM */
  start: string;
  durationMinutes: number;
  repeat?: Recurrence;
  /** Freitext, z. B. „Aula“ */
  location: string;
  /** Beteiligte Lehrer; bei `allTeachers` leer gespeichert und je Tag aus dem Berichtszeitraum ergänzt */
  teacherIds: string[];
  /**
   * Gilt für alle Lehrer des Berichtszeitraums am Tag, auch für später dazukommende (siehe
   * `CalendarStore.sharedOccurrences`).
   */
  allTeachers?: boolean;
  /** Die beteiligten Lehrer bekommen in dieser Zeit keine Terminvorschläge (automatische Planung). */
  blocksPlanning: boolean;
}

/** Ein allgemeiner Termin an einem bestimmten Tag; bei Terminserien eine der Wiederholungen. */
export interface SharedOccurrence {
  date: string;
  appointment: SharedAppointment;
}

export function sharedEndTime(appointment: SharedAppointment): string {
  return timeOf(minutesOf(appointment.start) + appointment.durationMinutes);
}

/** Überschneidet der Termin den Zeitraum von `start` bis `start + duration` Minuten (an seinem Tag)? */
export function sharedOverlaps(appointment: SharedAppointment, start: number, duration: number): boolean {
  const own = minutesOf(appointment.start);
  return start < own + appointment.durationMinutes && own < start + duration;
}

export function parseSharedAppointments(data: unknown, periods: Period[]): SharedAppointment[] {
  if (!Array.isArray(data)) return [];
  const isDate = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const isTime = (value: unknown) => typeof value === 'string' && /^\d{2}:\d{2}$/.test(value);
  return (data as Partial<SharedAppointment>[])
    .filter((a) => isDate(a?.date) && isTime(a.start) && Number(a.durationMinutes) > 0)
    .map((a) => ({
      id: typeof a.id === 'string' ? a.id : newId(),
      title: typeof a.title === 'string' ? a.title : '',
      date: a.date!,
      start: a.start!,
      durationMinutes: Number(a.durationMinutes),
      ...withRepeat(parseRecurrence({ ...a, date: a.date! }, periods)),
      location: typeof a.location === 'string' ? a.location : '',
      teacherIds: Array.isArray(a.teacherIds) ? a.teacherIds.filter((id) => typeof id === 'string') : [],
      ...(a.allTeachers ? { allTeachers: true } : {}),
      blocksPlanning: a.blocksPlanning !== false,
    }));
}
