import { Lesson } from '../model';
import { Appointment, endTime } from './appointments';

/**
 * Zustand eines Termins an einem Tag, farblich unterschieden:
 * - `planned`: geplant, noch keine Stunde erfasst
 * - `done`: geplant und Stunde erfasst
 * - `lessonOnly`: erfasste Stunde ohne geplanten Termin (Termin entstand aus der Stunde)
 * - `missed`: vorbei, aber keine Stunde erfasst
 * - `absent`: die Person ist nicht zur Stunde erschienen
 */
export type AppointmentState = 'planned' | 'done' | 'lessonOnly' | 'missed' | 'absent';

export const APPOINTMENT_STATE_LABELS: Record<AppointmentState, string> = {
  planned: 'Geplant',
  done: 'Stunde erfasst',
  lessonOnly: 'Stunde ohne Termin',
  missed: 'Vorbei, keine Stunde',
  absent: 'Nicht erschienen',
};

export function appointmentState(appointment: Appointment, date: string, lesson: Lesson | undefined, now: Date): AppointmentState {
  if (lesson?.absent) return 'absent';
  if (appointment.lessonId) return 'lessonOnly';
  if (lesson) return 'done';
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const nowTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const over = date < today || (date === today && endTime(appointment) <= nowTime);
  return over ? 'missed' : 'planned';
}
