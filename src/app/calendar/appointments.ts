import { formatDate, formatLongDate, Group, Lesson, newId, Period, reportPeriodEnd, Student } from '../model';

/** Wiederholung eines Termins: `count` Termine insgesamt (der erste zählt mit), jeweils `everyDays` Tage auseinander */
export interface Recurrence {
  everyDays: number;
  count: number;
}

/**
 * Geplanter Unterricht einer Person (`studentId`) oder einer Gruppe (`groupId`); genau eins von beiden ist
 * gesetzt, siehe `ownerOf`. Mit `repeat` wiederholt er sich ab `date`; ohne ist er einmalig.
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
  repeat?: Recurrence;
  /**
   * Gesetzt, wenn der Termin aus einer erfassten Stunde mit Uhrzeit entstanden ist, bei Gruppen aus einer
   * Gruppenstunde. Er folgt dann der Stunde (siehe `withLessonAppointments`) und verschwindet mit ihr.
   */
  lessonId?: string;
  /**
   * Ausnahme: Der Termin steht im Kalender dieses Lehrers statt in dem des Lehrers der Person, z. B. wenn ein
   * Lehrer ausnahmsweise eine Person eines anderen Lehrers unterrichtet.
   */
  teacherId?: string;
  /**
   * Berichtszeitraum eines Termins einer Person; gesetzt bei neuen Terminen. Überlappen sich Zeiträume, entscheidet
   * er, in welchem Kalender, Plan und welcher Datei der Termin steht. Gruppentermine gehören zum Zeitraum der Gruppe;
   * ältere Termine ohne ihn: siehe `studentPeriodOn`.
   */
  periodId?: string;
}

/** Welche Termine gemeint sind: die Termine dieser Personen und Gruppen (IDs) oder alle, für die die Funktion passt */
export type AppointmentFilter = ReadonlySet<string> | ((appointment: Appointment) => boolean);

export function matchesFilter(appointment: Appointment, filter?: AppointmentFilter): boolean {
  if (!filter) return true;
  return typeof filter === 'function' ? filter(appointment) : filter.has(ownerOf(appointment));
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

/** z. B. „Montag, 16. November 2026, 14:45–15:30, wöchentlich, 12-mal bis 1.2.2027“ */
export function slotText(slot: FreeSlot): string {
  const end = timeOf(minutesOf(slot.start) + slot.durationMinutes);
  return `${formatLongDate(slot.date)}, ${slot.start}–${end}${slot.repeat ? `, ${repeatText(slot)}` : ''}`;
}

/** Ein Termin an einem bestimmten Tag; bei Terminserien eine der Wiederholungen. */
export interface Occurrence {
  date: string;
  appointment: Appointment;
}

/** Was sich wiederholen kann: Termine und allgemeine Termine */
export interface Repeatable {
  date: string;
  repeat?: Recurrence;
}

export function occursOn(appointment: Repeatable, date: string): boolean {
  const { repeat } = appointment;
  if (!repeat) return date === appointment.date;
  const offset = daysFrom(appointment.date, date);
  return offset >= 0 && offset % repeat.everyDays === 0 && offset / repeat.everyDays < repeat.count;
}

/** Datum des letzten Termins einer Serie, bei einmaligen Terminen das Datum selbst */
export function lastDate(appointment: Repeatable): string {
  const { repeat } = appointment;
  return repeat ? addDays(appointment.date, repeat.everyDays * (repeat.count - 1)) : appointment.date;
}

/** Alle Termintage, z. B. zum Prüfen auf Überschneidungen */
export function occurrenceDates(appointment: Repeatable): string[] {
  const { repeat } = appointment;
  if (!repeat) return [appointment.date];
  return Array.from({ length: repeat.count }, (_, i) => addDays(appointment.date, i * repeat.everyDays));
}

/** Läuft die Serie am Tag noch (oder beginnt sie später)? */
export function isRunningSeries(appointment: Repeatable, date: string): boolean {
  return !!appointment.repeat && lastDate(appointment) >= date;
}

/** So viele Termine im Abstand `everyDays` passen von `date` bis einschließlich `until`; mindestens einer. */
export function countUntil(date: string, everyDays: number, until: string): number {
  return Math.max(1, Math.floor(daysFrom(date, until) / everyDays) + 1);
}

/** Serie bis zum Ende des Berichtszeitraums, in dem `date` liegt; eine Serie hat mindestens zwei Termine. */
export function recurrenceUntilPeriodEnd(periods: Period[], date: string, everyDays: number): Recurrence {
  return { everyDays, count: Math.max(2, countUntil(date, everyDays, reportPeriodEnd(periods, date))) };
}

/** z. B. „täglich, 5-mal bis 7.11.2026“, „wöchentlich, …“, „alle 3 Tage, …“ */
export function repeatText(appointment: Repeatable): string {
  if (!appointment.repeat) return 'einmalig';
  return `${repeatEveryText(appointment)}, ${appointment.repeat.count}-mal bis ${formatDate(lastDate(appointment))}`;
}

/** Nur der Abstand, z. B. „wöchentlich“ oder „alle 3 Tage“ */
export function repeatEveryText(appointment: Repeatable): string {
  const { repeat } = appointment;
  if (!repeat) return 'einmalig';
  if (repeat.everyDays === 1) return 'täglich';
  if (repeat.everyDays === 7) return 'wöchentlich';
  return repeat.everyDays % 7 === 0 ? `alle ${repeat.everyDays / 7} Wochen` : `alle ${repeat.everyDays} Tage`;
}

/** Tage von `from` bis `to` (negativ, wenn `to` früher liegt); in UTC, damit die Zeitumstellung nicht stört */
export function daysFrom(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000);
}

/**
 * Wiederholung aus gespeicherten Daten. Frühere wöchentliche Termine ohne Ende (`weekly`) laufen bis zum Ende
 * des Berichtszeitraums, in dem ihr erster Termin liegt.
 */
export function parseRecurrence(data: { date: string; repeat?: unknown; weekly?: unknown }, periods: Period[]): Recurrence | undefined {
  const repeat = data.repeat as Partial<Recurrence> | undefined;
  if (repeat && Number(repeat.everyDays) >= 1 && Number(repeat.count) >= 2) {
    return { everyDays: Math.round(Number(repeat.everyDays)), count: Math.round(Number(repeat.count)) };
  }
  if (data.weekly === true) return recurrenceUntilPeriodEnd(periods, data.date, 7);
  return undefined;
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

/** `periods` braucht es nur für frühere wöchentliche Termine (siehe `parseRecurrence`). */
export function parseAppointments(data: unknown, periods: Period[]): Appointment[] {
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
      ...withRepeat(parseRecurrence(a, periods)),
      ...(typeof a.lessonId === 'string' ? { lessonId: a.lessonId } : {}),
      ...(typeof a.teacherId === 'string' ? { teacherId: a.teacherId } : {}),
      ...(typeof a.periodId === 'string' && typeof a.studentId === 'string' ? { periodId: a.periodId } : {}),
    }));
}

/** `repeat` nur, wenn es eine Wiederholung gibt; so steht bei einmaligen Terminen nichts Überflüssiges in der Datei. */
export function withRepeat(repeat: Recurrence | undefined): { repeat?: Recurrence } {
  return repeat ? { repeat } : {};
}

/**
 * Ergänzt die Termine so, dass jede erfasste Stunde mit Uhrzeit im Kalender steht: Beginnt sie in keinem anderen
 * Termin der Person (oder Gruppe), bekommt die Stunde einen eigenen einmaligen Termin. Dieser folgt Datum
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
  // Ein Termin deckt die Stunde ab, wenn sie in ihm beginnt (bis 10 Minuten vorher), z. B. leicht verschoben.
  const covered = (owner: string, lesson: Lesson) =>
    planned.some(
      (a) =>
        ownerOf(a) === owner &&
        occursOn(a, lesson.date) &&
        minutesOf(lesson.start!) >= startMinutes(a) - 10 &&
        minutesOf(lesson.start!) < startMinutes(a) + a.durationMinutes,
    );

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
        lessonId: lesson.id,
        ...(kind === 'student' && lesson.periodId ? { periodId: lesson.periodId } : {}),
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
