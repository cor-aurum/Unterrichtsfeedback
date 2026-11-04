import { inject, Injectable } from '@angular/core';
import { GroupsStore } from '../groups.store';
import { Lesson } from '../model';
import { StudentsStore } from '../students.store';
import { Appointment } from './appointments';
import { lessonOf } from './lesson-start';

/**
 * Öffnet zu einem Termin an einem Tag die passende Stunde (Person oder Gruppe) – auch wenn ihr Beginn leicht
 * verschoben wurde – oder legt sie mit Beginn und Dauer des Termins an. Genutzt von Kalender und „Heute geplant“.
 */
@Injectable({ providedIn: 'root' })
export class LessonOpener {
  private readonly students = inject(StudentsStore);
  private readonly groups = inject(GroupsStore);

  lessonFor(appointment: Appointment, date: string): Lesson | undefined {
    const owner = appointment.groupId
      ? this.groups.groups().find((g) => g.id === appointment.groupId)
      : this.students.students().find((s) => s.id === appointment.studentId);
    return owner && lessonOf(owner, date, appointment);
  }

  /** `false`, wenn die Stunde nicht angelegt werden darf (außerhalb des gewählten Berichtszeitraums) */
  open(appointment: Appointment, date: string): boolean {
    const lesson = this.lessonFor(appointment, date);
    const time = { start: appointment.start, durationMinutes: appointment.durationMinutes };
    if (appointment.groupId) {
      if (!lesson) return this.groups.openLesson(appointment.groupId, date, time);
      this.groups.select(appointment.groupId);
      this.groups.selectedLessonId.set(lesson.id);
    } else if (appointment.studentId) {
      if (!lesson) return this.students.openLesson(appointment.studentId, date, time);
      this.students.selectStudent(appointment.studentId);
      this.students.selectedLessonId.set(lesson.id);
    }
    return true;
  }
}
