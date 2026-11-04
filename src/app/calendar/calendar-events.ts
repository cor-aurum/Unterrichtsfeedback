import { inject, Injectable } from '@angular/core';
import { ConfigStore } from '../config.store';
import { GroupsStore } from '../groups.store';
import { Teacher } from '../model';
import { minutesOf, startMinutes, timeOf } from './appointments';
import { CalendarStore } from './calendar.store';
import { CalendarEvent } from './ical';

export interface CalendarEventOptions {
  /** Bei mehreren Lehrern in einem Kalender steht der Lehrer im Titel, damit man die Termine auseinanderhält. */
  withTeacher: boolean;
  blockers: boolean;
}

/**
 * Termine eines Lehrers als Einträge für den Systemkalender: Einzel- und Gruppenunterricht, allgemeine Termine und
 * auf Wunsch Blocker. Wöchentliche Termine stehen einzeln da; jeder Eintrag behält dieselbe UID, damit ein erneuter
 * Import oder das Abo ihn aktualisiert statt ihn zu verdoppeln.
 */
@Injectable({ providedIn: 'root' })
export class CalendarEvents {
  private readonly calendar = inject(CalendarStore);
  private readonly groupsStore = inject(GroupsStore);
  private readonly config = inject(ConfigStore).config;

  of(teacher: Teacher, from: string, to: string, options: CalendarEventOptions): CalendarEvent[] {
    const lessons = this.lessons(teacher, from, to, options);
    const shared = this.shared(teacher, from, to);
    return options.blockers ? [...lessons, ...shared, ...this.blockers(teacher, from, to, options)] : [...lessons, ...shared];
  }

  private lessons(teacher: Teacher, from: string, to: string, { withTeacher }: CalendarEventOptions): CalendarEvent[] {
    const names = this.groupsStore.ownerNames();
    const suffix = withTeacher ? ` (${teacher.name})` : '';
    return this.calendar
      .occurrences(from, to, this.groupsStore.calendarFilter(teacher))
      .map(({ date, appointment }) => ({
        uid: `${appointment.id}-${date}@unterrichtsfeedback`,
        start: `${date}T${appointment.start}`,
        end: endOf(date, startMinutes(appointment) + appointment.durationMinutes),
        summary: (names.get(appointment.studentId ?? appointment.groupId ?? '') ?? 'Unterricht') + suffix,
        location: teacher.location.trim() || undefined,
        description: `Unterricht bei ${teacher.name}`,
      }));
  }

  private shared(teacher: Teacher, from: string, to: string): CalendarEvent[] {
    return this.calendar.sharedOccurrences(from, to, teacher.id).map(({ date, appointment }) => ({
      // Dieselbe UID bei allen Lehrern: Wer mehrere Lehrer in einen Kalender übernimmt, hat den Termin nur einmal.
      uid: `${appointment.id}-${date}@unterrichtsfeedback`,
      start: `${date}T${appointment.start}`,
      end: endOf(date, minutesOf(appointment.start) + appointment.durationMinutes),
      summary: appointment.title,
      location: appointment.location || undefined,
    }));
  }

  private blockers(teacher: Teacher, from: string, to: string, { withTeacher }: CalendarEventOptions): CalendarEvent[] {
    const blockedLabel = this.config().calendarPdf.blocked;
    const suffix = withTeacher ? ` (${teacher.name})` : '';
    return this.calendar.blockersOf(teacher.id, from, to).map((blocker) => ({
      uid: `${blocker.id}@unterrichtsfeedback`,
      start: blocker.from,
      end: blocker.to,
      summary: (blocker.title ? `${blockedLabel}: ${blocker.title}` : blockedLabel) + suffix,
    }));
  }
}

/** Ende eines Termins; über Mitternacht hinaus endet er um 24:00. */
function endOf(date: string, endMinutes: number): string {
  return endMinutes >= 24 * 60 ? `${date}T24:00` : `${date}T${timeOf(endMinutes)}`;
}
