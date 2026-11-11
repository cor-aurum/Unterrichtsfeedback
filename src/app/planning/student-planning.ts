import { computed, inject, Injectable, Injector } from '@angular/core';
import { Appointment, daysBetween, FreeSlot, minutesOf, Occurrence, startMinutes, timeOf } from '../calendar/appointments';
import { blocks } from '../calendar/blockers';
import { CalendarStore } from '../calendar/calendar.store';
import { sharedOverlaps } from '../calendar/shared-appointments';
import { ConfigStore } from '../config.store';
import { GroupsStore } from '../groups.store';
import {
  activeSelfBooking,
  isActiveIn,
  Student,
  Teacher,
  teacherInstrument,
  teacherOf,
  teachingWindowsOn,
  today,
} from '../model';
import { storedSignal } from '../stored-signal';
import { StudentsStore } from '../students.store';
import { ServerSync, TransactResult } from '../sync/server-sync';

/** Wer sich wo und wie oft eintragen kann: am Tablet oder über den Download-Link */
export interface PlanningScope {
  /** Lehrkräfte, bei denen man sich eintragen kann, in der Reihenfolge des Berichtszeitraums */
  teacherIds: string[];
  periodId: string;
  from: string;
  to: string;
  /** So viele Einzeltermine darf jede Person im Zeitraum höchstens haben (bereits eingetragene zählen mit). */
  maxPerStudent: number;
}

/** Eine laufende Schüler-Planung auf diesem Gerät; solange sie läuft, zeigt die App nur die Planung. */
export interface PlanningSession extends PlanningScope {
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

/** Für die Selbsteintragung über den Link: die freien Zeiten je Lehrkraft und was für jede Person gilt */
export interface BookingOffer {
  teachers: { teacher: Teacher; slots: FreeSlot[] }[];
  people: PersonOffer[];
}

export interface PersonOffer {
  student: Student;
  /** Lehrkraft der Person; `null`, solange sie sie mit dem ersten Termin noch wählt */
  teacherId: string | null;
  /** Einzeltermine in der Planung, auch vergangene */
  count: number;
  /** Eigene Einzeltermine ab heute */
  own: Occurrence[];
  /** Je Lehrkraft die Indizes ihrer freien Zeiten, die für die Person wegfallen */
  skip: Map<string, number[]>;
  /** Je Lehrkraft die Indizes ihrer freien Zeiten, zu denen die Person Gruppenunterricht hat */
  clash: Map<string, { index: number; group: string }[]>;
}

/**
 * Schüler tragen sich am Tablet selbst für Einzeltermine ein, bei einer oder mehreren Lehrkräften. Angeboten werden
 * die freien Slots im Kalender ihrer Lehrkraft (wie bei „Automatisch einplanen“ im Zeitraum), ohne Zeiten, zu denen
 * die Person anderen Einzelunterricht hat, und ohne Tage, an denen sie schon einen Termin hat. Zeiten mit eigenem
 * Gruppenunterricht bleiben wählbar und sind markiert: Sonst fänden Lehrkräfte, deren Schüler fast alle in Gruppen
 * spielen, kaum jemanden für ihre Einzelstunden. Jede Person darf nur bis zur Höchstzahl wählen; so kann niemand
 * alle guten Zeiten belegen. Sind mehrere Lehrkräfte dabei, wählt eine Person ohne Termin im Berichtszeitraum
 * vorher ihren Lehrer; mit dem ersten Termin steht er für den Zeitraum fest.
 *
 * Dieselben Regeln gelten für die Selbsteintragung über den Download-Link (`offer`, `bookingProblem`). Läuft sie für
 * eine Lehrkraft, bietet das Tablet deren Zeiten nicht an.
 */
@Injectable({ providedIn: 'root' })
export class StudentPlanning {
  private readonly calendar = inject(CalendarStore);
  private readonly groupsStore = inject(GroupsStore);
  private readonly studentsStore = inject(StudentsStore);
  private readonly config = inject(ConfigStore).config;
  /** Erst bei Bedarf: Der Abgleich braucht über die Pläne (Selbsteintragung) selbst die Planung. */
  private readonly injector = inject(Injector);

  readonly session = storedSignal<PlanningSession | null>('feedback.studentPlanning', () => null, parseSession);
  readonly active = computed(() => !!this.session());

  /** Lehrkräfte der Planung, für die im Zeitraum die Selbsteintragung über den Link läuft */
  readonly linkedTeachers = computed<Teacher[]>(() => {
    const session = this.session();
    if (!session) return [];
    const linked = this.linkBookingTeacherIds(session.periodId);
    return this.teachersById(session.teacherIds.filter((id) => linked.has(id)));
  });

  /** Die Lehrkräfte der Planung in ihrer Reihenfolge; ohne die, für die die Selbsteintragung über den Link läuft */
  readonly teachers = computed<Teacher[]>(() => {
    const session = this.session();
    if (!session) return [];
    const linked = this.linkBookingTeacherIds(session.periodId);
    return this.teachersById(session.teacherIds.filter((id) => !linked.has(id)));
  });

  /** Die Planung, wie sie gerade gilt: nur mit den angebotenen Lehrkräften */
  private readonly scope = computed<PlanningScope | null>(() => {
    const session = this.session();
    return session ? { ...session, teacherIds: this.teachers().map((t) => t.id) } : null;
  });

  /** Personen dieser Lehrkräfte im Berichtszeitraum, nach Namen */
  readonly students = computed<Student[]>(() => {
    const scope = this.scope();
    return scope ? this.studentsOf(scope.teacherIds, scope.periodId) : [];
  });

  /** Einzeltermine je Person im Zeitraum (auch Wiederholungen von Serien), in den Kalendern der Lehrkräfte */
  readonly lessonsPerStudent = computed(() => {
    const scope = this.scope();
    return scope ? this.lessonsIn(scope) : new Map<string, Occurrence[]>();
  });

  /** Je Lehrkraft alle freien Slots in ihrem Kalender, ab jetzt bis zum Ende der Planung */
  readonly freeSlots = computed(() => {
    const scope = this.scope();
    const slots = new Map<string, FreeSlot[]>();
    if (!scope) return slots;
    for (const teacher of this.teachers()) slots.set(teacher.id, this.freeSlotsOf(teacher, scope.from, scope.to, scope.periodId));
    return slots;
  });

  /** Personen mit mindestens einem Einzeltermin im Berichtszeitraum, bei welchem Lehrer auch immer */
  private readonly withLessons = computed(() => this.withLessonsIn(this.session()?.periodId));

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

  /** Lehrkräfte, für die im Zeitraum die Selbsteintragung über den Link läuft */
  linkBookingTeacherIds(periodId: string): Set<string> {
    const period = this.config().reportPeriods.find((p) => p.id === periodId);
    return new Set(activeSelfBooking(period)?.teacherIds ?? []);
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
    const free = teachers.flatMap((teacher) => this.freeSlotsOf(teacher, from, to, periodId));
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
    const scope = this.scope();
    if (!scope) return [];
    return this.slotsWith(scope, student, teacher, this.freeSlots().get(teacher.id) ?? [], this.lessonsPerStudent().get(student.id) ?? []);
  }

  private slotsWith(scope: PlanningScope, student: Student, teacher: Teacher, freeSlots: FreeSlot[], lessons: Occurrence[]): PlanningSlot[] {
    const own = lessons.filter(({ date }) => isUpcoming(date, '23:59'));
    const ownDays = new Set(own.map(({ date }) => date));
    const individual = this.otherIndividualLessonsOf(student, teacher, scope.from, scope.to);
    const groups = this.groupLessonsOf(student, scope.from, scope.to);
    const names = this.groupsStore.ownerNames();
    const groupClash = (slot: FreeSlot) => {
      const clash = clashOf(slot, groups, names);
      return clash ? { groupClash: clash } : {};
    };
    const free = freeSlots.filter((slot) => fits(slot, ownDays, individual));
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
    const result = await this.injector.get(ServerSync).transact(() => this.tryBook(student.id, teacher, slot));
    // Wurde die Buchung schon gespeichert, bevor ein späterer Schritt scheiterte, steht sie nun als eigene da.
    return result === 'rejected' && this.hasOwn(student.id, teacher, slot) ? 'saved' : result;
  }

  /** Trägt ein und liefert die Rücknahme; `false`, wenn es nicht (mehr) geht */
  private tryBook(studentId: string, teacher: Teacher, slot: FreeSlot): (() => void) | false {
    const scope = this.scope();
    const student = this.studentsStore.allStudents().find((s) => s.id === studentId);
    if (!scope || !student || this.remaining(student) === 0) return false;
    const stillFree = this.slotsFor(student, teacher).some((s) => !s.own && s.date === slot.date && s.start === slot.start);
    if (!stillFree) return false;
    return this.enter(scope, student, teacher, slot, this.needsTeacher(student));
  }

  /** Legt den Termin an (`id`: fest, z. B. für Eintragungen über den Link) und liefert die Rücknahme. */
  private enter(scope: PlanningScope, student: Student, teacher: Teacher, slot: FreeSlot, choosing: boolean, id?: string): () => void {
    const previousTeacher = student.periods[scope.periodId] ?? null;
    if (choosing) this.studentsStore.chooseTeacher(student.id, scope.periodId, teacher.id);
    const appointmentId = this.calendar.add(
      { date: slot.date, start: slot.start, durationMinutes: slot.durationMinutes, studentId: student.id, periodId: scope.periodId },
      id,
    );
    return () => {
      this.calendar.remove(appointmentId);
      if (choosing) this.studentsStore.chooseTeacher(student.id, scope.periodId, previousTeacher);
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

  // --- Selbsteintragung über den Download-Link ---

  /**
   * Freie Zeiten je Lehrkraft und je Person, was davon für sie passt. Ab Beginn des heutigen Tages (nicht ab jetzt),
   * damit sich das Angebot nicht mit jeder Stunde ändert und neue Pläne nötig macht; vergangene Zeiten blendet die
   * Seite aus.
   */
  offer(scope: PlanningScope): BookingOffer {
    const config = this.config();
    const teachers = this.teachersById(scope.teacherIds);
    const from = scope.from > today() ? scope.from : today();
    const free = teachers.map((teacher) => ({ teacher, slots: this.freeSlotsOf(teacher, from, scope.to, scope.periodId, false) }));
    const lessons = this.lessonsIn({ ...scope, teacherIds: teachers.map((t) => t.id) });
    const withLessons = this.withLessonsIn(scope.periodId);
    const individual = groupBy(this.calendar.occurrences(from, scope.to, (a) => !!a.studentId), (o) => o.appointment.studentId!);
    const groupLessons = groupBy(this.calendar.occurrences(from, scope.to, (a) => !!a.groupId), (o) => o.appointment.groupId!);
    const groups = this.groupsStore.allGroups();
    const filters = new Map(teachers.map((t) => [t.id, this.groupsStore.calendarFilter(t)]));
    const names = this.groupsStore.ownerNames();
    const people = this.studentsOf(scope.teacherIds, scope.periodId).map((student): PersonOffer => {
      const choosing = teachers.length > 1 && !withLessons.has(student.id);
      const teacherId = choosing ? null : teacherOf(student, config, scope.periodId).id;
      const all = lessons.get(student.id) ?? [];
      const own = all.filter(({ date }) => date >= from);
      const ownDays = new Set(own.map(({ date }) => date));
      const inGroups = groups.filter((g) => g.memberIds.includes(student.id)).flatMap((g) => groupLessons.get(g.id) ?? []);
      const skip = new Map<string, number[]>();
      const clash = new Map<string, { index: number; group: string }[]>();
      for (const { teacher, slots } of free.filter(({ teacher }) => !teacherId || teacher.id === teacherId)) {
        const inCalendar = filters.get(teacher.id)!;
        const elsewhere = (individual.get(student.id) ?? []).filter(({ appointment }) => !inCalendar(appointment));
        const skipped: number[] = [];
        const clashes: { index: number; group: string }[] = [];
        slots.forEach((slot, index) => {
          if (!fits(slot, ownDays, elsewhere)) {
            skipped.push(index);
            return;
          }
          const group = clashOf(slot, inGroups, names);
          if (group) clashes.push({ index, group });
        });
        if (skipped.length) skip.set(teacher.id, skipped);
        if (clashes.length) clash.set(teacher.id, clashes);
      }
      return { student, teacherId, count: all.length, own, skip, clash };
    });
    return { teachers: free, people };
  }

  /**
   * Prüft eine Eintragung über den Link gegen die Daten dieses Geräts: `null`, wenn sie geht, sonst der Grund für die
   * Seite der Person.
   */
  bookingProblem(scope: PlanningScope, studentId: string, teacherId: string, slot: FreeSlot): string | null {
    const student = this.studentsOf(scope.teacherIds, scope.periodId).find((s) => s.id === studentId);
    const teacher = this.teachersById(scope.teacherIds).find((t) => t.id === teacherId);
    if (!student || !teacher) return 'Bei dieser Lehrkraft kannst du dich nicht mehr selbst eintragen.';
    if (!this.choosesTeacher(scope, student) && teacherOf(student, this.config(), scope.periodId).id !== teacher.id) {
      return 'Du hast inzwischen eine andere Lehrkraft.';
    }
    const lessons = this.lessonsIn(scope).get(student.id) ?? [];
    if (lessons.length >= scope.maxPerStudent) return 'Du hast schon alle Termine.';
    const free = this.freeSlotsOf(teacher, scope.from, scope.to, scope.periodId);
    const offered = this.slotsWith(scope, student, teacher, free, lessons);
    const same = (s: PlanningSlot) => !s.own && s.date === slot.date && s.start === slot.start && s.durationMinutes === slot.durationMinutes;
    return offered.some(same) ? null : 'Die Zeit ist inzwischen belegt.';
  }

  /** Trägt eine geprüfte Eintragung über den Link ein, unter der festen ID `id` (auf allen Geräten dieselbe). */
  enterBooking(scope: PlanningScope, studentId: string, teacherId: string, slot: FreeSlot, id: string): void {
    const student = this.studentsStore.allStudents().find((s) => s.id === studentId);
    const teacher = this.config().teachers.find((t) => t.id === teacherId);
    if (student && teacher) this.enter(scope, student, teacher, slot, this.choosesTeacher(scope, student), id);
  }

  /** Wählt die Person ihre Lehrkraft noch? */
  private choosesTeacher(scope: PlanningScope, student: Student): boolean {
    return scope.teacherIds.length > 1 && !this.withLessonsIn(scope.periodId).has(student.id);
  }

  // --- Gemeinsam für Tablet und Link ---

  private teachersById(ids: string[]): Teacher[] {
    return ids.map((id) => this.config().teachers.find((t) => t.id === id)).filter((t): t is Teacher => !!t);
  }

  private studentsOf(teacherIds: string[], periodId: string): Student[] {
    const config = this.config();
    return this.studentsStore
      .allStudents()
      .filter((s) => isActiveIn(s, periodId) && teacherIds.includes(teacherOf(s, config, periodId).id))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  /** Einzeltermine je Person in den Kalendern der Lehrkräfte; an Tagen in zwei Zeiträumen nur die dieses */
  private lessonsIn(scope: PlanningScope): Map<string, Occurrence[]> {
    const inCalendars = this.inCalendars(this.teachersById(scope.teacherIds));
    const inScope = (a: Appointment) =>
      !!a.studentId && inCalendars(a) && this.groupsStore.appointmentPeriodId(a) === scope.periodId;
    return groupBy(this.calendar.occurrences(scope.from, scope.to, inScope), (o) => o.appointment.studentId!);
  }

  /** Personen mit mindestens einem Einzeltermin im Berichtszeitraum, bei welchem Lehrer auch immer */
  private withLessonsIn(periodId: string | undefined): Set<string> {
    const period = this.config().reportPeriods.find((p) => p.id === periodId);
    if (!period) return new Set<string>();
    return new Set(this.calendar.occurrences(period.from, period.to, (a) => !!a.studentId).map((o) => o.appointment.studentId!));
  }

  /** Steht der Termin im Kalender einer dieser Lehrkräfte? */
  private inCalendars(teachers: Teacher[]): (appointment: Appointment) => boolean {
    const filters = teachers.map((teacher) => this.groupsStore.calendarFilter(teacher));
    return (appointment) => filters.some((inCalendar) => inCalendar(appointment));
  }

  /**
   * Freie Slots wie `CalendarStore.freeSlotsInPeriod`, aber in einem Durchgang über alle Tage (der Zeitraum ist hier
   * oft ein halbes Jahr lang); `fromNow`: erst ab jetzt, sonst ab Beginn des heutigen Tages.
   */
  private freeSlotsOf(teacher: Teacher, from: string, to: string, periodId: string, fromNow = true): FreeSlot[] {
    const config = this.config();
    const duration = config.calendar.defaultDurationMinutes;
    const inCalendar = this.groupsStore.calendarFilter(teacher);
    const byDay = groupBy(this.calendar.occurrences(from, to, inCalendar), (o) => o.date);
    const shared = groupBy(
      this.calendar.sharedOccurrences(from, to, teacher.id).filter((o) => o.appointment.blocksPlanning),
      (o) => o.date,
    );
    const blockers = this.calendar.blockersOf(teacher.id, from, to);
    const slots: FreeSlot[] = [];
    for (const date of daysBetween(from, to)) {
      for (const window of teachingWindowsOn(teacher, config, date, periodId)) {
        for (let start = minutesOf(window.from); start + duration <= minutesOf(window.to); start += duration) {
          if (fromNow ? !isUpcoming(date, timeOf(start)) : date < today()) continue;
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
export function isOwnOneOff(appointment: Appointment): boolean {
  return !appointment.repeat && !appointment.lessonId;
}

/** Passt die freie Zeit zur Person: kein eigener Termin an dem Tag, kein anderer Einzelunterricht zur selben Zeit? */
function fits(slot: FreeSlot, ownDays: Set<string>, individual: Occurrence[]): boolean {
  return !ownDays.has(slot.date) && !individual.some((occurrence) => overlaps(occurrence, slot));
}

/** Name der Gruppe, deren Unterricht sich mit der Zeit überschneidet */
function clashOf(slot: FreeSlot, groups: Occurrence[], names: Map<string, string>): string | undefined {
  const clash = groups.find((occurrence) => overlaps(occurrence, slot));
  return clash ? (names.get(clash.appointment.groupId!) ?? 'Gruppe') : undefined;
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

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
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
