import { Appointment } from '../calendar/appointments';
import { Group, today } from '../model';

/**
 * Gruppen, die auf der Download-Seite entstehen, wenn jemand zum Unterricht einer anderen Person dazukommt. Sie
 * gehören zu genau einem Termin und tragen dessen ID, damit zwei Geräte, die dieselbe Anfrage übernehmen, dieselbe
 * Gruppe anlegen.
 */
const SPONTANEOUS_PREFIX = 'spontan-';

export function spontaneousGroupId(appointmentId: string): string {
  return SPONTANEOUS_PREFIX + appointmentId;
}

export function isSpontaneous(group: Group): boolean {
  return group.id.startsWith(SPONTANEOUS_PREFIX);
}

/** Ein einzelner, noch nicht stattgefundener Termin ohne erfasste Stunde: nur den kann man tauschen oder teilen. */
export function isOpenSingle(appointment: Appointment): boolean {
  const once = !appointment.repeat || appointment.repeat.count <= 1;
  return once && !appointment.lessonId && appointment.date >= today();
}
