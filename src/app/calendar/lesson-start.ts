import { Lesson, lessonAt } from '../model';
import { Appointment, minutesOf, Occurrence, startMinutes, timeOf } from './appointments';

/** So viele Minuten vor Beginn und nach Ende gilt ein Termin noch als „jetzt“. */
const MARGIN_MINUTES = 10;

export interface LessonTime {
  start: string;
  /** Nur bei Übernahme aus dem Kalender bekannt */
  durationMinutes?: number;
}

/** Was „+ Neue Stunde“ tun soll: eine vorhandene Stunde öffnen oder eine mit dieser Zeit anlegen */
export type LessonStart = { open: Lesson } | { create: LessonTime };

/**
 * Läuft gerade ein Termin aus `todaysOccurrences` (oder beginnt er in den nächsten 10 Minuten bzw. ist er seit
 * höchstens 10 Minuten vorbei), wird die Stunde zu diesem Termin geöffnet: die vom Termin selbst (`lessonId`)
 * oder eine Stunde von heute, deren Beginn im Termin liegt. Gibt es keine, entsteht eine mit Beginn und Dauer des
 * Termins. Ohne laufenden Termin entsteht eine Stunde zur aktuellen Uhrzeit, auf 10 Minuten gerundet.
 */
export function lessonStartAt(owner: { lessons: Lesson[] }, date: string, todaysOccurrences: Occurrence[], now: Date): LessonStart {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const current = runningAppointment(todaysOccurrences, minutes);
  if (!current) return { create: { start: timeOf(Math.min(Math.round(minutes / 10) * 10, 23 * 60 + 50)) } };
  const lesson = lessonOf(owner, date, current);
  return lesson ? { open: lesson } : { create: { start: current.start, durationMinutes: current.durationMinutes } };
}

function runningAppointment(occurrences: Occurrence[], minutes: number): Appointment | undefined {
  return (
    occurrences
      .map(({ appointment }) => appointment)
      .filter((a) => {
        const start = startMinutes(a);
        return start - MARGIN_MINUTES <= minutes && minutes <= start + a.durationMinutes + MARGIN_MINUTES;
      })
      // Bei mehreren der Termin, dessen Beginn am nächsten liegt
      .sort((a, b) => Math.abs(startMinutes(a) - minutes) - Math.abs(startMinutes(b) - minutes))[0]
  );
}

/** Stunde zum Termin: die verknüpfte, sonst eine heutige mit Beginn im Termin, sonst eine heutige ohne Uhrzeit */
export function lessonOf(owner: { lessons: Lesson[] }, date: string, appointment: Appointment): Lesson | undefined {
  const linked = owner.lessons.find((lesson) => lesson.id === appointment.lessonId);
  if (linked) return linked;
  const start = startMinutes(appointment);
  const within = owner.lessons.find(
    (lesson) =>
      lesson.date === date &&
      lesson.start !== undefined &&
      minutesOf(lesson.start) >= start - MARGIN_MINUTES &&
      minutesOf(lesson.start) < start + appointment.durationMinutes,
  );
  return within ?? lessonAt(owner, date, appointment.start);
}
