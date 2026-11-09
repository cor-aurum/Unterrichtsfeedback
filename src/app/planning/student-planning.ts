import { computed, inject, Injectable } from '@angular/core';
import { Appointment, daysBetween, FreeSlot, minutesOf, Occurrence, startMinutes, timeOf } from '../calendar/appointments';
import { blocks } from '../calendar/blockers';
import { CalendarStore } from '../calendar/calendar.store';
import { sharedOverlaps } from '../calendar/shared-appointments';
import { ConfigStore } from '../config.store';
import { GroupsStore } from '../groups.store';
import { isActiveIn, Student, Teacher, teacherInstrument, teacherOf, teachingWindowsOn, today } from '../model';
import { storedSignal } from '../stored-signal';
import { StudentsStore } from '../students.store';
import { ServerSync, TransactResult } from '../sync/server-sync';

/** Eine laufende Schüler-Planung auf diesem Gerät; solange sie läuft, zeigt die App nur die Planung. */
export interface PlanningSession {
  /** Lehrkräfte, bei denen man sich eintragen kann, in der Reihenfolge des Berichtszeitraums */
  teacherIds: string[];
  periodId: string;
  from: string;
  to: string;
  /** So viele Einzeltermine darf jede Person im Zeitraum höchstens haben (bereits eingetragene zählen mit). */
  maxPerStudent: number;
  /** Zum Beenden; leer: Beenden nur mit Rückfrage */
  pin: string;
}

/** Ein Termin, den die Person in der Planung sieht: frei zum Wählen oder schon ihrer */
export interface PlanningSlot extends FreeSlot {
  own: boolean;
  /** Name der Gruppe, deren Unterricht sich mit der Zeit überschneidet, z. B. „Gruppe Chor“ */
  groupClash?: string;
  /** Nur bei eigenen einmaligen Terminen: Die Person kann sie selbst wieder entfernen. */
  appointmentId?: string;
}

/**
 * Schüler tragen sich am Tablet selbst für Einzeltermine ein, bei einer oder mehreren Lehrkräften. Angeboten werden
 * die freien Slots im Kalender ihrer Lehrkraft (wie bei „Automatisch einplanen“ im Zeitraum), ohne Zeiten, zu denen
 * die Person anderen Einzelunterricht hat, und ohne Tage, an denen sie schon einen Termin hat. Zeiten mit eigenem
 * Gruppenunterricht bleiben wählbar und sind markiert: Sonst fänden Lehrkräfte, deren Schüler fast alle in Gruppen
 * spielen, kaum jemanden für ihre Einzelstunden. Jede Person darf nur bis zur Höchstzahl wählen; so kann niemand
 * alle guten Zeiten belegen. Sind mehrere Lehrkräfte dabei, wählt eine Person ohne Termin im Berichtszeitraum
 * vorher ihren Lehrer; mit dem ersten Termin steht er für den Zeitraum fest.
 */
@Injectable({ providedIn: 'root' })
export class StudentPlanning {
  private readonly calendar = inject(CalendarStore);
  private readonly groupsStore = inject(GroupsStore);
  private readonly studentsStore = inject(StudentsStore);
  private readonly config = inject(ConfigStore).config;
  private readonly sync = inject(ServerSync);

  readonly session = storedSignal<PlanningSession | null>('feedback.studentPlanning', () => null, parseSession);
  readonly active = computed(() => !!this.session());

  /** Die Lehrkräfte der Planung, in ihrer Reihenfolge */
  readonly teachers = computed<Teacher[]>(() => {
    const ids = this.session()?.teacherIds ?? [];
    return ids.map((id) => this.config().teachers.find((t) => t.id === id)).filter((t): t is Teacher => !!t);
  });

  /** Personen dieser Lehrkräfte im Berichtszeitraum, nach Namen */
  readonly students = computed<Student[]>(() => {
    const session = this.session();
    return session ? this.studentsOf(session.teacherIds, session.periodId) : [];
  });

  /** Einzeltermine je Person im Zeitraum (auch Wiederholungen von Serien), in den Kalendern der Lehrkräfte */
  readonly lessonsPerStudent = computed(() => {
    const session = this.session();
    const counts = new Map<string, Occurrence[]>();
    if (!session) return counts;
    const inCalendars = this.inCalendars(this.teachers());
    for (const occurrence of this.calendar.occurrences(session.from, session.to, (a) => !!a.studentId && inCalendars(a))) {
      const id = occurrence.appointment.studentId!;
      counts.set(id, [...(counts.get(id) ?? []), occurrence]);
    }
    return counts;
  });

  /** Je Lehrkraft alle freien Slots in ihrem Kalender, ab jetzt bis zum Ende der Planung */
  readonly freeSlots = computed(() => {
    const session = this.session();
    const slots = new Map<string, FreeSlot[]>();
    if (!session) return slots;
    for (const teacher of this.teachers()) slots.set(teacher.id, this.freeSlotsOf(teacher, session.from, session.to));
    return slots;
  });

  /** Personen mit mindestens einem Einzeltermin im Berichtszeitraum, bei welchem Lehrer auch immer */
  private readonly withLessons = computed(() => {
    const session = this.session();
    const period = this.config().reportPeriods.find((p) => p.id === session?.periodId);
    if (!period) return new Set<string>();
    return new Set(this.calendar.occurrences(period.from, period.to, (a) => !!a.studentId).map((o) => o.appointment.studentId!));
  });

  /** Wählt die Person ihren Lehrer noch? Bei mehreren Lehrkräften, solange sie im Zeitraum keinen Termin hat. */
  needsTeacher(student: Student): boolean {
    return this.teachers().length > 1 && !this.withLessons().has(student.id);
  }

  /** Lehrer der Person im Zeitraum; wer noch wählt, hat noch keinen. */
  teacherOf(student: Student): Teacher | null {
    const session = this.session();
    if (!session || this.needsTeacher(student)) return null;
    return teacherOf(student, this.config(), session.periodId);
  }

  /** Instrument der Lehrkraft für die Auswahl, z. B. „Klavier“ */
  instrumentOf(teacher: Teacher): string {
    return teacherInstrument(teacher, this.config()).name;
  }

  /** Freie Zeiten je Lehrkraft für die Auswahl, z. B. „34 freie Zeiten“ */
  freeCount(teacher: Teacher): number {
    return this.freeSlots().get(teacher.id)?.length ?? 0;
  }

  /**
   * Freie Slots und schon eingetragene Einzeltermine geteilt durch die Zahl der Personen, aufgerundet: So lassen
   * sich alle Stunden der Lehrkraft vergeben, auch wenn dann nicht jede Person gleich viele bekommt. Höchstens so
   * viele, wie es Unterrichtstage gibt, denn mehr als einen Termin am Tag bietet die Planung nicht an.
   */
  fairShare(
    teacherIds: string[],
    periodId: string,
    from: string,
    to: string,
  ): { slots: number; days: number; students: number; share: number } {
    const teachers = this.config().teachers.filter((t) => teacherIds.includes(t.id));
    const students = this.studentsOf(teacherIds, periodId);
    if (teachers.length === 0 || students.length === 0 || from > to) {
      return { slots: 0, days: 0, students: students.length, share: 0 };
    }
    const inCalendars = this.inCalendars(teachers);
    const ids = new Set(students.map((s) => s.id));
    const booked = this.calendar.occurrences(from, to, (a) => !!a.studentId && ids.has(a.studentId) && inCalendars(a));
    const free = teachers.flatMap((teacher) => this.freeSlotsOf(teacher, from, to));
    const slots = free.length + booked.length;
    const days = new Set([...free, ...booked].map(({ date }) => date)).size;
    return { slots, days, students: students.length, share: Math.min(days, Math.ceil(slots / students.length)) };
  }

  /** Wie viele Termine die Person noch wählen darf */
  remaining(student: Student): number {
    const max = this.session()?.maxPerStudent ?? 0;
    return Math.max(0, max - (this.lessonsPerStudent().get(student.id)?.length ?? 0));
  }

  count(student: Student): number {
    return this.lessonsPerStudent().get(student.id)?.length ?? 0;
  }

  /**
   * Was die Person sieht, nach Tag und Uhrzeit: ihre eigenen künftigen Einzeltermine und die freien Slots ihrer
   * Lehrkraft (beim Wählen der angesehenen), die für sie passen.
   */
  slotsFor(student: Student, teacher: Teacher): PlanningSlot[] {
    const session = this.session();
    if (!session) return [];
    const own = (this.lessonsPerStudent().get(student.id) ?? []).filter(({ date }) => isUpcoming(date, '23:59'));
    const ownDays = new Set(own.map(({ date }) => date));
    const individual = this.otherIndividualLessonsOf(student, teacher, session.from, session.to);
    const groups = this.groupLessonsOf(student, session.from, session.to);
    const names = this.groupsStore.ownerNames();
    const groupClash = (slot: FreeSlot) => {
      const clash = groups.find((occurrence) => overlaps(occurrence, slot));
      return clash ? { groupClash: names.get(clash.appointment.groupId!) ?? 'Gruppe' } : {};
    };
    const free = (this.freeSlots().get(teacher.id) ?? []).filter(
      (slot) => !ownDays.has(slot.date) && !individual.some((occurrence) => overlaps(occurrence, slot)),
    );
    const mine: PlanningSlot[] = own.map(({ date, appointment }) => ({
      date,
      start: appointment.start,
      durationMinutes: appointment.durationMinutes,
      own: true,
      ...groupClash({ date, start: appointment.start, durationMinutes: appointment.durationMinutes }),
      // Nur einmalige Termine kann die Person selbst wieder entfernen; Serien und erfasste Stunden nicht.
      ...(isOwnOneOff(appointment) ? { appointmentId: appointment.id } : {}),
    }));
    const offered: PlanningSlot[] = free.map((slot) => ({ ...slot, own: false, ...groupClash(slot) }));
    return [...mine, ...offered].sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  }

  /**
   * Trägt den Slot ein, wenn die Person noch wählen darf und er noch frei ist. Wählt sie ihren Lehrer noch, steht er
   * damit für den Berichtszeitraum fest. Mit Server gilt der neueste Stand aller Tablets: Erst abgleichen, dann
   * prüfen und eintragen, dann sofort speichern; war ein anderes Tablet schneller, ist die Zeit vergeben
   * (`rejected`).
   */
  async book(student: Student, teacher: Teacher, slot: FreeSlot): Promise<TransactResult> {
    const result = await this.sync.transact(() => this.tryBook(student.id, teacher, slot));
    // Wurde die Buchung schon gespeichert, bevor ein späterer Schritt scheiterte, steht sie nun als eigene da.
    return result === 'rejected' && this.hasOwn(student.id, teacher, slot) ? 'saved' : result;
  }

  /** Trägt ein und liefert die Rücknahme; `false`, wenn es nicht (mehr) geht */
  private tryBook(studentId: string, teacher: Teacher, slot: FreeSlot): (() => void) | false {
    const session = this.session();
    const student = this.studentsStore.allStudents().find((s) => s.id === studentId);
    if (!session || !student || this.remaining(student) === 0) return false;
    const stillFree = this.slotsFor(student, teacher).some((s) => !s.own && s.date === slot.date && s.start === slot.start);
    if (!stillFree) return false;
    const chosen = this.needsTeacher(student);
    const previousTeacher = student.periods[session.periodId] ?? null;
    if (chosen) this.studentsStore.chooseTeacher(student.id, session.periodId, teacher.id);
    const id = this.calendar.add({ date: slot.date, start: slot.start, durationMinutes: slot.durationMinutes, studentId: student.id });
    return () => {
      this.calendar.remove(id);
      if (chosen) this.studentsStore.chooseTeacher(student.id, session.periodId, previousTeacher);
    };
  }

  private hasOwn(studentId: string, teacher: Teacher, slot: FreeSlot): boolean {
    const student = this.studentsStore.allStudents().find((s) => s.id === studentId);
    return !!student && this.slotsFor(student, teacher).some((s) => s.own && s.date === slot.date && s.start === slot.start);
  }

  unbook(appointmentId: string): void {
    const appointment = this.calendar.appointments().find((a) => a.id === appointmentId);
    if (appointment && isOwnOneOff(appointment)) this.calendar.remove(appointmentId);
  }

  start(session: PlanningSession): void {
    this.session.set(session);
  }

  stop(): void {
    this.session.set(null);
  }

  private studentsOf(teacherIds: string[], periodId: string): Student[] {
    const config = this.config();
    return this.studentsStore
      .allStudents()
      .filter((s) => isActiveIn(s, periodId) && teacherIds.includes(teacherOf(s, config, periodId).id))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  /** Steht der Termin im Kalender einer dieser Lehrkräfte? */
  private inCalendars(teachers: Teacher[]): (appointment: Appointment) => boolean {
    const filters = teachers.map((teacher) => this.groupsStore.calendarFilter(teacher));
    return (appointment) => filters.some((inCalendar) => inCalendar(appointment));
  }

  /**
   * Freie Slots wie `CalendarStore.freeSlotsInPeriod`, aber in einem Durchgang über alle Tage (der Zeitraum ist hier
   * oft ein halbes Jahr lang) und nur ab jetzt.
   */
  private freeSlotsOf(teacher: Teacher, from: string, to: string): FreeSlot[] {
    const config = this.config();
    const duration = config.calendar.defaultDurationMinutes;
    const inCalendar = this.groupsStore.calendarFilter(teacher);
    const byDay = groupByDate(this.calendar.occurrences(from, to, inCalendar));
    const shared = groupByDate(this.calendar.sharedOccurrences(from, to, teacher.id).filter((o) => o.appointment.blocksPlanning));
    const blockers = this.calendar.blockersOf(teacher.id, from, to);
    const slots: FreeSlot[] = [];
    for (const date of daysBetween(from, to)) {
      for (const window of teachingWindowsOn(teacher, config, date)) {
        for (let start = minutesOf(window.from); start + duration <= minutesOf(window.to); start += duration) {
          if (!isUpcoming(date, timeOf(start))) continue;
          const taken = (byDay.get(date) ?? []).some(({ appointment }) => {
            const otherStart = startMinutes(appointment);
            return start < otherStart + appointment.durationMinutes && otherStart < start + duration;
          });
          const blocked =
            blockers.some((b) => blocks(b, date, start, duration)) ||
            (shared.get(date) ?? []).some(({ appointment }) => sharedOverlaps(appointment, start, duration));
          if (!taken && !blocked) slots.push({ date, start: timeOf(start), durationMinutes: duration });
        }
      }
    }
    return slots;
  }

  /** Einzelunterricht der Person bei anderen Lehrern; diese Zeiten fallen weg. */
  private otherIndividualLessonsOf(student: Student, teacher: Teacher, from: string, to: string): Occurrence[] {
    const inCalendar = this.groupsStore.calendarFilter(teacher);
    return this.calendar.occurrences(from, to, (a) => a.studentId === student.id && !inCalendar(a));
  }

  /** Gruppenunterricht der Person, bei allen Lehrern; diese Zeiten werden markiert. */
  private groupLessonsOf(student: Student, from: string, to: string): Occurrence[] {
    const groupIds = new Set(this.groupsStore.allGroups().filter((g) => g.memberIds.includes(student.id)).map((g) => g.id));
    if (groupIds.size === 0) return [];
    return this.calendar.occurrences(from, to, (a) => !!a.groupId && groupIds.has(a.groupId));
  }
}

/** Einmaliger Termin ohne erfasste Stunde: den hat die Person (oder die Lehrkraft) eingetragen. */
function isOwnOneOff(appointment: Appointment): boolean {
  return !appointment.repeat && !appointment.lessonId;
}

/** Noch nicht vorbei: ein späterer Tag oder heute nach der Uhrzeit */
function isUpcoming(date: string, start: string): boolean {
  const day = today();
  if (date !== day) return date > day;
  const now = new Date();
  return minutesOf(start) > now.getHours() * 60 + now.getMinutes();
}

function overlaps({ date, appointment }: Occurrence, slot: FreeSlot): boolean {
  if (date !== slot.date) return false;
  const start = minutesOf(slot.start);
  const otherStart = startMinutes(appointment);
  return start < otherStart + appointment.durationMinutes && otherStart < start + slot.durationMinutes;
}

function groupByDate<T extends { date: string }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(item.date, [...(map.get(item.date) ?? []), item]);
  return map;
}

function parseSession(data: unknown): PlanningSession | null {
  const s = data as (Partial<PlanningSession> & { teacherId?: unknown }) | null;
  // Frühere Planungen hatten genau eine Lehrkraft.
  const teacherIds = Array.isArray(s?.teacherIds)
    ? s.teacherIds.filter((id): id is string => typeof id === 'string')
    : typeof s?.teacherId === 'string'
      ? [s.teacherId]
      : [];
  const valid =
    teacherIds.length > 0 &&
    typeof s?.periodId === 'string' &&
    typeof s.from === 'string' &&
    typeof s.to === 'string' &&
    typeof s.maxPerStudent === 'number';
  if (!valid) return null;
  const { periodId, from, to, maxPerStudent } = s as PlanningSession;
  return { teacherIds, periodId, from, to, maxPerStudent, pin: typeof s!.pin === 'string' ? s!.pin : '' };
}
