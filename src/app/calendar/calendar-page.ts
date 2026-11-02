import { Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ActiveTeacher } from '../active-teacher';
import { ConfigStore } from '../config.store';
import { GroupsStore } from '../groups.store';
import { formatDate, Group, groupLabel, groupMembers, groupTeacherOf, instrumentOf, lessonAt, Student, Teacher, teacherOf, today } from '../model';
import { PdfExport, ScheduleDay } from '../pdf-export';
import { isNativeApp } from '../save-file';
import { storedSignal } from '../stored-signal';
import { StudentsStore } from '../students.store';
import {
  addDays,
  Appointment,
  daysBetween,
  endTime,
  followsLesson,
  minutesOf,
  mondayOf,
  Occurrence,
  ownerOf,
  startMinutes,
  weekday,
} from './appointments';
import { AutoSchedulePanel } from './auto-schedule-panel';
import { Blocker, blockerOnDay, blockerTimeText } from './blockers';
import { CalendarStore } from './calendar.store';
import { LessonLoadPanel } from './lesson-load-panel';

type Draft = Omit<Appointment, 'id'> & { id: string | null };

/** Formular für einen Blocker; bei ganzen Tagen zählt `toDate` mit (gespeichert wird der Folgetag 00:00). */
interface BlockerDraft {
  id: string | null;
  title: string;
  allDay: boolean;
  fromDate: string;
  fromTime: string;
  toDate: string;
  toTime: string;
}

/** Längster Zeitraum für die PDF-Liste, damit niemand versehentlich Jahrzehnte exportiert. */
const MAX_PDF_DAYS = 366;

@Component({
  selector: 'app-calendar-page',
  imports: [RouterLink, AutoSchedulePanel, LessonLoadPanel],
  templateUrl: './calendar-page.html',
  styleUrl: './calendar-page.scss',
})
export class CalendarPage {
  private readonly calendar = inject(CalendarStore);
  private readonly config = inject(ConfigStore).config;
  private readonly pdf = inject(PdfExport);
  private readonly studentsStore = inject(StudentsStore);
  private readonly groupsStore = inject(GroupsStore);
  private readonly router = inject(Router);
  private readonly activeTeacher = inject(ActiveTeacher);
  protected readonly teacher = this.activeTeacher.teacher;
  /** Der Kalender zeigt nur die Personen des aktiven Lehrers und deren Termine. */
  protected readonly students = computed(() =>
    this.studentsStore.sortedStudents().filter((student) => this.activeTeacher.teaches(student)),
  );
  /** Personen anderer Lehrer; sie lassen sich ausnahmsweise in diesem Kalender einplanen. */
  protected readonly otherStudents = computed(() =>
    this.studentsStore.sortedStudents().filter((student) => !this.activeTeacher.teaches(student)),
  );
  protected readonly anyStudents = computed(() => this.studentsStore.students().length > 0);
  /** Gruppen, deren Termine im Kalender des aktiven Lehrers stehen */
  protected readonly groups = computed(() =>
    this.groupsStore.groups().filter((group) => groupTeacherOf(group, this.config()).id === this.teacher().id),
  );
  private readonly inCalendar = computed(() => this.groupsStore.calendarFilter(this.teacher()));

  protected readonly formatDate = formatDate;
  protected readonly nativeApp = isNativeApp;
  protected readonly endTime = endTime;

  protected readonly today = today();
  protected readonly weekStart = signal(mondayOf(this.today));
  protected readonly week = computed(() => {
    const start = this.weekStart();
    const end = addDays(start, 6);
    const occurrences = this.calendar.occurrences(start, end, this.inCalendar());
    const blockers = this.calendar.blockersOf(this.teacher().id, start, end);
    return daysBetween(start, end).map((date) => ({
      date,
      label: formatDay(date),
      occurrences: occurrences.filter((o) => o.date === date),
      blockers: blockers.flatMap((blocker) => {
        const part = blockerOnDay(blocker, date);
        return part ? [{ blocker, time: blockerTimeText(part) }] : [];
      }),
    }));
  });
  protected readonly weekLabel = computed(() => formatPeriod(this.weekStart(), addDays(this.weekStart(), 6)));

  protected readonly draft = signal<Draft | null>(null);
  protected readonly blockerDraft = signal<BlockerDraft | null>(null);
  /** Angeklickter Termin an einem bestimmten Tag; nur gesetzt, solange ein vorhandener Termin bearbeitet wird. */
  protected readonly openedOccurrence = signal<Occurrence | null>(null);
  protected readonly message = signal<string | null>(null);
  protected readonly autoScheduleOpen = signal(false);
  /** Erfolgsmeldung, z. B. nach dem automatischen Einplanen */
  protected readonly notice = signal<string | null>(null);

  /** Zeitraum der PDF-Liste; folgt der angezeigten Woche, bis man ihn selbst ändert. */
  protected readonly pdfFrom = linkedSignal(() => this.weekStart());
  protected readonly pdfTo = linkedSignal(() => addDays(this.weekStart(), 6));
  /** Liste oder Wochenplan als Tabelle; gilt nur auf diesem Gerät. */
  protected readonly pdfFormat = storedSignal<'list' | 'grid'>('feedback.scheduleFormat', () => 'list', (data) =>
    data === 'grid' ? 'grid' : 'list',
  );

  private readonly studentsById = computed(() => new Map(this.studentsStore.students().map((s) => [s.id, s])));
  private readonly groupsById = computed(() => new Map(this.groups().map((g) => [g.id, g])));

  protected studentOf(appointment: Appointment): Student | undefined {
    return appointment.studentId ? this.studentsById().get(appointment.studentId) : undefined;
  }

  protected groupOf(appointment: Appointment): Group | undefined {
    return appointment.groupId ? this.groupsById().get(appointment.groupId) : undefined;
  }

  protected groupLabel(group: Group): string {
    return groupLabel(group, this.studentsStore.students());
  }

  protected memberCount(group: Group): number {
    return groupMembers(group, this.studentsStore.students()).length;
  }

  protected teacherName(student: Student): string {
    return teacherOf(student, this.config()).name;
  }

  protected instrumentName(student: Student): string {
    return instrumentOf(student, this.config()).name;
  }

  /** Wert der Auswahl „Person oder Gruppe“: `s:<id>` oder `g:<id>` */
  protected ownerValue(draft: Draft): string {
    return draft.groupId ? `g:${draft.groupId}` : `s:${draft.studentId ?? ''}`;
  }

  /** Termin einer erfassten Stunde: Person/Gruppe fest, kein Löschen, Änderungen gehen an die Stunde. */
  protected draftFollowsLesson(draft: Draft): boolean {
    return followsLesson({ ...draft, id: draft.id ?? '' });
  }

  protected setOwner(value: string): void {
    const id = value.slice(2);
    this.draft.update((draft) => {
      if (!draft) return draft;
      const { studentId: _s, groupId: _g, ...rest } = draft;
      return value.startsWith('g:') ? { ...rest, groupId: id } : { ...rest, studentId: id };
    });
  }

  protected openAutoSchedule(): void {
    this.draft.set(null);
    this.notice.set(null);
    this.autoScheduleOpen.set(true);
  }

  protected closeAutoSchedule(result: string): void {
    this.autoScheduleOpen.set(false);
    this.notice.set(result || null);
  }

  protected moveWeek(weeks: number): void {
    this.weekStart.update((start) => addDays(start, weeks * 7));
  }

  protected showToday(): void {
    this.weekStart.set(mondayOf(this.today));
  }

  /**
   * Vorbelegt mit den Kalender-Einstellungen; der Beginn ist der Anfang der ersten Unterrichtszeit des
   * aktiven Lehrers an diesem Tag.
   */
  /** Neuer Blocker, vorbelegt mit dem ganzen Tag */
  protected newBlocker(date = this.today): void {
    this.closeForms();
    this.blockerDraft.set({ id: null, title: '', allDay: true, fromDate: date, fromTime: '14:00', toDate: date, toTime: '18:00' });
  }

  protected editBlocker(blocker: Blocker): void {
    this.closeForms();
    const allDay = blocker.from.endsWith('T00:00') && blocker.to.endsWith('T00:00');
    this.blockerDraft.set({
      id: blocker.id,
      title: blocker.title,
      allDay,
      fromDate: blocker.from.slice(0, 10),
      fromTime: blocker.from.slice(11),
      toDate: allDay ? addDays(blocker.to.slice(0, 10), -1) : blocker.to.slice(0, 10),
      toTime: blocker.to.slice(11),
    });
  }

  protected setBlockerDraft(change: Partial<BlockerDraft>): void {
    this.blockerDraft.update((draft) => (draft ? { ...draft, ...change } : draft));
  }

  protected saveBlocker(): void {
    const draft = this.blockerDraft();
    if (!draft) return;
    const from = `${draft.fromDate}T${draft.allDay ? '00:00' : draft.fromTime}`;
    const to = draft.allDay ? `${addDays(draft.toDate, 1)}T00:00` : `${draft.toDate}T${draft.toTime}`;
    if (!draft.fromDate || !draft.toDate || (!draft.allDay && (!draft.fromTime || !draft.toTime)) || from >= to) {
      this.message.set('Der Blocker muss später enden, als er beginnt.');
      return;
    }
    const blocker = { teacherId: this.teacher().id, title: draft.title.trim(), from, to };
    if (draft.id) {
      this.calendar.updateBlocker(draft.id, blocker);
    } else {
      this.calendar.addBlocker(blocker);
    }
    this.weekStart.set(mondayOf(draft.fromDate));
    this.closeForms();
  }

  protected removeBlocker(): void {
    const draft = this.blockerDraft();
    if (draft?.id && confirm('Blocker löschen?')) {
      this.calendar.removeBlocker(draft.id);
      this.closeForms();
    }
  }

  private closeForms(): void {
    this.message.set(null);
    this.draft.set(null);
    this.openedOccurrence.set(null);
    this.blockerDraft.set(null);
  }

  protected newAppointment(date = this.today): void {
    const settings = this.config().calendar;
    const firstWindow = this.teacher().teachingWindows
      .filter((w) => w.weekday === weekday(date))
      .sort((a, b) => a.from.localeCompare(b.from))[0];
    this.closeForms();
    this.draft.set({
      id: null,
      ...(this.students()[0]
        ? { studentId: this.students()[0].id }
        : this.groups()[0]
          ? { groupId: this.groups()[0].id }
          : { studentId: this.otherStudents()[0]?.id }),
      date,
      start: firstWindow?.from ?? '15:00',
      durationMinutes: settings.defaultDurationMinutes,
      weekly: settings.weeklyByDefault,
    });
  }

  /** Öffnet den Termin zum Bearbeiten; von hier aus lässt sich die Stunde dieses Tages öffnen. */
  protected edit(occurrence: Occurrence): void {
    this.closeForms();
    this.draft.set({ ...occurrence.appointment });
    this.openedOccurrence.set(occurrence);
  }

  /** Gibt es zum Termin an diesem Tag schon eine Stunde (bei Gruppen: eine Gruppenstunde)? */
  protected hasLesson({ date, appointment }: Occurrence): boolean {
    if (appointment.groupId) {
      const group = this.groupOf(appointment);
      return !!group && !!lessonAt(group, date, appointment.start);
    }
    const student = this.studentOf(appointment);
    return !!student && !!lessonAt(student, date, appointment.start);
  }

  /** Legt die Stunde mit Datum und Uhrzeit des Termins an oder öffnet sie und wechselt zur Erfassung. */
  protected openLesson({ date, appointment }: Occurrence): void {
    const time = { start: appointment.start, durationMinutes: appointment.durationMinutes };
    if (appointment.groupId) {
      this.groupsStore.openLesson(appointment.groupId, date, time);
    } else if (appointment.studentId) {
      this.studentsStore.openLesson(appointment.studentId, date, time);
    }
    this.router.navigate(['/stunden']);
  }

  protected setDraft(change: Partial<Draft>): void {
    this.draft.update((draft) => (draft ? { ...draft, ...change } : draft));
  }

  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected numberOf(event: Event): number {
    return Number(this.valueOf(event));
  }

  /**
   * Eine Person kann nicht gleichzeitig bei zwei Lehrern Einzelunterricht haben. Überschneidet sich der Termin
   * mit einem anderen Einzeltermin der Person, wird nachgefragt; gespeichert wird nur auf Bestätigung.
   */
  private confirmClashes(student: Student, appointment: Omit<Appointment, 'id'>, id: string | null): boolean {
    const clashes = this.calendar.studentClashes(student.id, appointment, id);
    if (clashes.length === 0) return true;
    const teachers = this.config().teachers;
    const lines = clashes.slice(0, 3).map(({ date, appointment: other }) => {
      const teacher = teachers.find((t) => t.id === other.teacherId) ?? teacherOf(student, this.config());
      return `• ${formatDate(date)}, ${other.start}–${endTime(other)} bei ${teacher.name}`;
    });
    if (clashes.length > 3) lines.push(`• und ${clashes.length - 3} weitere`);
    return confirm(`${student.name} hat zu dieser Zeit schon Einzelunterricht:\n${lines.join('\n')}\n\nTrotzdem speichern?`);
  }

  protected save(): void {
    const draft = this.draft();
    if (!draft) return;
    if (!ownerOf({ ...draft, id: draft.id ?? '' }) || !draft.date || !draft.start || !(draft.durationMinutes > 0)) {
      this.message.set('Bitte Person oder Gruppe, Datum, Beginn und Dauer angeben.');
      return;
    }
    const { id, lessonId, teacherId: _, ...rest } = draft;
    // Personen anderer Lehrer stehen ausnahmsweise im Kalender des aktiven Lehrers.
    const student = rest.studentId ? this.studentsById().get(rest.studentId) : undefined;
    const exception = !!student && !this.activeTeacher.teaches(student);
    const appointment = exception ? { ...rest, teacherId: this.teacher().id } : rest;
    if (student && !this.confirmClashes(student, appointment, id)) return;
    if (lessonId && appointment.studentId && !appointment.weekly) {
      // Der Termin gehört zu einer erfassten Stunde: Die Stunde bekommt Datum, Uhrzeit und Dauer, der Termin folgt.
      this.studentsStore.setLessonTime(appointment.studentId, lessonId, appointment);
    } else if (lessonId && appointment.groupId && !appointment.weekly) {
      this.groupsStore.setLessonTime(appointment.groupId, lessonId, appointment);
    } else if (id) {
      // Wird aus dem Termin einer Stunde ein wöchentlicher, ist er ein gewöhnlicher Termin, der die Stunde abdeckt.
      this.calendar.update(id, appointment);
    } else {
      this.calendar.add(appointment);
    }
    this.weekStart.set(mondayOf(draft.date));
    this.draft.set(null);
  }

  protected remove(): void {
    const draft = this.draft();
    if (!draft?.id) return;
    const what = draft.weekly ? 'den wöchentlichen Termin mit allen Wiederholungen' : 'den Termin';
    if (confirm(`Möchtest du ${what} löschen?`)) {
      this.calendar.remove(draft.id);
      this.draft.set(null);
    }
  }

  protected exportPdf(action: 'open' | 'share'): void {
    const [from, to] = [this.pdfFrom(), this.pdfTo()];
    if (!from || !to || from > to) {
      this.message.set('Bitte einen gültigen Zeitraum wählen („von“ vor „bis“).');
      return;
    }
    if (daysBetween(from, to).length > MAX_PDF_DAYS) {
      this.message.set('Der Zeitraum für das PDF darf höchstens ein Jahr lang sein.');
      return;
    }
    this.message.set(null);
    const period = { from, to, label: formatPeriod(from, to) };
    const teachers = this.config().teachers.map((teacher) => ({
      name: teacher.name,
      location: teacher.location,
      teachingWindows: teacher.teachingWindows,
      days: this.scheduleDays(teacher, from, to),
    }));
    if (this.pdfFormat() === 'grid') {
      this.pdf.exportScheduleGrid(this.config(), teachers, period, action);
    } else {
      this.pdf.exportSchedule(this.config(), teachers, period, action);
    }
  }

  /** Termine der Personen und Gruppen eines Lehrers; die Liste enthält alle Lehrer, nicht nur den aktiven. */
  private scheduleDays(teacher: Teacher, from: string, to: string): ScheduleDay[] {
    const students = this.studentsStore.students();
    const names = new Map([
      ...students.map((student) => [student.id, student.name] as const),
      ...this.groupsStore.groups().map((group) => [group.id, `Gruppe ${groupLabel(group, students)}`] as const),
    ]);
    const occurrences = this.calendar.occurrences(from, to, this.groupsStore.calendarFilter(teacher));
    const blockers = this.calendar.blockersOf(teacher.id, from, to);
    return daysBetween(from, to)
      .map((date) => ({
        date,
        entries: [
          ...blockers.flatMap((blocker) => {
            const part = blockerOnDay(blocker, date);
            if (!part) return [];
            const start = minutesOf(part.start);
            return [{
              time: blockerTimeText(part),
              name: blocker.title ? `Blockiert: ${blocker.title}` : 'Blockiert',
              startMinutes: start,
              durationMinutes: (part.end === '24:00' ? 24 * 60 : minutesOf(part.end)) - start,
              blocked: true,
            }];
          }),
          ...occurrences
            .filter((o) => o.date === date)
            .map(({ appointment }) => ({
              time: `${appointment.start}–${endTime(appointment)}`,
              name: names.get(ownerOf(appointment)) ?? '',
              startMinutes: startMinutes(appointment),
              durationMinutes: appointment.durationMinutes,
            })),
        ].sort((a, b) => a.startMinutes - b.startMinutes),
      }))
      .filter((day) => day.entries.length > 0);
  }
}

function formatDay(date: string): string {
  return new Date(date + 'T00:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' });
}

/** z. B. „2. November – 8. November 2026“ */
export function formatPeriod(from: string, to: string): string {
  const day = (date: string, year: boolean) =>
    new Date(date + 'T00:00:00').toLocaleDateString('de-DE', {
      day: 'numeric',
      month: 'long',
      ...(year ? { year: 'numeric' } : {}),
    });
  return `${day(from, from.slice(0, 4) !== to.slice(0, 4))} – ${day(to, true)}`;
}
