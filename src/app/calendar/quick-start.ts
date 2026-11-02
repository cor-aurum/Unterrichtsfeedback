import { Component, computed, inject } from '@angular/core';
import { ActiveTeacher } from '../active-teacher';
import { lessonAt, today } from '../model';
import { StudentsStore } from '../students.store';
import { Appointment, endTime, startMinutes } from './appointments';
import { CalendarStore } from './calendar.store';
import { Clock } from './clock';

/** Ab so vielen Minuten vor Beginn gilt ein Termin als „jetzt“. */
const LEAD_MINUTES = 10;

/**
 * Schnellauswahl über den heutigen Terminen: Ein Klick legt für die Person die Stunde von heute an
 * (oder öffnet sie, falls es sie schon gibt). Beendete Termine verschwinden.
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
  protected readonly students = inject(StudentsStore);

  /** Nur Termine der Personen des aktiven Lehrers. */
  protected readonly entries = computed(() => {
    const now = this.clock.now();
    const date = today();
    const minutes = now.getHours() * 60 + now.getMinutes();
    const ownStudents = this.students.students().filter((s) => this.activeTeacher.teaches(s));
    const students = new Map(ownStudents.map((s) => [s.id, s]));
    return this.calendar.occurrences(date, date, new Set(students.keys())).flatMap(({ appointment }) => {
      const student = students.get(appointment.studentId);
      const start = startMinutes(appointment);
      const end = start + appointment.durationMinutes;
      if (!student || end <= minutes) return [];
      return [{
        appointment,
        student,
        time: `${appointment.start}–${endTime(appointment)}`,
        current: minutes >= start - LEAD_MINUTES,
        hasLesson: !!lessonAt(student, date, appointment.start),
      }];
    });
  });

  protected open(appointment: Appointment): void {
    this.students.openLesson(appointment.studentId, today(), {
      start: appointment.start,
      durationMinutes: appointment.durationMinutes,
    });
  }
}
