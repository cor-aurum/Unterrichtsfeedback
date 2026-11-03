import { Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { ActiveTeacher } from '../active-teacher';
import { ConfigStore } from '../config.store';
import { GroupsStore } from '../groups.store';
import { Teacher, today } from '../model';
import { ReportPeriod } from '../report-period';
import { isNativeApp, openFile, safeFileName, saveFile } from '../save-file';
import { storedSignal } from '../stored-signal';
import { addDays, daysBetween, minutesOf, mondayOf, startMinutes, timeOf } from './appointments';
import { CalendarStore } from './calendar.store';
import { CalendarEvent, toICalendar } from './ical';

/** Längster Zeitraum, damit wöchentliche Termine nicht zu Tausenden Einträgen werden */
const MAX_DAYS = 2 * 366;
const ALL_TEACHERS = 'all';

/**
 * Termine als iCalendar-Datei für den Systemkalender. Wöchentliche Termine werden im Zeitraum einzeln
 * eingetragen; jeder Eintrag behält bei jedem Export dieselbe UID, damit ein erneuter Import ihn aktualisiert.
 */
@Component({
  selector: 'app-ical-export-panel',
  templateUrl: './ical-export-panel.html',
  styleUrl: './ical-export-panel.scss',
})
export class IcalExportPanel {
  private readonly calendar = inject(CalendarStore);
  private readonly groupsStore = inject(GroupsStore);
  private readonly config = inject(ConfigStore).config;
  private readonly activeTeacher = inject(ActiveTeacher);
  private readonly reportPeriod = inject(ReportPeriod);
  protected readonly nativeApp = isNativeApp;
  protected readonly allTeachers = ALL_TEACHERS;

  protected readonly teachers = computed(() => this.config().teachers);
  // Über ein `computed`: Der Lehrer ist nach jeder Änderung der Konfiguration ein neues Objekt, die ID bleibt.
  private readonly activeTeacherId = computed(() => this.activeTeacher.teacher().id);
  protected readonly teacherId = linkedSignal(() => this.activeTeacherId());
  protected readonly from = signal(mondayOf(today()));
  /** Bis zum Ende des Berichtszeitraums, mindestens aber vier Wochen */
  protected readonly to = signal(maxDate(this.reportPeriod.period().to, addDays(mondayOf(today()), 27)));
  /** Gilt nur auf diesem Gerät. */
  protected readonly includeBlockers = storedSignal<boolean>('feedback.icalBlockers', () => true, (data) => data !== false);
  protected readonly message = signal<string | null>(null);

  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected async export(action: 'open' | 'share'): Promise<void> {
    const [from, to] = [this.from(), this.to()];
    if (!from || !to || from > to) {
      this.message.set('Bitte einen gültigen Zeitraum wählen („von“ vor „bis“).');
      return;
    }
    if (daysBetween(from, to).length > MAX_DAYS) {
      this.message.set('Der Zeitraum darf höchstens zwei Jahre lang sein.');
      return;
    }
    this.message.set(null);
    const teachers = this.selectedTeachers();
    const events = teachers.flatMap((teacher) => this.eventsOf(teacher, from, to, teachers.length > 1));
    const name = teachers.length === 1 ? `Unterricht ${teachers[0].name}` : 'Unterricht';
    const file = new Blob([toICalendar(name, events)], { type: 'text/calendar' });
    const fileName = `${safeFileName(name)}_${from}_${to}.ics`;
    await (action === 'open' ? openFile(fileName, file) : saveFile(fileName, file));
  }

  private selectedTeachers(): Teacher[] {
    const id = this.teacherId();
    return id === ALL_TEACHERS ? this.teachers() : this.teachers().filter((t) => t.id === id);
  }

  /** Bei mehreren Lehrern steht der Lehrer im Titel, damit man die Termine im Kalender auseinanderhält. */
  private eventsOf(teacher: Teacher, from: string, to: string, withTeacher: boolean): CalendarEvent[] {
    const names = this.groupsStore.ownerNames();
    const suffix = withTeacher ? ` (${teacher.name})` : '';
    const lessons = this.calendar
      .occurrences(from, to, this.groupsStore.calendarFilter(teacher))
      .map(({ date, appointment }) => ({
        uid: `${appointment.id}-${date}@unterrichtsfeedback`,
        start: `${date}T${appointment.start}`,
        end: endOf(date, startMinutes(appointment) + appointment.durationMinutes),
        summary: (names.get(appointment.studentId ?? appointment.groupId ?? '') ?? 'Unterricht') + suffix,
        location: teacher.location.trim() || undefined,
        description: `Unterricht bei ${teacher.name}`,
      }));
    const shared = this.calendar.sharedOccurrences(from, to, teacher.id).map(({ date, appointment }) => ({
      // Dieselbe UID bei allen Lehrern: Wer mehrere Lehrer in einen Kalender übernimmt, hat den Termin nur einmal.
      uid: `${appointment.id}-${date}@unterrichtsfeedback`,
      start: `${date}T${appointment.start}`,
      end: endOf(date, minutesOf(appointment.start) + appointment.durationMinutes),
      summary: appointment.title,
      location: appointment.location || undefined,
    }));
    if (!this.includeBlockers()) return [...lessons, ...shared];
    const blockedLabel = this.config().calendarPdf.blocked;
    const blockers = this.calendar.blockersOf(teacher.id, from, to).map((blocker) => ({
      uid: `${blocker.id}@unterrichtsfeedback`,
      start: blocker.from,
      end: blocker.to,
      summary: (blocker.title ? `${blockedLabel}: ${blocker.title}` : blockedLabel) + suffix,
    }));
    return [...lessons, ...shared, ...blockers];
  }
}

/** Ende eines Termins; über Mitternacht hinaus endet er um 24:00. */
function endOf(date: string, endMinutes: number): string {
  return endMinutes >= 24 * 60 ? `${date}T24:00` : `${date}T${timeOf(endMinutes)}`;
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}
