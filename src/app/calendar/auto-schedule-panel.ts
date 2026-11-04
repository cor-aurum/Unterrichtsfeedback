import { Component, computed, inject, output, signal } from '@angular/core';
import { StudentLabelPipe } from '../student-label.pipe';
import { ActiveTeacher } from '../active-teacher';
import { ConfigStore } from '../config.store';
import { GroupsStore } from '../groups.store';
import {
  containsDate,
  formatDate,
  Group,
  groupLabel,
  groupTeacherOf,
  Period,
  reportPeriodEnd,
  Student,
  teachingWindowsOn,
  today,
} from '../model';
import { ReportPeriod } from '../report-period';
import { storedSignal } from '../stored-signal';
import { StudentsStore } from '../students.store';
import {
  addDays,
  daysBetween,
  daysFrom,
  endTime,
  FreeSlot,
  isRunningSeries,
  minutesOf,
  mondayOf,
  Occurrence,
  occursOn,
  ownerOf,
  WEEKDAY_NAMES,
  weekday,
} from './appointments';
import { fillSlots, GroupPlacement, planSchedule } from './auto-schedule';
import { CalendarStore } from './calendar.store';

/** Längster Zeitraum für einmalige Termine; länger wird die Berechnung spürbar langsam. */
const MAX_PERIOD_DAYS = 31;

/** `weekly`: je Person ein wöchentlicher Termin; `period`: alle freien Slots im Zeitraum mit einmaligen Terminen füllen */
type Mode = 'weekly' | 'period';

interface Proposal {
  student: Student;
  slot: FreeSlot;
  /** Gruppen bei anderen Lehrern, deren Termine sich mit dem Slot überschneiden */
  clashes: string[];
  /** Die Person hat an diesem Tag noch einen Termin. */
  secondOnDay: boolean;
}

/**
 * Plant Personen des aktiven Lehrers automatisch ein: wöchentlich ab einem Datum (Personen ohne wöchentlichen
 * Termin) oder einmalig in einem Zeitraum, der vollständig gefüllt wird (alle Personen). Zeigt erst einen
 * Vorschlag; eingetragen wird erst auf Knopfdruck.
 */
@Component({
  selector: 'app-auto-schedule-panel',
  imports: [StudentLabelPipe],
  templateUrl: './auto-schedule-panel.html',
  styleUrl: './auto-schedule-panel.scss',
})
export class AutoSchedulePanel {
  readonly closed = output<string>();

  private readonly calendar = inject(CalendarStore);
  private readonly config = inject(ConfigStore).config;
  private readonly studentsStore = inject(StudentsStore);
  private readonly groupsStore = inject(GroupsStore);
  protected readonly teacher = inject(ActiveTeacher).teacher;
  protected readonly formatDate = formatDate;
  protected readonly appointmentCount = appointmentCount;
  protected readonly maxPeriodDays = MAX_PERIOD_DAYS;

  /** Modus und Gruppenoption gelten nur auf diesem Gerät. */
  protected readonly mode = storedSignal<Mode>('feedback.autoScheduleMode', () => 'weekly', (data) =>
    data === 'period' ? 'period' : 'weekly',
  );
  /** Im Zeitraum höchstens einen Termin je Person; übrige Slots bleiben frei. Gilt nur auf diesem Gerät. */
  protected readonly onePerPerson = storedSignal<boolean>('feedback.autoScheduleOnce', () => false, (data) => data === true);
  protected readonly placement = storedSignal<GroupPlacement>('feedback.autoSchedulePlacement', () => 'close', (data) =>
    data === 'mixed' ? 'mixed' : 'close',
  );
  private readonly reportPeriod = inject(ReportPeriod);
  /**
   * Beginn: der nächste Montag, wenn er im Berichtszeitraum liegt, sonst der erste Tag des Zeitraums. Der Zeitraum
   * einmaliger Termine ist anfangs fünf Tage lang, höchstens bis zum Ende des Berichtszeitraums.
   */
  protected readonly from = signal(startInPeriod(this.reportPeriod.period()));
  protected readonly to = signal(endInPeriod(this.from(), this.reportPeriod.period()));
  protected readonly periodError = computed(() => {
    if (this.mode() !== 'period') return null;
    if (this.from() > this.to()) return 'Der Zeitraum endet, bevor er beginnt.';
    if (daysBetween(this.from(), this.to()).length > MAX_PERIOD_DAYS) {
      return `Der Zeitraum darf höchstens ${MAX_PERIOD_DAYS} Tage lang sein.`;
    }
    return null;
  });

  private readonly ownerIds = computed(() => this.groupsStore.calendarOwnerIds(this.teacher()));

  /** Wöchentlich: Personen des Lehrers ohne eigene laufende Terminserie; im Zeitraum: alle seine Personen */
  protected readonly candidates = computed(() => {
    const own = this.studentsStore.sortedStudents().filter((s) => this.ownerIds().has(s.id));
    if (this.mode() === 'period') return own;
    const running = new Set(
      this.calendar
        .appointments()
        .filter((a) => a.studentId && isRunningSeries(a, this.from()))
        .map(ownerOf),
    );
    return own.filter((s) => !running.has(s.id));
  });
  private readonly excluded = signal(new Set<string>());
  protected readonly selected = computed(() => this.candidates().filter((s) => !this.excluded().has(s.id)));

  protected readonly freeSlots = computed(() => {
    const settings = this.config().calendar;
    const inCalendar = this.groupsStore.calendarFilter(this.teacher());
    if (this.mode() === 'weekly') return this.calendar.freeWeeklySlots(settings, this.teacher(), inCalendar, this.from());
    if (this.periodError()) return [];
    return this.calendar.freeSlotsInPeriod(settings, this.teacher(), inCalendar, this.from(), this.to());
  });

  /** Warum es keine freien Slots gibt, damit „0 freie Slots“ nicht rätselhaft bleibt */
  protected readonly noSlotsReason = computed(() => {
    if (this.periodError() || this.freeSlots().length > 0) return null;
    const days = this.mode() === 'weekly' ? daysBetween(this.from(), addDays(this.from(), 6)) : daysBetween(this.from(), this.to());
    const config = this.config();
    if (days.every((date) => teachingWindowsOn(this.teacher(), config, date).length === 0)) {
      return `${this.teacher().name} hat an diesen Tagen keine Unterrichtszeiten (Konfiguration → Lehrer, je Berichtszeitraum).`;
    }
    return 'Alle Unterrichtszeiten an diesen Tagen sind schon belegt oder blockiert.';
  });

  protected readonly proposals = signal<Proposal[] | null>(null);
  protected readonly unassigned = signal<Student[]>([]);
  /** Slots im Zeitraum, die niemand bekommen konnte (alle hatten dort schon Einzelunterricht) */
  protected readonly emptySlots = signal<FreeSlot[]>([]);
  /** Termine je Person im Vorschlag (nur im Zeitraum, dort kann jemand mehrere bekommen) */
  protected readonly perStudent = computed(() => {
    const counts = new Map<string, { student: Student; count: number }>();
    for (const { student } of this.proposals() ?? []) {
      counts.set(student.id, { student, count: (counts.get(student.id)?.count ?? 0) + 1 });
    }
    return [...counts.values()].sort((a, b) => a.student.name.localeCompare(b.student.name, 'de'));
  });

  protected isSelected(student: Student): boolean {
    return !this.excluded().has(student.id);
  }

  protected toggle(student: Student): void {
    this.excluded.update((set) => {
      const next = new Set(set);
      if (!next.delete(student.id)) next.add(student.id);
      return next;
    });
    this.proposals.set(null);
  }

  protected setMode(mode: Mode): void {
    this.mode.set(mode);
    this.proposals.set(null);
  }

  /** Ein neuer Beginn verschiebt das Ende mit, damit der Zeitraum gleich lang bleibt. */
  protected setDate(key: 'from' | 'to', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    if (!value) return;
    if (key === 'from') this.to.set(addDays(value, daysFrom(this.from(), this.to())));
    this[key].set(value);
    this.proposals.set(null);
  }

  protected setOnePerPerson(event: Event): void {
    this.onePerPerson.set((event.target as HTMLInputElement).checked);
    this.proposals.set(null);
  }

  protected setPlacement(placement: GroupPlacement): void {
    this.placement.set(placement);
    this.proposals.set(null);
  }

  protected calculate(): void {
    const students = this.selected();
    const slots = this.freeSlots();
    const busy = new Map(students.map((s) => [s.id, this.otherGroupLessons(s)]));
    // Einzelunterricht bei einem anderen Lehrer schließt den Slot aus.
    const individual = new Map(students.map((s) => [s.id, this.otherIndividualLessons(s)]));
    const allowed = (id: string, slot: FreeSlot) => clashing(individual.get(id)!, slot).length === 0;
    const studentIds = students.map((s) => s.id);
    const groups = this.groupsStore.groups().map((g) => g.memberIds.filter((id) => busy.has(id)));
    const conflicts = (id: string, slot: FreeSlot) => clashing(busy.get(id)!, slot).length;
    const byId = new Map(students.map((s) => [s.id, s]));
    const allStudents = this.studentsStore.students();
    const proposal = (studentId: string, slot: FreeSlot, secondOnDay: boolean): Proposal => ({
      student: byId.get(studentId)!,
      slot,
      clashes: [...new Set(clashing(busy.get(studentId)!, slot).map(({ group }) => groupLabel(group, allStudents)))],
      secondOnDay,
    });

    this.emptySlots.set([]);
    if (this.mode() === 'weekly') {
      const result = planSchedule({ slots, studentIds, groups, conflicts, allowed, placement: this.placement() });
      this.proposals.set(result.assignments.map(({ studentId, slot }) => proposal(studentId, slot, false)));
      this.unassigned.set(result.unassigned.map((id) => byId.get(id)!));
    } else if (this.onePerPerson()) {
      // Wie beim wöchentlichen Verteilen höchstens ein Slot je Person. Überschneidungen mit Gruppenunterricht
      // wiegen schwerer als ein Tag, an dem die Person schon einen Termin hat.
      const existing = this.appointmentsPerDay(studentIds);
      const onDay = (id: string, slot: FreeSlot) => existing.get(`${id} ${slot.date}`) ?? 0;
      const result = planSchedule({
        slots,
        studentIds,
        groups,
        conflicts: (id, slot) => conflicts(id, slot) * 10 + (onDay(id, slot) > 0 ? 1 : 0),
        allowed,
        placement: this.placement(),
      });
      this.proposals.set(result.assignments.map(({ studentId, slot }) => proposal(studentId, slot, onDay(studentId, slot) > 0)));
      this.unassigned.set(result.unassigned.map((id) => byId.get(id)!));
    } else {
      const existing = this.appointmentsPerDay(studentIds);
      const result = fillSlots({
        slots,
        studentIds,
        groups,
        conflicts,
        existingOnDay: (id, date) => existing.get(`${id} ${date}`) ?? 0,
        allowed,
        placement: this.placement(),
      });
      this.proposals.set(result.assignments.map(({ studentId, slot, secondOnDay }) => proposal(studentId, slot, secondOnDay)));
      this.unassigned.set([]);
      this.emptySlots.set(result.empty);
    }
  }

  protected slotLabel(slot: FreeSlot): string {
    const time = `${slot.start}–${endTime({ ...slot, id: '' })}`;
    return slot.repeat ? `${WEEKDAY_NAMES[weekday(slot.date)]}, ${time}` : `${formatDate(slot.date)}, ${time}`;
  }

  protected apply(): void {
    const proposals = this.proposals() ?? [];
    for (const { student, slot } of proposals) {
      this.calendar.add({ ...slot, studentId: student.id });
    }
    this.closed.emit(`${appointmentCount(proposals.length, this.mode() === 'weekly')} eingetragen.`);
  }

  /**
   * Gruppentermine der Person bei anderen Lehrern im geprüften Zeitraum. Termine von Gruppen dieses Lehrers
   * belegen ohnehin schon seine Slots.
   */
  private otherGroupLessons(student: Student): { occurrence: Occurrence; group: Group }[] {
    const config = this.config();
    const groups = this.groupsStore
      .groups()
      .filter((g) => g.memberIds.includes(student.id) && groupTeacherOf(g, config).id !== this.teacher().id);
    if (groups.length === 0) return [];
    const byId = new Map(groups.map((g) => [g.id, g]));
    const from = this.from();
    return this.calendar
      .occurrences(from, this.checkedUntil(), new Set(byId.keys()))
      .map((occurrence) => ({ occurrence, group: byId.get(occurrence.appointment.groupId!)! }));
  }

  /** Einzeltermine der Person, die nicht in diesem Kalender stehen (z. B. als Ausnahme bei einem anderen Lehrer) */
  private otherIndividualLessons(student: Student): { occurrence: Occurrence }[] {
    const inCalendar = this.groupsStore.calendarFilter(this.teacher());
    return this.calendar
      .occurrences(this.from(), this.checkedUntil(), (a) => a.studentId === student.id && !inCalendar(a))
      .map((occurrence) => ({ occurrence }));
  }

  /** Wöchentliche Serien laufen bis zum Ende des Berichtszeitraums; so weit wird auf Überschneidungen geprüft. */
  private checkedUntil(): string {
    return this.mode() === 'weekly' ? reportPeriodEnd(this.config().reportPeriods, addDays(this.from(), 6)) : this.to();
  }

  /** Vorhandene Termine je Person und Tag im Zeitraum, eigene und die ihrer Gruppen; Schlüssel „ID Datum“ */
  private appointmentsPerDay(studentIds: string[]): Map<string, number> {
    const counts = new Map<string, number>();
    const groups = this.groupsStore.groups();
    for (const occurrence of this.calendar.occurrences(this.from(), this.to())) {
      const owner = ownerOf(occurrence.appointment);
      const members = occurrence.appointment.groupId
        ? (groups.find((g) => g.id === owner)?.memberIds ?? [])
        : [owner];
      for (const id of members.filter((m) => studentIds.includes(m))) {
        const key = `${id} ${occurrence.date}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return counts;
  }
}

/** Der nächste Montag, wenn er im Berichtszeitraum liegt, sonst der erste Tag des Zeitraums */
function startInPeriod(period: Period): string {
  const nextMonday = addDays(mondayOf(today()), 7);
  return containsDate(period, nextMonday) ? nextMonday : period.from;
}

/** Fünf Tage ab dem Beginn, höchstens bis zum Ende des Berichtszeitraums (sofern der Beginn noch darin liegt) */
function endInPeriod(from: string, period: Period): string {
  const end = addDays(from, 4);
  return containsDate(period, from) && period.to < end ? period.to : end;
}

/** z. B. „1 wöchentlicher Termin“, „3 einmalige Termine“ */
export function appointmentCount(count: number, weekly = true): string {
  const [one, many] = weekly ? ['wöchentlicher Termin', 'wöchentliche Termine'] : ['einmaliger Termin', 'einmalige Termine'];
  return `${count} ${count === 1 ? one : many}`;
}

/** Gruppentermine, die den Slot überschneiden: bei Serien an jedem ihrer Tage, sonst nur an diesem Tag. */
function clashing<T extends { occurrence: Occurrence }>(busy: T[], slot: FreeSlot): T[] {
  const start = minutesOf(slot.start);
  const end = start + slot.durationMinutes;
  return busy.filter(({ occurrence: { date, appointment } }) => {
    if (!occursOn(slot, date)) return false;
    const otherStart = minutesOf(appointment.start);
    return start < otherStart + appointment.durationMinutes && otherStart < end;
  });
}
