import { effect, inject, Injectable, untracked } from '@angular/core';
import { Appointment, Occurrence, startMinutes } from '../calendar/appointments';
import { CalendarStore } from '../calendar/calendar.store';
import { Clock } from '../calendar/clock';
import { lessonOf } from '../calendar/lesson-start';
import { ConfigStore } from '../config.store';
import { GroupsStore } from '../groups.store';
import { autoLessonId, Group, isActiveIn, Lesson, ReportPeriodEntry, Student, today } from '../model';
import { StudentsStore } from '../students.store';

/**
 * Geplanter Unterricht beginnt von selbst: Zu jedem Einzel- und Gruppentermin legt die App zu seiner Startzeit die
 * Stunde an, auch rückwirkend für alle vergangenen Termine eines Berichtszeitraums. Wer nur plant und nichts
 * einträgt, hat damit trotzdem alle gehaltenen Stunden – etwa für die Auswertung je Lehrkraft.
 *
 * Jede automatische Stunde hat eine feste ID aus Termin und Tag; legen mehrere Geräte sie an, ist es dieselbe. Löscht
 * man sie (z. B. weil die Stunde ausgefallen ist), merkt sich die Person bzw. Gruppe das, und sie entsteht nicht neu.
 * Gibt es schon eine Stunde zum Termin (von Hand angelegt oder geöffnet), entsteht keine zweite. Bei einer
 * deaktivierten Lehrkraft entstehen ab ihrem letzten Tag keine mehr.
 */
@Injectable({ providedIn: 'root' })
export class AutoLessons {
  private readonly calendar = inject(CalendarStore);
  private readonly groupsStore = inject(GroupsStore);
  private readonly studentsStore = inject(StudentsStore);
  private readonly config = inject(ConfigStore).config;
  private readonly clock = inject(Clock);

  constructor() {
    effect(() => {
      // Abhängigkeiten: die Uhr (alle 30 Sekunden) und alles, was Termine und Stunden ändert
      this.clock.now();
      this.calendar.appointments();
      this.studentsStore.allStudents();
      this.groupsStore.allGroups();
      this.config();
      untracked(() => this.run());
    });
  }

  private run(): void {
    const now = this.clock.now();
    const day = today();
    const minutes = now.getHours() * 60 + now.getMinutes();
    const students = new Map(this.studentsStore.allStudents().map((s) => [s.id, s]));
    const groups = new Map(this.groupsStore.allGroups().map((g) => [g.id, g]));
    const forStudents = new Map<string, Lesson[]>();
    const forGroups = new Map<string, Lesson[]>();
    for (const period of this.config().reportPeriods.filter((p) => !p.placeholder && p.from <= day)) {
      for (const occurrence of this.dueOccurrences(period, day, minutes)) {
        const { appointment, date } = occurrence;
        const owner = appointment.groupId ? groups.get(appointment.groupId) : students.get(appointment.studentId!);
        if (!owner || !this.needsLesson(owner, occurrence, period)) continue;
        const lesson = this.lessonFor(occurrence, period);
        const target = appointment.groupId ? forGroups : forStudents;
        target.set(owner.id, [...(target.get(owner.id) ?? []), lesson]);
      }
    }
    if (forStudents.size > 0) this.studentsStore.addLessons(forStudents);
    if (forGroups.size > 0) this.groupsStore.addLessons(forGroups);
  }

  /** Einzel- und Gruppentermine des Zeitraums bis jetzt, die nicht selbst aus einer Stunde entstanden sind */
  private dueOccurrences(period: ReportPeriodEntry, day: string, minutes: number): Occurrence[] {
    const to = period.to < day ? period.to : day;
    const inPeriod = (a: Appointment) =>
      (!!a.studentId || !!a.groupId) && !a.lessonId && this.groupsStore.appointmentPeriodId(a) === period.id;
    return this.calendar
      .occurrences(period.from, to, inPeriod)
      .filter(({ date, appointment }) => date < day || startMinutes(appointment) <= minutes);
  }

  private needsLesson(owner: Student | Group, { appointment, date }: Occurrence, period: ReportPeriodEntry): boolean {
    if ('periods' in owner && !isActiveIn(owner, period.id)) return false;
    const id = autoLessonId(appointment.id, date);
    if (owner.lessons.some((l) => l.id === id) || owner.skippedLessons?.includes(id)) return false;
    if (lessonOf(owner, date, appointment)) return false;
    const inactiveSince = this.groupsStore.calendarTeacherOf(appointment).inactiveSince;
    return !inactiveSince || date < inactiveSince;
  }

  private lessonFor({ appointment, date }: Occurrence, period: ReportPeriodEntry): Lesson {
    return {
      id: autoLessonId(appointment.id, date),
      date,
      start: appointment.start,
      durationMinutes: appointment.durationMinutes,
      periodId: period.id,
      teacherId: this.groupsStore.calendarTeacherOf(appointment).id,
      checked: {},
      texts: {},
    };
  }
}
