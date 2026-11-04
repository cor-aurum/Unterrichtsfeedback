import { Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ActiveTeacher } from '../active-teacher';
import { ConfigStore } from '../config.store';
import { GroupsStore } from '../groups.store';
import {
  activeTeachersOn,
  containsDate,
  formatDate,
  Group,
  groupLabel,
  groupMembers,
  groupTeacherOf,
  instrumentOf,
  isTeachingDay,
  locationOn,
  NO_TEACHING_TEXT,
  Student,
  Teacher,
  teachersInOrderOn,
  teachingWindowsOn,
  today,
} from '../model';
import { DayPlan, PdfExport, ScheduleDay, ScheduleEntry } from '../pdf-export';
import { SharedImportPanel } from '../import/shared-import-panel';
import { ReportPeriod } from '../report-period';
import { isNativeApp } from '../save-file';
import { storedSignal } from '../stored-signal';
import { StudentsStore } from '../students.store';
import { StudentLabelPipe } from '../student-label.pipe';
import {
  addDays,
  Appointment,
  daysBetween,
  endTime,
  followsLesson,
  minutesOf,
  timeOf,
  mondayOf,
  Occurrence,
  ownerOf,
  recurrenceUntilPeriodEnd,
  repeatEveryText,
  repeatText,
  startMinutes,
  weekday,
} from './appointments';
import { AutoSchedulePanel } from './auto-schedule-panel';
import { Blocker, blockerOnDay, blockerTimeText } from './blockers';
import { TimeSpan, withLanes } from './lanes';
import { APPOINTMENT_STATE_LABELS, appointmentState, AppointmentState } from './appointment-state';
import { CalendarStore } from './calendar.store';
import { Clock } from './clock';
import { LessonOpener } from './lesson-opener';
import { CalendarTablePanel } from './calendar-table-panel';
import { IcalExportPanel } from './ical-export-panel';
import { RecurrenceFields } from './recurrence-fields';
import { LessonLoadPanel } from './lesson-load-panel';
import { newSharedDraft, SharedAppointmentForm, SharedDraft } from './shared-appointment-form';
import { SharedAppointment, sharedEndTime } from './shared-appointments';

/** `calendarTeacherId`: in wessen Kalender der Termin steht; nur fürs Formular, gespeichert als Ausnahme (`teacherId`). */
type Draft = Omit<Appointment, 'id'> & { id: string | null; calendarTeacherId: string; extraGroupIds?: string[] };

/** Formular für einen Blocker; bei ganzen Tagen zählt `toDate` mit (gespeichert wird der Folgetag 00:00). */
interface BlockerDraft {
  id: string | null;
  teacherId: string;
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
  imports: [
    RouterLink,
    AutoSchedulePanel,
    LessonLoadPanel,
    IcalExportPanel,
    CalendarTablePanel,
    SharedAppointmentForm,
    SharedImportPanel,
    RecurrenceFields,
    StudentLabelPipe,
  ],
  templateUrl: './calendar-page.html',
  styleUrl: './calendar-page.scss',
})
export class CalendarPage {
  private readonly calendar = inject(CalendarStore);
  private readonly config = inject(ConfigStore).config;
  private readonly pdf = inject(PdfExport);
  private readonly studentsStore = inject(StudentsStore);
  private readonly groupsStore = inject(GroupsStore);
  private readonly opener = inject(LessonOpener);
  private readonly clock = inject(Clock);
  protected readonly stateLabels = APPOINTMENT_STATE_LABELS;
  protected readonly states = Object.keys(APPOINTMENT_STATE_LABELS) as AppointmentState[];
  private readonly router = inject(Router);
  private readonly activeTeacher = inject(ActiveTeacher);
  private readonly reportPeriod = inject(ReportPeriod);
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
  protected readonly allGroupsEmpty = computed(() => this.groupsStore.groups().length === 0);
  /** Gruppen, deren Termine im Kalender des aktiven Lehrers stehen */
  protected readonly groups = computed(() =>
    this.groupsStore.groups().filter((group) => groupTeacherOf(group, this.config()).id === this.teacher().id),
  );
  private readonly inCalendar = computed(() => this.groupsStore.calendarFilter(this.teacher()));
  protected readonly teachers = computed(() => this.config().teachers);
  /** Woche des aktiven Lehrers oder aller Lehrer; gilt nur auf diesem Gerät. */
  protected readonly calendarView = storedSignal<'own' | 'all'>('feedback.calendarView', () => 'own', (data) =>
    data === 'all' ? 'all' : 'own',
  );
  protected readonly showAll = computed(() => this.calendarView() === 'all' && this.teachers().length > 1);

  protected readonly formatDate = formatDate;
  protected readonly nativeApp = isNativeApp;
  protected readonly endTime = endTime;

  protected readonly today = today();
  /** Die Woche von heute; liegt heute nicht im Berichtszeitraum, dessen erste Woche (wie das Datum neuer Termine) */
  protected readonly weekStart = signal(mondayOf(this.defaultDate()));
  /**
   * Die Woche als Zeitraster: je Tag die Einträge mit Beginn und Dauer, sich überschneidende nebeneinander.
   * Ganztägige Blocker stehen über dem Raster.
   */
  protected readonly week = computed(() => {
    const start = this.weekStart();
    const end = addDays(start, 6);
    const all = this.showAll();
    const occurrences = this.calendar.occurrences(start, end, all ? undefined : this.inCalendar());
    const blockers = (all ? this.teachers() : [this.teacher()]).flatMap((t) => this.calendar.blockersOf(t.id, start, end));
    const shared = this.calendar.sharedOccurrences(start, end, all ? undefined : this.teacher().id);
    const config = this.config();
    return daysBetween(start, end).map((date) => {
      const blockerParts = blockers.flatMap((blocker) => {
        const part = blockerOnDay(blocker, date);
        return part ? [{ blocker, part }] : [];
      });
      const fullDay = blockerParts.filter(({ part }) => part.start === '00:00' && part.end === '24:00');
      const items: WeekItem[] = [
        ...occurrences
          .filter((o) => o.date === date && this.reportPeriod.contains(date))
          .map((occurrence) => ({ kind: 'appointment' as const, occurrence, ...spanOf(occurrence.appointment) })),
        ...shared.filter((o) => o.date === date).map(({ appointment }) => ({ kind: 'shared' as const, shared: appointment, ...spanOf(appointment) })),
        ...blockerParts
          .filter((entry) => !fullDay.includes(entry))
          .map(({ blocker, part }) => ({
            kind: 'blocker' as const,
            blocker,
            time: blockerTimeText(part),
            startMinutes: minutesOf(part.start),
            durationMinutes: minutesOf(part.end) - minutesOf(part.start),
          })),
      ];
      return {
        date,
        label: formatDay(date),
        teaching: isTeachingDay(config, date),
        inPeriod: this.reportPeriod.contains(date),
        otherPeriod: this.otherPeriodOn(date),
        fullDayBlockers: fullDay.map(({ blocker }) => blocker),
        items: withLanes(items),
        windows: all ? [] : teachingWindowsOn(this.teacher(), config, date),
      };
    });
  });

  /**
   * Stunden, die das Raster zeigt: von der ersten bis zur letzten Stunde mit Einträgen oder Unterrichtszeiten der
   * Woche, mindestens sechs Stunden; ohne beides 8 bis 18 Uhr.
   */
  protected readonly gridHours = computed(() => {
    const days = this.week();
    const starts = days.flatMap((d) => [...d.items.map((i) => i.startMinutes), ...d.windows.map((w) => minutesOf(w.from))]);
    const ends = days.flatMap((d) => [
      ...d.items.map((i) => i.startMinutes + i.durationMinutes),
      ...d.windows.map((w) => minutesOf(w.to)),
    ]);
    if (starts.length === 0) return { first: 8, last: 18 };
    const first = Math.floor(Math.min(...starts) / 60);
    const last = Math.min(24, Math.max(Math.ceil(Math.max(...ends) / 60), first + 6));
    return { first: Math.min(first, last - 6), last };
  });
  protected readonly hourLabels = computed(() => {
    const { first, last } = this.gridHours();
    return Array.from({ length: last - first }, (_, i) => ({ label: `${first + i}:00`, top: i * 60 * PX_PER_MINUTE }));
  });
  protected readonly gridHeight = computed(() => (this.gridHours().last - this.gridHours().first) * 60 * PX_PER_MINUTE);

  /** Lage im Raster; Einträge außerhalb der gezeigten Stunden werden abgeschnitten. */
  protected boxOf(item: { startMinutes: number; durationMinutes: number; lane: number; lanes: number }): BoxStyle {
    const { first, last } = this.gridHours();
    const from = Math.max(item.startMinutes, first * 60);
    const to = Math.min(item.startMinutes + item.durationMinutes, last * 60);
    return {
      top: (from - first * 60) * PX_PER_MINUTE,
      height: Math.max((to - from) * PX_PER_MINUTE - 2, 16),
      left: (item.lane / item.lanes) * 100,
      width: 100 / item.lanes,
    };
  }

  protected windowBox(window: { from: string; to: string }): { top: number; height: number } {
    return this.boxOf({ startMinutes: minutesOf(window.from), durationMinutes: minutesOf(window.to) - minutesOf(window.from), lane: 0, lanes: 1 });
  }

  /** Klick auf eine freie Stelle: neuer Termin zu dieser Uhrzeit (auf 15 Minuten abgerundet) */
  protected newAt(date: string, event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (target.closest('button')) return;
    const body = event.currentTarget as HTMLElement;
    const minutes = this.gridHours().first * 60 + (event.clientY - body.getBoundingClientRect().top) / PX_PER_MINUTE;
    const start = timeOf(Math.floor(minutes / 15) * 15);
    this.newAppointment(date, false, start);
  }
  protected readonly weekLabel = computed(() => formatPeriod(this.weekStart(), addDays(this.weekStart(), 6)));

  protected readonly draft = signal<Draft | null>(null);
  protected readonly blockerDraft = signal<BlockerDraft | null>(null);
  protected readonly sharedDraft = signal<SharedDraft | null>(null);
  protected readonly sharedEndTime = sharedEndTime;
  protected readonly minutesOf = minutesOf;
  protected readonly repeatText = repeatText;
  /** Angeklickter Termin an einem bestimmten Tag; nur gesetzt, solange ein vorhandener Termin bearbeitet wird. */
  protected readonly openedOccurrence = signal<Occurrence | null>(null);
  protected readonly message = signal<string | null>(null);
  protected readonly autoScheduleOpen = signal(false);
  protected readonly sharedImportOpen = signal(false);
  /** Erfolgsmeldung, z. B. nach dem automatischen Einplanen */
  protected readonly notice = signal<string | null>(null);

  /** Zeitraum der PDF-Liste; folgt der angezeigten Woche, bis man ihn selbst ändert. */
  protected readonly pdfFrom = linkedSignal(() => this.weekStart());
  protected readonly pdfTo = linkedSignal(() => addDays(this.weekStart(), 6));
  /** Liste oder Wochenplan als Tabelle; gilt nur auf diesem Gerät. */
  protected readonly pdfFormat = storedSignal<'list' | 'individual' | 'events' | 'grid' | 'day'>(
    'feedback.scheduleFormat',
    () => 'list',
    (data) => (data === 'individual' || data === 'events' || data === 'grid' || data === 'day' ? data : 'list'),
  );

  private readonly studentsById = computed(() => new Map(this.studentsStore.students().map((s) => [s.id, s])));
  private readonly groupsById = computed(() => new Map(this.groupsStore.groups().map((g) => [g.id, g])));

  /** Personen des Lehrers – die anderen lassen sich als Ausnahme in seinen Kalender eintragen */
  protected studentsOf(teacherId: string): Student[] {
    return this.studentsStore.sortedStudents().filter((s) => this.studentsStore.teacherOf(s).id === teacherId);
  }

  protected otherStudentsOf(teacherId: string): Student[] {
    return this.studentsStore.sortedStudents().filter((s) => this.studentsStore.teacherOf(s).id !== teacherId);
  }

  protected groupsOf(teacherId: string): Group[] {
    return this.groupsStore.groups().filter((g) => groupTeacherOf(g, this.config()).id === teacherId);
  }

  /** Gruppen, die ein neuer Gruppentermin zusätzlich bekommen kann: alle außer der gewählten */
  protected otherGroups(draft: Draft): Group[] {
    return [...this.groupsStore.groups()]
      .filter((group) => group.id !== draft.groupId)
      .sort((a, b) => this.groupLabel(a).localeCompare(this.groupLabel(b), 'de'));
  }

  protected groupTeacherName(group: Group): string {
    return groupTeacherOf(group, this.config()).name;
  }

  protected toggleExtraGroup(groupId: string): void {
    this.draft.update((draft) => {
      if (!draft) return draft;
      const ids = draft.extraGroupIds ?? [];
      return { ...draft, extraGroupIds: ids.includes(groupId) ? ids.filter((id) => id !== groupId) : [...ids, groupId] };
    });
  }

  protected teacherNameOf(teacherId: string): string {
    return this.teachers().find((t) => t.id === teacherId)?.name ?? '';
  }

  private calendarTeacherOf(appointment: Appointment): Teacher {
    return this.groupsStore.calendarTeacherOf(appointment);
  }

  /** Lehrername vor den Angaben eines Termins, nur in der Ansicht aller Lehrer */
  protected teacherTag(appointment: Appointment): string {
    return this.showAll() ? `${this.calendarTeacherOf(appointment).name} · ` : '';
  }

  /**
   * Wechselt den Kalender im Formular; eine Gruppe eines anderen Lehrers wird dabei durch eine passende ersetzt.
   * Ein neuer Termin beginnt dann mit der ersten Unterrichtszeit dieses Lehrers am Tag.
   */
  protected setDraftTeacher(teacherId: string): void {
    this.draft.update((current) => {
      if (!current) return current;
      const teacher = this.teachers().find((t) => t.id === teacherId);
      const start = !current.id && teacher ? teachingWindowsOn(teacher, this.config(), current.date)[0]?.from : undefined;
      const draft = { ...current, calendarTeacherId: teacherId, ...(start ? { start } : {}) };
      const group = draft.groupId ? this.groupsById().get(draft.groupId) : undefined;
      if (!group || groupTeacherOf(group, this.config()).id === teacherId) return draft;
      const { groupId: _, ...rest } = draft;
      return { ...rest, ...this.firstOwnerOf(teacherId, true) };
    });
  }

  /** Erste Gruppe (mit `preferGroup`) oder Person des Lehrers, sonst irgendeine Person */
  private firstOwnerOf(teacherId: string, preferGroup: boolean): { studentId?: string; groupId?: string } {
    const group = this.groupsOf(teacherId)[0];
    const student = this.studentsOf(teacherId)[0] ?? this.otherStudentsOf(teacherId)[0];
    if (preferGroup && group) return { groupId: group.id };
    if (student) return { studentId: student.id };
    return group ? { groupId: group.id } : {};
  }

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
    return this.studentsStore.teacherOf(student).name;
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
      return value.startsWith('g:')
        ? { ...rest, groupId: id, extraGroupIds: (rest.extraGroupIds ?? []).filter((groupId) => groupId !== id) }
        : { ...rest, studentId: id };
    });
  }

  protected openAutoSchedule(): void {
    this.draft.set(null);
    this.notice.set(null);
    this.autoScheduleOpen.set(true);
  }

  protected openSharedImport(): void {
    this.closeForms();
    this.autoScheduleOpen.set(false);
    this.notice.set(null);
    this.sharedImportOpen.set(true);
  }

  protected closeSharedImport(result: string): void {
    this.sharedImportOpen.set(false);
    this.notice.set(result || null);
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

  /** Zeiträume für den Sprung an ihren Beginn, nach Beginn sortiert */
  protected readonly periodsByStart = computed(() =>
    [...this.reportPeriod.periods()].sort((a, b) => a.from.localeCompare(b.from)),
  );

  /** Wählt den Zeitraum (und damit seine Personen und Gruppen) und zeigt seine erste Woche. */
  protected showPeriodStart(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const period = this.reportPeriod.periods().find((p) => p.id === select.value);
    select.value = '';
    if (!period) return;
    this.reportPeriod.select(period.id);
    this.weekStart.set(mondayOf(period.from));
  }

  /**
   * Vorbelegt mit den Kalender-Einstellungen; der Beginn ist der Anfang der ersten Unterrichtszeit des
   * aktiven Lehrers an diesem Tag.
   */
  /** Neuer Blocker, vorbelegt mit dem ganzen Tag */
  protected newBlocker(date = this.today): void {
    this.closeForms();
    this.blockerDraft.set({
      id: null,
      teacherId: this.teacher().id,
      title: '',
      allDay: true,
      fromDate: date,
      fromTime: '14:00',
      toDate: date,
      toTime: '18:00',
    });
  }

  protected editBlocker(blocker: Blocker): void {
    this.closeForms();
    const allDay = blocker.from.endsWith('T00:00') && blocker.to.endsWith('T00:00');
    this.blockerDraft.set({
      id: blocker.id,
      teacherId: blocker.teacherId,
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
    const blocker = { teacherId: draft.teacherId, title: draft.title.trim(), from, to };
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
    this.sharedDraft.set(null);
  }

  /** Tag neuer Termine: heute, liegt heute nicht im Berichtszeitraum, sein erster Tag */
  /** Unterricht gibt es nur im gewählten Berichtszeitraum (und damit nie außerhalb aller Zeiträume). */
  protected isTeachingDay(date: string): boolean {
    return !date || this.reportPeriod.contains(date);
  }

  /** Warum an dem Tag kein Unterricht im gewählten Zeitraum möglich ist */
  protected noLessonText(date: string): string {
    const other = this.otherPeriodOn(date);
    return other
      ? `Der ${formatDate(date)} gehört zum Berichtszeitraum „${other}“. Wähle ihn oben, um dort Termine zu planen.`
      : `Der ${formatDate(date)} ${NO_TEACHING_TEXT}`;
  }

  /** Name eines anderen Berichtszeitraums, in dem der Tag liegt */
  private otherPeriodOn(date: string): string | null {
    if (this.reportPeriod.contains(date)) return null;
    return this.config().reportPeriods.find((period) => containsDate(period, date))?.name ?? null;
  }

  private defaultDate(): string {
    const period = this.reportPeriod.period();
    return containsDate(period, this.today) ? this.today : period.from;
  }

  protected newShared(date = this.defaultDate()): void {
    this.closeForms();
    this.sharedDraft.set(newSharedDraft(this.config, date));
  }

  /** Nach dem Umwandeln in Gruppentermine kommt ein Hinweis mit. */
  protected closeShared(result: string | void): void {
    this.sharedDraft.set(null);
    if (result) this.notice.set(result);
  }

  protected editShared(appointment: SharedAppointment): void {
    this.closeForms();
    this.sharedDraft.set({ ...appointment });
  }

  /** Kurz, z. B. „Aula · wöchentlich“; die ganze Serie steht im Formular. */
  protected sharedDetail(appointment: SharedAppointment): string {
    return [
      appointment.location,
      this.soleTeacherOf(appointment),
      appointment.repeat ? repeatEveryText(appointment) : '',
      appointment.blocksPlanning ? '' : 'blockiert nicht',
    ]
      .filter((part) => part)
      .join(' · ');
  }

  /**
   * Lehrer nennt nur die Ansicht aller Lehrer und nur, wenn der Termin genau einen hat; bei mehreren wäre die
   * Liste zu lang, sie steht im Formular.
   */
  private soleTeacherOf(appointment: SharedAppointment): string {
    if (!this.showAll() || appointment.teacherIds.length !== 1) return '';
    return this.teacherNameOf(appointment.teacherIds[0]);
  }

  /**
   * Neuer Termin im Kalender des aktiven Lehrers; mit `forGroup` ist eine Gruppe vorausgewählt. Hat der aktive
   * Lehrer keine Gruppe, gilt der Kalender des Lehrers der ersten Gruppe.
   */
  protected newAppointment(date = this.defaultDate(), forGroup = false, start?: string): void {
    const settings = this.config().calendar;
    const firstGroup = this.groupsStore.groups()[0];
    const teacher =
      forGroup && this.groups().length === 0 && firstGroup ? groupTeacherOf(firstGroup, this.config()) : this.teacher();
    const firstWindow = teachingWindowsOn(teacher, this.config(), date)[0];
    this.closeForms();
    this.draft.set({
      id: null,
      calendarTeacherId: teacher.id,
      ...this.firstOwnerOf(teacher.id, forGroup),
      date,
      start: start ?? firstWindow?.from ?? '15:00',
      durationMinutes: settings.defaultDurationMinutes,
      ...(settings.repeatByDefault ? { repeat: recurrenceUntilPeriodEnd(this.config().reportPeriods, date, 1) } : {}),
    });
  }

  /** Öffnet den Termin zum Bearbeiten; von hier aus lässt sich die Stunde dieses Tages öffnen. */
  protected edit(occurrence: Occurrence): void {
    this.closeForms();
    this.draft.set({ ...occurrence.appointment, calendarTeacherId: this.calendarTeacherOf(occurrence.appointment).id });
    this.openedOccurrence.set(occurrence);
  }

  protected newGroupAppointment(): void {
    this.newAppointment(this.defaultDate(), true);
  }

  /** Gibt es zum Termin an diesem Tag schon eine Stunde (bei Gruppen: eine Gruppenstunde)? */
  protected hasLesson({ date, appointment }: Occurrence): boolean {
    return !!this.opener.lessonFor(appointment, date);
  }

  protected stateOf(occurrence: Occurrence): AppointmentState {
    return appointmentState(occurrence.appointment, occurrence.date, this.hasLesson(occurrence), this.clock.now());
  }

  /** Öffnet die Stunde zum Termin oder legt sie mit Datum und Uhrzeit des Termins an und wechselt zur Erfassung. */
  protected openLesson({ date, appointment }: Occurrence): void {
    if (!this.opener.open(appointment, date)) {
      this.message.set(this.noLessonText(date));
      return;
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
      const teacher = teachers.find((t) => t.id === other.teacherId) ?? this.studentsStore.teacherOf(student);
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
    if (!this.isTeachingDay(draft.date)) {
      this.message.set(this.noLessonText(draft.date));
      return;
    }
    const { id, lessonId, teacherId: _, calendarTeacherId, extraGroupIds, ...rest } = draft;
    // Steht der Termin nicht im Kalender des Lehrers der Person oder Gruppe, ist er eine Ausnahme.
    const exception = this.calendarTeacherOf(rest as Appointment).id !== calendarTeacherId;
    const appointment = exception ? { ...rest, teacherId: calendarTeacherId } : rest;
    const student = rest.studentId ? this.studentsById().get(rest.studentId) : undefined;
    if (student && !this.confirmClashes(student, appointment, id)) return;
    if (lessonId && appointment.studentId && !appointment.repeat) {
      // Der Termin gehört zu einer erfassten Stunde: Die Stunde bekommt Datum, Uhrzeit und Dauer, der Termin folgt.
      this.studentsStore.setLessonTime(appointment.studentId, lessonId, appointment);
    } else if (lessonId && appointment.groupId && !appointment.repeat) {
      this.groupsStore.setLessonTime(appointment.groupId, lessonId, appointment);
    } else if (id) {
      // Wird aus dem Termin einer Stunde eine Serie, ist er ein gewöhnlicher Termin, der die Stunde abdeckt.
      this.calendar.update(id, appointment);
    } else {
      this.calendar.add(appointment);
    }
    const extra = !id && rest.groupId ? (extraGroupIds ?? []).filter((groupId) => groupId !== rest.groupId) : [];
    this.addForGroups(rest, extra);
    this.weekStart.set(mondayOf(draft.date));
    this.draft.set(null);
    this.noteOtherCalendar(calendarTeacherId);
    if (extra.length > 0) this.notice.set(`${extra.length + 1} Gruppentermine eingetragen, jeweils im Kalender des Lehrers der Gruppe.`);
  }

  /** Derselbe Termin für weitere Gruppen; jede steht im Kalender ihres eigenen Lehrers. */
  private addForGroups(appointment: Omit<Appointment, 'id'>, groupIds: string[]): void {
    const { studentId: _s, groupId: _g, teacherId: _t, ...time } = appointment;
    groupIds.forEach((groupId) => this.calendar.add({ ...time, groupId }));
  }

  /** In der eigenen Woche fehlt ein Termin für einen anderen Lehrer; ein Hinweis sagt, wo er steht. */
  private noteOtherCalendar(teacherId: string): void {
    if (!this.showAll() && teacherId !== this.teacher().id) {
      this.notice.set(`Gespeichert im Kalender von ${this.teacherNameOf(teacherId)}. „Alle Lehrer“ zeigt ihn hier.`);
    }
  }

  protected remove(): void {
    const draft = this.draft();
    if (!draft?.id) return;
    const what = draft.repeat ? 'die Terminserie mit allen Wiederholungen' : 'den Termin';
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
    if (this.pdfFormat() === 'day') {
      this.pdf.exportDayGrid(this.config(), this.dayPlans(from, to), period, action);
      return;
    }
    if (this.pdfFormat() === 'events') {
      this.pdf.exportAppointmentList(this.config(), this.eventDays(from, to), period, action);
      return;
    }
    const teachers = teachersInOrderOn(this.config(), from).map((teacher) => ({
      name: teacher.name,
      // Der Ort am ersten Tag; meist liegt der Zeitraum der Liste in einem Berichtszeitraum.
      location: locationOn(teacher, this.config(), from),
      windowsByDate: Object.fromEntries(daysBetween(from, to).map((date) => [date, teachingWindowsOn(teacher, this.config(), date)])),
      days: this.scheduleDays(teacher, from, to, true),
    }));
    if (this.pdfFormat() === 'individual') {
      // Nur Einzelunterricht: ohne Gruppentermine, allgemeine Termine und Blocker; alle Lehrer bleiben in der Liste.
      const individual = teachers.map((teacher) => ({
        ...teacher,
        days: teacher.days
          .map((day) => ({ ...day, entries: day.entries.filter((e) => !e.blocked && !e.shared && !e.group) }))
          .filter((day) => day.entries.length > 0),
      }));
      this.pdf.exportIndividualList(this.config(), individual, period, action);
    } else if (this.pdfFormat() === 'grid') {
      this.pdf.exportScheduleGrid(this.config(), teachers, period, action);
    } else {
      this.pdf.exportSchedule(this.config(), teachers, period, action);
    }
  }

  /**
   * Gruppentermine und allgemeine Termine aller Lehrer je Tag, ohne Einzelunterricht. Jeder Eintrag nennt seinen
   * Raum: bei Gruppen den des Lehrers, in dessen Kalender der Termin steht, bei allgemeinen Terminen ihren Ort.
   * Den Lehrer nennt er nur, wenn es genau einer ist.
   */
  private eventDays(from: string, to: string): ScheduleDay[] {
    const config = this.config();
    const names = this.groupsStore.ownerNames();
    const groupEntries = this.calendar
      .occurrences(from, to, (a) => !!a.groupId)
      .map(({ date, appointment }) => {
        const teacher = this.calendarTeacherOf(appointment);
        return {
          date,
          entry: {
            time: `${appointment.start}–${endTime(appointment)}`,
            name: [names.get(appointment.groupId!) ?? 'Gruppe', locationOn(teacher, config, date), teacher.name].filter((p) => p).join(' · '),
            startMinutes: startMinutes(appointment),
            durationMinutes: appointment.durationMinutes,
          },
        };
      });
    const sharedEntries = this.calendar.sharedOccurrences(from, to).map(({ date, appointment }) => {
      const sole = appointment.teacherIds.length === 1 ? config.teachers.find((t) => t.id === appointment.teacherIds[0])?.name : '';
      const entry = sharedEntry(appointment);
      return { date, entry: { ...entry, name: [entry.name, sole].filter((p) => p).join(' · ') } };
    });
    const all = [...groupEntries, ...sharedEntries];
    return daysBetween(from, to)
      .map((date) => ({
        date,
        entries: all
          .filter((e) => e.date === date)
          .map((e) => e.entry)
          .sort((a, b) => a.startMinutes - b.startMinutes),
      }))
      .filter((day) => day.entries.length > 0);
  }

  /**
   * Je Tag die Spalten der Lehrer, die an dem Tag aktiv sind oder Termine haben, und die allgemeinen Termine
   * über den Spalten ihrer Lehrer.
   */
  private dayPlans(from: string, to: string): DayPlan[] {
    const config = this.config();
    return daysBetween(from, to).map((date) => {
      const shared = this.calendar.sharedOccurrences(date, date).map((o) => o.appointment);
      const entries = new Map(config.teachers.map((t) => [t.id, this.scheduleDays(t, date, date, false)[0]?.entries ?? []]));
      const involved = new Set([
        ...activeTeachersOn(config, date).map((t) => t.id),
        ...config.teachers.filter((t) => entries.get(t.id)!.length > 0).map((t) => t.id),
        ...shared.flatMap((appointment) => appointment.teacherIds),
      ]);
      const teachers = teachersInOrderOn(config, date).filter((t) => involved.has(t.id));
      return {
        date,
        columns: teachers.map((teacher) => ({
          name: teacher.name,
          location: locationOn(teacher, config, date),
          teachingWindows: teachingWindowsOn(teacher, config, date),
          entries: entries.get(teacher.id)!,
        })),
        shared: shared.map((appointment) => ({
          entry: sharedEntry(appointment),
          columns: teachers.flatMap((teacher, index) => (appointment.teacherIds.includes(teacher.id) ? [index] : [])),
        })),
      };
    });
  }

  /**
   * Termine der Personen und Gruppen eines Lehrers, seine Blocker und mit `withShared` seine allgemeinen Termine;
   * die Liste enthält alle Lehrer, nicht nur den aktiven.
   */
  private scheduleDays(teacher: Teacher, from: string, to: string, withShared: boolean): ScheduleDay[] {
    const names = this.groupsStore.ownerNames();
    const occurrences = this.calendar.occurrences(from, to, this.groupsStore.calendarFilter(teacher));
    const blockers = this.calendar.blockersOf(teacher.id, from, to);
    const shared = withShared ? this.calendar.sharedOccurrences(from, to, teacher.id) : [];
    const blockedLabel = this.config().calendarPdf.blocked;
    return daysBetween(from, to)
      .map((date) => ({
        date,
        entries: [
          ...shared.filter((o) => o.date === date).map((o) => sharedEntry(o.appointment)),
          ...blockers.flatMap((blocker) => {
            const part = blockerOnDay(blocker, date);
            if (!part) return [];
            const start = minutesOf(part.start);
            return [{
              time: blockerTimeText(part),
              name: blocker.title ? `${blockedLabel}: ${blocker.title}` : blockedLabel,
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
              group: !!appointment.groupId,
            })),
        ].sort((a, b) => a.startMinutes - b.startMinutes),
      }))
      .filter((day) => day.entries.length > 0);
  }
}

/** Allgemeiner Termin als Eintrag im Plan, mit dem Ort hinter der Bezeichnung */
function sharedEntry(appointment: SharedAppointment): ScheduleEntry {
  return {
    time: `${appointment.start}–${sharedEndTime(appointment)}`,
    name: appointment.location ? `${appointment.title} · ${appointment.location}` : appointment.title,
    startMinutes: minutesOf(appointment.start),
    durationMinutes: appointment.durationMinutes,
    shared: true,
  };
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

/** Höhe einer Minute im Wochenraster in Pixeln (eine Stunde = 72 px) */
const PX_PER_MINUTE = 1.2;

/** Ein Eintrag im Wochenraster */
type WeekItem = TimeSpan &
  (
    | { kind: 'appointment'; occurrence: Occurrence }
    | { kind: 'shared'; shared: SharedAppointment }
    | { kind: 'blocker'; blocker: Blocker; time: string }
  );

interface BoxStyle {
  top: number;
  height: number;
  /** Prozent der Spaltenbreite */
  left: number;
  width: number;
}

function spanOf(appointment: { start: string; durationMinutes: number }): TimeSpan {
  return { startMinutes: minutesOf(appointment.start), durationMinutes: appointment.durationMinutes };
}
