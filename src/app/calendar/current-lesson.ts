import { computed, inject, Injectable } from '@angular/core';
import { ActiveTeacher } from '../active-teacher';
import { GroupsStore } from '../groups.store';
import { Lesson, today } from '../model';
import { ReportPeriod } from '../report-period';
import { Appointment, endTime, minutesOf, Occurrence, startMinutes, timeOf } from './appointments';
import { CalendarStore } from './calendar.store';
import { Clock } from './clock';
import { LessonOpener } from './lesson-opener';

/** Ab so vielen Minuten vor Beginn bietet „Stunden erfassen“ den Wechsel zur Stunde an. */
const OFFER_MINUTES = 10;
/** So viele Minuten nach dem Ende der vorigen Stunde wechselt „Stunden erfassen“ frühestens von selbst. */
const GRACE_MINUTES = 5;

/** Die Stunde, die laut Kalender der aktiven Lehrkraft gerade dran ist */
export interface DueLesson {
  /** Termin und Tag; danach merkt sich die Seite, ob sie schon gewechselt hat */
  key: string;
  occurrence: Occurrence;
  /** z. B. „Anna Schmidt“ oder „Gruppe Chor“ */
  name: string;
  /** z. B. „10:00–10:45“ */
  time: string;
  /** Uhrzeit, ab der die Seite von selbst wechselt: Beginn, frühestens 5 Minuten nach dem Ende der vorigen Stunde */
  switchAt: string;
}

/**
 * Welche Stunde gerade dran ist: der zuletzt begonnene Einzel- oder Gruppentermin von heute im Kalender der aktiven
 * Lehrkraft, ab 10 Minuten vor Beginn bis zu seinem Ende. Stunden, zu denen die Person nicht erschienen ist, sind
 * nicht dran. „Stunden erfassen“ bietet den Wechsel dorthin an und wechselt ab `switchAt` einmal von selbst.
 */
@Injectable({ providedIn: 'root' })
export class CurrentLesson {
  private readonly calendar = inject(CalendarStore);
  private readonly clock = inject(Clock);
  private readonly activeTeacher = inject(ActiveTeacher);
  private readonly groups = inject(GroupsStore);
  private readonly opener = inject(LessonOpener);
  private readonly reportPeriod = inject(ReportPeriod);
  /** Termine, zu denen die Seite schon gewechselt hat oder die schon offen waren; je Termin nur einmal */
  private readonly followed = new Set<string>();

  readonly due = computed<DueLesson | null>(() => {
    const date = today();
    if (!this.reportPeriod.contains(date)) return null;
    const minutes = this.minutesNow();
    const todays = this.todaysLessons(date);
    const current = todays
      .filter(({ appointment }) => startMinutes(appointment) - OFFER_MINUTES <= minutes && minutes < endMinutes(appointment))
      .at(-1);
    if (!current || this.lessonOf(current)?.absent) return null;
    const { appointment } = current;
    const start = startMinutes(appointment);
    const previousEnds = todays
      .filter((other) => other.appointment.id !== appointment.id && startMinutes(other.appointment) < start)
      .map((other) => this.endOf(other) + GRACE_MINUTES);
    return {
      key: `${appointment.id}-${date}`,
      occurrence: current,
      name: this.groups.ownerNames().get(appointment.groupId ?? appointment.studentId ?? '') ?? '',
      time: `${appointment.start}–${endTime(appointment)}`,
      switchAt: timeOf(Math.max(start, ...previousEnds)),
    };
  });

  /** Wechselt die Seite jetzt von selbst? Nur ab `switchAt` und nur einmal je Termin. */
  shouldFollow(due: DueLesson): boolean {
    return !this.followed.has(due.key) && this.minutesNow() >= minutesOf(due.switchAt);
  }

  /** Gewechselt oder schon offen: Danach wechselt die Seite für diesen Termin nicht mehr von selbst. */
  markFollowed(due: DueLesson): void {
    this.followed.add(due.key);
  }

  /** Öffnet die Stunde (legt sie bei Bedarf an); `false` außerhalb des gewählten Berichtszeitraums */
  open(due: DueLesson): boolean {
    this.markFollowed(due);
    return this.opener.open(due.occurrence.appointment, due.occurrence.date);
  }

  lessonOf({ appointment, date }: Occurrence): Lesson | undefined {
    return this.opener.lessonFor(appointment, date);
  }

  /** Einzel- und Gruppentermine von heute im Kalender der aktiven Lehrkraft, nach Beginn */
  private todaysLessons(date: string): Occurrence[] {
    const inCalendar = this.groups.calendarFilter(this.activeTeacher.teacher());
    return this.calendar
      .occurrences(date, date, (a) => (!!a.studentId || !!a.groupId) && inCalendar(a))
      .sort((a, b) => startMinutes(a.appointment) - startMinutes(b.appointment));
  }

  /**
   * Ende der Stunde, wie sie erfasst ist (Beginn und Länge lassen sich dort ändern), sonst das des Termins. Ist die
   * Person nicht erschienen, endet sie schon mit ihrem Beginn: Dann muss niemand warten.
   */
  private endOf(occurrence: Occurrence): number {
    const lesson = this.lessonOf(occurrence);
    const start = startMinutes(occurrence.appointment);
    if (lesson?.absent) return start - GRACE_MINUTES;
    if (lesson?.start && lesson.durationMinutes) return minutesOf(lesson.start) + lesson.durationMinutes;
    return endMinutes(occurrence.appointment);
  }

  private minutesNow(): number {
    const now = this.clock.now();
    return now.getHours() * 60 + now.getMinutes();
  }
}

function endMinutes(appointment: Appointment): number {
  return startMinutes(appointment) + appointment.durationMinutes;
}
