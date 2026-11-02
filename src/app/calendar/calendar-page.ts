import { Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ActiveTeacher } from '../active-teacher';
import { ConfigStore } from '../config.store';
import { formatDate, instrumentOf, Lesson, lessonAt, Student, Teacher, teacherOf, today } from '../model';
import { PdfExport, ScheduleDay } from '../pdf-export';
import { isNativeApp } from '../save-file';
import { StudentsStore } from '../students.store';
import { addDays, Appointment, daysBetween, endTime, mondayOf, Occurrence, weekday } from './appointments';
import { CalendarStore } from './calendar.store';

type Draft = Omit<Appointment, 'id'> & { id: string | null };

/** Längster Zeitraum für die PDF-Liste, damit niemand versehentlich Jahrzehnte exportiert. */
const MAX_PDF_DAYS = 366;

@Component({
  selector: 'app-calendar-page',
  imports: [RouterLink],
  templateUrl: './calendar-page.html',
  styleUrl: './calendar-page.scss',
})
export class CalendarPage {
  private readonly calendar = inject(CalendarStore);
  private readonly config = inject(ConfigStore).config;
  private readonly pdf = inject(PdfExport);
  private readonly studentsStore = inject(StudentsStore);
  private readonly router = inject(Router);
  private readonly activeTeacher = inject(ActiveTeacher);
  protected readonly teacher = this.activeTeacher.teacher;
  /** Der Kalender zeigt nur die Personen des aktiven Lehrers und deren Termine. */
  protected readonly students = computed(() =>
    this.studentsStore.sortedStudents().filter((student) => this.activeTeacher.teaches(student)),
  );
  private readonly studentIds = computed(() => new Set(this.students().map((s) => s.id)));
  protected readonly formatDate = formatDate;
  protected readonly nativeApp = isNativeApp;
  protected readonly endTime = endTime;

  protected readonly today = today();
  protected readonly weekStart = signal(mondayOf(this.today));
  protected readonly week = computed(() => {
    const start = this.weekStart();
    const end = addDays(start, 6);
    const occurrences = this.calendar.occurrences(start, end, this.studentIds());
    return daysBetween(start, end).map((date) => ({
      date,
      label: formatDay(date),
      occurrences: occurrences.filter((o) => o.date === date),
    }));
  });
  protected readonly weekLabel = computed(() => formatPeriod(this.weekStart(), addDays(this.weekStart(), 6)));

  protected readonly draft = signal<Draft | null>(null);
  /** Angeklickter Termin an einem bestimmten Tag; nur gesetzt, solange ein vorhandener Termin bearbeitet wird. */
  protected readonly openedOccurrence = signal<Occurrence | null>(null);
  protected readonly message = signal<string | null>(null);

  /** Zeitraum der PDF-Liste; folgt der angezeigten Woche, bis man ihn selbst ändert. */
  protected readonly pdfFrom = linkedSignal(() => this.weekStart());
  protected readonly pdfTo = linkedSignal(() => addDays(this.weekStart(), 6));

  private readonly studentsById = computed(() => new Map(this.students().map((s) => [s.id, s])));

  protected studentOf(appointment: Appointment): Student | undefined {
    return this.studentsById().get(appointment.studentId);
  }

  protected instrumentName(student: Student): string {
    return instrumentOf(student, this.config()).name;
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
  protected newAppointment(date = this.today): void {
    const settings = this.config().calendar;
    const firstWindow = this.teacher().teachingWindows
      .filter((w) => w.weekday === weekday(date))
      .sort((a, b) => a.from.localeCompare(b.from))[0];
    this.message.set(null);
    this.openedOccurrence.set(null);
    this.draft.set({
      id: null,
      studentId: this.students()[0]?.id ?? '',
      date,
      start: firstWindow?.from ?? '15:00',
      durationMinutes: settings.defaultDurationMinutes,
      weekly: settings.weeklyByDefault,
    });
  }

  /** Öffnet den Termin zum Bearbeiten; von hier aus lässt sich die Stunde dieses Tages öffnen. */
  protected edit(occurrence: Occurrence): void {
    this.message.set(null);
    this.draft.set({ ...occurrence.appointment });
    this.openedOccurrence.set(occurrence);
  }

  protected lessonOf(occurrence: Occurrence): Lesson | undefined {
    const student = this.studentOf(occurrence.appointment);
    return student && lessonAt(student, occurrence.date, occurrence.appointment.start);
  }

  protected hasLesson(student: Student, occurrence: Occurrence): boolean {
    return !!lessonAt(student, occurrence.date, occurrence.appointment.start);
  }

  /** Legt die Stunde mit Datum und Uhrzeit des Termins an oder öffnet sie und wechselt zur Erfassung. */
  protected openLesson({ date, appointment }: Occurrence): void {
    this.studentsStore.openLesson(appointment.studentId, date, {
      start: appointment.start,
      durationMinutes: appointment.durationMinutes,
    });
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

  protected save(): void {
    const draft = this.draft();
    if (!draft) return;
    if (!draft.studentId || !draft.date || !draft.start || !(draft.durationMinutes > 0)) {
      this.message.set('Bitte Person, Datum, Beginn und Dauer angeben.');
      return;
    }
    const { id, lessonId, ...appointment } = draft;
    if (lessonId && !appointment.weekly) {
      // Der Termin gehört zu einer erfassten Stunde: Die Stunde bekommt Datum, Uhrzeit und Dauer, der Termin folgt.
      this.studentsStore.setLessonTime(appointment.studentId, lessonId, appointment);
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
      this.message.set('Der Zeitraum für die PDF-Liste darf höchstens ein Jahr lang sein.');
      return;
    }
    this.message.set(null);
    const period = { from, to, label: formatPeriod(from, to) };
    const teachers = this.config().teachers.map((teacher) => ({
      name: teacher.name,
      location: teacher.location,
      days: this.scheduleDays(teacher, from, to),
    }));
    this.pdf.exportSchedule(this.config(), teachers, period, action);
  }

  /** Termine der Personen eines Lehrers; die Liste enthält alle Lehrer, nicht nur den aktiven. */
  private scheduleDays(teacher: Teacher, from: string, to: string): ScheduleDay[] {
    const config = this.config();
    const students = new Map(
      this.studentsStore
        .students()
        .filter((student) => teacherOf(student, config).id === teacher.id)
        .map((student) => [student.id, student]),
    );
    const occurrences = this.calendar.occurrences(from, to, new Set(students.keys()));
    return daysBetween(from, to)
      .map((date) => ({
        date,
        entries: occurrences
          .filter((o) => o.date === date)
          .map(({ appointment }) => ({
            time: `${appointment.start}–${endTime(appointment)}`,
            name: students.get(appointment.studentId)!.name,
          })),
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
