import { Component, computed, inject } from '@angular/core';
import { ActiveTeacher } from '../active-teacher';
import { GroupsStore } from '../groups.store';
import { groupLabel, today } from '../model';
import { StudentsStore } from '../students.store';
import { Appointment, endTime, startMinutes } from './appointments';
import { appointmentState } from './appointment-state';
import { CalendarStore } from './calendar.store';
import { ReportPeriod } from '../report-period';
import { LessonOpener } from './lesson-opener';
import { Clock } from './clock';

/** Ab so vielen Minuten vor Beginn gilt ein Termin als „jetzt“. */
const LEAD_MINUTES = 10;

/**
 * Schnellauswahl über den heutigen Terminen: Ein Klick legt für die Person (oder die Gruppe) die Stunde von
 * heute an oder öffnet sie, falls es sie schon gibt. Beendete Termine verschwinden.
 */
@Component({
  selector: 'app-quick-start',
  templateUrl: './quick-start.html',
  styleUrl: './quick-start.scss',
})
export class QuickStart {
  private readonly calendar = inject(CalendarStore);
  private readonly clock = inject(Clock);
  private readonly activeTeacher = inject(ActiveTeacher);
  private readonly groups = inject(GroupsStore);
  private readonly opener = inject(LessonOpener);
  private readonly reportPeriod = inject(ReportPeriod);
  protected readonly students = inject(StudentsStore);

  /** Nur Termine im Kalender des aktiven Lehrers. */
  protected readonly entries = computed(() => {
    const now = this.clock.now();
    const date = today();
    const minutes = now.getHours() * 60 + now.getMinutes();
    // Termine anderer Zeiträume gehören zu Personen, die hier nicht aktiv sind.
    if (!this.reportPeriod.contains(date)) return [];
    const inCalendar = this.groups.calendarFilter(this.activeTeacher.teacher());
    return this.calendar.occurrences(date, date, inCalendar).flatMap(({ appointment }) => {
      const start = startMinutes(appointment);
      const owner = this.ownerOf(appointment, date);
      if (!owner || start + appointment.durationMinutes <= minutes) return [];
      return [{
        appointment,
        ...owner,
        time: `${appointment.start}–${endTime(appointment)}`,
        current: minutes >= start - LEAD_MINUTES,
        state: appointmentState(appointment, date, owner.hasLesson, now),
      }];
    });
  });

  protected open(appointment: Appointment): void {
    this.opener.open(appointment, today());
  }

  /** Anzeigename und ob es die Stunde (bei Gruppen: die Gruppenstunde) heute schon gibt */
  private ownerOf(appointment: Appointment, date: string): { name: string; hasLesson: boolean } | null {
    const students = this.students.students();
    if (appointment.groupId) {
      const group = this.groups.groups().find((g) => g.id === appointment.groupId);
      if (!group) return null;
      return { name: `Gruppe ${groupLabel(group, students)}`, hasLesson: !!this.opener.lessonFor(appointment, date) };
    }
    const student = students.find((s) => s.id === appointment.studentId);
    return student ? { name: student.name, hasLesson: !!this.opener.lessonFor(appointment, date) } : null;
  }
}
