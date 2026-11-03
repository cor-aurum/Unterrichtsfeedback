import { Appointment, endTime } from './appointments';

/**
 * Zustand eines Termins an einem Tag, farblich unterschieden:
 * - `planned`: geplant, noch keine Stunde erfasst
 * - `done`: geplant und Stunde erfasst
 * - `lessonOnly`: erfasste Stunde ohne geplanten Termin (Termin entstand aus der Stunde)
 * - `missed`: vorbei, aber keine Stunde erfasst
 */
export type AppointmentState = 'planned' | 'done' | 'lessonOnly' | 'missed';

export const APPOINTMENT_STATE_LABELS: Record<AppointmentState, string> = {
  planned: 'Geplant',
  done: 'Stunde erfasst',
  lessonOnly: 'Stunde ohne Termin',
  missed: 'Vorbei, keine Stunde',
};

export function appointmentState(appointment: Appointment, date: string, hasLesson: boolean, now: Date): AppointmentState {
  if (appointment.lessonId) return 'lessonOnly';
  if (hasLesson) return 'done';
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const nowTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const over = date < today || (date === today && endTime(appointment) <= nowTime);
  return over ? 'missed' : 'planned';
}
