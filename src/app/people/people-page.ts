import { Component, computed, effect, inject, linkedSignal, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ActiveTeacher } from '../active-teacher';
import { Appointment, FreeSlot, isRunningSeries, slotText } from '../calendar/appointments';
import { CalendarStore } from '../calendar/calendar.store';
import { Clock } from '../calendar/clock';
import { ConfigStore } from '../config.store';
import { csvBlob } from '../csv';
import { GroupsStore } from '../groups.store';
import { StudentImportPanel } from '../import/student-import-panel';
import { InstrumentSelect } from '../instrument-select';
import {
  defaultInstrument,
  doubleLessonDates,
  formatDate,
  formatShortDate,
  Group,
  groupLabel,
  Instrument,
  instrumentOf,
  isActiveIn,
  Student,
  Teacher,
  teacherOf,
  today,
} from '../model';
import { DuplicatePair, PersonMerger } from '../person-merger';
import { ReportPeriod } from '../report-period';
import { safeFileName, saveFile } from '../save-file';
import { sortedLessons, StudentsStore } from '../students.store';
import { TeacherFilter } from '../teacher-filter';

/** Statusfilter der Personenliste; leer zeigt alle. */
type StatusFilter = '' | 'today' | 'noWeekly' | 'noLessonInPeriod';

/**
 * Personenverwaltung: Personen suchen und filtern, anlegen, importieren und exportieren, Name, Instrument, Lehrer
 * und Berichtszeiträume ändern, einen Termin vergeben oder die Person löschen. Die Stunden erfasst man unter
 * „Stunden erfassen“; beide Seiten teilen sich die ausgewählte Person.
 */
@Component({
  selector: 'app-people-page',
  imports: [RouterLink, StudentImportPanel, InstrumentSelect],
  templateUrl: './people-page.html',
  styleUrls: ['../lessons/lessons.scss', './people-page.scss'],
})
export class PeoplePage {
  protected readonly store = inject(StudentsStore);
  protected readonly groups = inject(GroupsStore);
  protected readonly teacherFilter = inject(TeacherFilter);
  private readonly configStore = inject(ConfigStore);
  protected readonly config = this.configStore.config;
  private readonly calendar = inject(CalendarStore);
  private readonly clock = inject(Clock);
  private readonly activeTeacher = inject(ActiveTeacher);
  private readonly router = inject(Router);
  protected readonly reportPeriod = inject(ReportPeriod);
  protected readonly merger = inject(PersonMerger);

  // Filter der Personenliste; außer dem Lehrerfilter gelten sie nur bis zum Neuladen.
  protected readonly search = signal('');
  protected readonly instrumentFilter = signal('');
  protected readonly groupFilter = signal('');
  protected readonly statusFilter = signal<StatusFilter>('');
  /** Leer: Personen des gewählten Berichtszeitraums; `all`: alle; sonst die ID eines anderen Zeitraums */
  protected readonly periodFilter = signal('');
  protected readonly extraFilterCount = computed(
    () =>
      [
        this.teacherFilter.teacherId(),
        this.instrumentFilter(),
        this.groupFilter(),
        this.statusFilter(),
        this.periodFilter(),
      ].filter(Boolean).length,
  );
  /** Personen, auf die der Zeitraumfilter passt, nach Namen sortiert */
  private readonly studentsOfPeriodFilter = computed(() => {
    const filter = this.periodFilter();
    const all = this.store.allStudents();
    const students = !filter ? this.store.students() : filter === 'all' ? all : all.filter((s) => isActiveIn(s, filter));
    return [...students].sort((a, b) => a.name.localeCompare(b.name, 'de'));
  });
  protected readonly visibleStudents = computed(() => {
    const config = this.config();
    const search = this.search().trim().toLowerCase();
    const group = this.groups.groups().find((g) => g.id === this.groupFilter());
    const status = this.statusFilter();
    const matchesStatus = status ? this.statusMatcher(status) : () => true;
    return this.studentsOfPeriodFilter()
      .filter((student) => this.teacherFilter.shows(this.store.teacherOf(student).id))
      .filter((student) => !search || student.name.toLowerCase().includes(search))
      .filter((student) => !this.instrumentFilter() || instrumentOf(student, config).id === this.instrumentFilter())
      .filter((student) => !group || group.memberIds.includes(student.id))
      .filter(matchesStatus);
  });

  protected readonly slotMessage = signal<string | null>(null);
  protected readonly importOpen = signal(false);
  protected readonly importMessage = signal<string | null>(null);
  protected readonly formatDate = formatDate;
  protected readonly slotText = slotText;
  protected readonly teachers = computed(() => this.config().teachers);
  protected readonly defaultInstrumentId = computed(() => defaultInstrument(this.config()).id);
  /** Instrument für die nächste neue Person; nach dem Anlegen wieder das Standardinstrument */
  protected readonly newStudentInstrumentId = linkedSignal(() => this.defaultInstrumentId());

  /** Alle Berichtszeiträume nach Beginn, für Filter und Anzeige */
  protected readonly periodsByStart = computed(() =>
    [...this.config().reportPeriods].sort((a, b) => a.from.localeCompare(b.from)),
  );

  /**
   * Nächster freier Slot im Kalender des Lehrers der ausgewählten Person; aktualisiert sich mit der
   * Uhrzeit und neuen Terminen.
   */
  protected readonly nextSlot = computed(() => {
    const student = this.store.selectedStudent();
    if (!student) return null;
    const config = this.config();
    const teacher = this.store.teacherOf(student);
    // Belegt sind die Zeiten im Kalender des Lehrers und die Einzeltermine der Person bei anderen Lehrern.
    const inCalendar = this.groups.calendarFilter(teacher);
    const busy = (a: Appointment) => inCalendar(a) || a.studentId === student.id;
    return this.calendar.nextFreeSlot(config.calendar, teacher, busy, this.clock.now());
  });

  constructor() {
    // Die Meldung zum vergebenen Termin gehört zur Person, bei der sie entstanden ist.
    effect(() => {
      this.store.selectedStudentId();
      this.slotMessage.set(null);
    });
  }

  protected valueOf(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  protected openImport(): void {
    this.importMessage.set(null);
    this.importOpen.set(true);
  }

  protected closeImport(result: string): void {
    this.importOpen.set(false);
    this.importMessage.set(result || null);
  }

  /**
   * Neue Personen gehören zum aktiven Lehrer; danach steht die Auswahl wieder auf dem Standardinstrument. Gibt es
   * die Person schon (gleicher Name, kein abweichendes Geburtsdatum), wird sie weiterverwendet, damit ihre früheren
   * Berichte sichtbar bleiben.
   */
  protected addStudent(nameInput: HTMLInputElement, birthInput: HTMLInputElement): void {
    const name = nameInput.value.trim();
    if (!name) return;
    const birthDate = birthInput.value || undefined;
    const entry = { name, birthDate, instrumentId: this.newStudentInstrumentId(), teacherId: this.activeTeacher.teacher().id };
    const result = this.store.addOrReuse(entry);
    this.importMessage.set(this.addedText(result, name));
    nameInput.value = '';
    birthInput.value = '';
    this.newStudentInstrumentId.set(this.defaultInstrumentId());
  }

  private addedText(result: 'created' | 'reused' | 'existing', name: string): string | null {
    const period = this.reportPeriod.period().name;
    const student = this.store.selectedStudent();
    // Bei einer vorhandenen Person ihr gespeicherter Name, nicht die Schreibweise der Eingabe
    const label = student ? this.store.label(student) : name;
    if (result === 'reused') {
      return `${label} gab es schon in einem anderen Berichtszeitraum und ist jetzt auch in „${period}“ – mit den bisherigen Stunden.`;
    }
    if (result === 'existing') return `${label} gibt es in „${period}“ schon.`;
    const twins = this.store.allStudents().filter((s) => s.name.trim().toLowerCase() === name.toLowerCase()).length;
    return twins > 1
      ? `${name} gibt es jetzt ${twins}-mal. Mit dem Geburtsdatum unterscheidest du gleichnamige Personen.`
      : null;
  }

  protected setBirthDate(student: Student, event: Event): void {
    this.store.setBirthDate(student.id, (event.target as HTMLInputElement).value);
  }

  /**
   * Personen des Zeitraums als CSV mit Name, Geburtsdatum, Instrument, Lehrer und Gruppen. Die Spalten erkennt der Import; im
   * nächsten Zeitraum übernimmt er die Personen und legt die benannten Gruppen ohne Mitglieder an.
   */
  protected async exportStudents(): Promise<void> {
    const rows = this.store.sortedStudents().map((student) => [
      student.name,
      student.birthDate ? formatShortDate(student.birthDate) : '',
      this.instrumentOf(student).name,
      this.teacherOf(student).name,
      this.groups.groupsOf(student.id).map((group) => group.name.trim()).filter(Boolean).join(', '),
    ]);
    const header = ['Name', 'Geburtsdatum', 'Instrument', 'Lehrer', 'Gruppen'];
    await saveFile(`Personen_${safeFileName(this.reportPeriod.period().name)}.csv`, csvBlob([header, ...rows]));
  }

  protected resetFilters(): void {
    this.teacherFilter.set(null);
    this.search.set('');
    this.instrumentFilter.set('');
    this.groupFilter.set('');
    this.statusFilter.set('');
    this.periodFilter.set('');
  }

  /** Zur Erfassung der Stunden dieser Person */
  protected openLessons(student: Student): void {
    this.store.selectStudent(student.id);
    this.router.navigate(['/stunden']);
  }

  /** Gruppen und ihre Mitglieder verwaltest du unter „Stunden erfassen“. */
  protected openGroup(group: Group): void {
    this.groups.select(group.id);
    this.router.navigate(['/stunden']);
  }

  /** z. B. „Gruppe Chor“ oder „Gruppen Chor, Streicher“; leer, wenn die Person in keiner Gruppe ist */
  protected groupsLineOf(student: Student): string {
    const names = this.groups.groupsOf(student.id).map((group) => this.groupName(group));
    if (names.length === 0) return '';
    return `${names.length === 1 ? 'Gruppe' : 'Gruppen'} ${names.join(', ')}`;
  }

  protected groupName(group: Group): string {
    return groupLabel(group, this.store.students());
  }

  /** Zeiträume der Person mit ihrem Lehrer dort */
  protected periodsOf(student: Student): { id: string; name: string; teacher: string; current: boolean }[] {
    const current = this.reportPeriod.period().id;
    return this.periodsByStart()
      .filter((period) => isActiveIn(student, period.id))
      .map((period) => ({
        id: period.id,
        name: period.name,
        teacher: teacherOf(student, this.config(), period.id).name,
        current: period.id === current,
      }));
  }

  protected readonly formatShortDate = formatShortDate;

  // --- Doppelte Personen ---

  /** z. B. „Anna Berg (geb. 03.05.2015) · Klavier · 12 Stunden“ */
  protected duplicateText(student: Student): string {
    const count = student.lessons.length === 1 ? '1 Stunde' : `${student.lessons.length} Stunden`;
    return `${this.store.label(student)} · ${this.instrumentOf(student).name} · ${count}`;
  }

  protected mergeDuplicate({ keep, drop }: DuplicatePair): void {
    const text =
      `${this.store.label(drop)} in ${this.store.label(keep)} aufgehen lassen? Stunden, Termine, Gruppen und ` +
      'Berichtszeiträume beider Einträge gehören dann zu einer Person.';
    if (confirm(text)) this.merger.merge(keep.id, drop.id);
  }

  /** Andere Personen, die man von Hand mit dieser zusammenführen kann, nach Namen sortiert */
  protected mergeCandidates(student: Student): Student[] {
    return this.store
      .allStudents()
      .filter((s) => s.id !== student.id)
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  /** Die gewählte Person geht in der angezeigten auf; diese behält Name und ID. */
  protected mergeManually(student: Student, select: HTMLSelectElement): void {
    const drop = this.store.allStudents().find((s) => s.id === select.value);
    select.value = '';
    if (!drop) return;
    const text =
      `${this.store.label(drop)} in ${this.store.label(student)} aufgehen lassen? Das lässt sich nicht rückgängig ` +
      'machen; Stunden, Termine, Gruppen und Berichtszeiträume gehören dann zu einer Person.';
    if (confirm(text)) this.merger.merge(student.id, drop.id);
  }

  /** Für die Liste, z. B. „2. Halbjahr 25/26, 1. Halbjahr 26/27“; leer bei nur einem Zeitraum */
  protected periodsLineOf(student: Student): string {
    if (this.periodsByStart().length < 2) return '';
    return this.periodsOf(student).map((p) => p.name).join(', ') || 'in keinem Berichtszeitraum';
  }

  protected isActive(student: Student): boolean {
    return isActiveIn(student, this.reportPeriod.period().id);
  }

  /** Nimmt die Person mit ihrem bisherigen Lehrer in den gewählten Zeitraum auf. */
  protected adoptToPeriod(student: Student): void {
    this.store.addToPeriod([{ studentId: student.id, teacherId: this.teacherOf(student).id }]);
  }

  protected leavePeriod(student: Student): void {
    const period = this.reportPeriod.period().name;
    const text =
      `${student.name} aus „${period}“ entfernen? Die Person ist dort dann inaktiv und in keiner Gruppe dieses ` +
      'Zeitraums mehr; Stunden und Termine bleiben erhalten, und du kannst sie später wieder übernehmen.';
    if (confirm(text)) this.groups.leavePeriod(student.id);
  }

  /** Mit dem Lehrer wechseln auch die Termine der Person in dessen Kalender. */
  protected setTeacher(student: Student, event: Event): void {
    this.store.setTeacher(student.id, (event.target as HTMLSelectElement).value);
  }

  protected instrumentOf(student: Student): Instrument {
    return instrumentOf(student, this.config());
  }

  protected teacherOf(student: Student): Teacher {
    return this.store.teacherOf(student);
  }

  protected renameStudent(student: Student, event: Event): void {
    const name = (event.target as HTMLInputElement).value.trim();
    if (name) this.store.renameStudent(student.id, name);
  }

  /** z. B. „12 Stunden, zuletzt am Di., 03.11.2026“ */
  protected lessonSummary(student: Student): string {
    const latest = sortedLessons(student).at(-1);
    if (!latest) return 'noch keine Stunden';
    const count = student.lessons.length === 1 ? '1 Stunde' : `${student.lessons.length} Stunden`;
    return `${count}, zuletzt am ${formatDate(latest.date)}`;
  }

  /** Warnung nur in der App; die Exporte kennen sie nicht. */
  protected hasDoubleLessons(student: Student): boolean {
    return doubleLessonDates(student).size > 0;
  }

  /** Trägt die Person in den angezeigten nächsten freien Slot ein; danach zeigt der Hinweis den folgenden. */
  protected placeInSlot(student: Student, slot: FreeSlot): void {
    this.calendar.add({ ...slot, studentId: student.id });
    this.slotMessage.set(`Eingetragen: ${slotText(slot)}.`);
  }

  protected removeStudent(student: Student): void {
    if (confirm(`${student.name} mit allen Unterrichtsstunden und Terminen löschen?`)) {
      this.store.removeStudent(student.id);
      this.calendar.removeForOwner(student.id);
      this.groups.removeMember(student.id);
    }
  }

  /** Prüfung für den Statusfilter; die Termindaten werden einmal je Filterlauf bestimmt. */
  private statusMatcher(status: Exclude<StatusFilter, ''>): (student: Student) => boolean {
    if (status === 'noLessonInPeriod') return (student) => this.reportPeriod.lessonsOf(student).length === 0;
    const appointments = this.calendar.appointments();
    if (status === 'noWeekly') {
      const running = new Set(appointments.filter((a) => a.studentId && isRunningSeries(a, today())).map((a) => a.studentId));
      return (student) => !running.has(student.id);
    }
    // Termin heute: eigener Termin oder Termin einer Gruppe, in der die Person ist
    const date = today();
    const groups = this.groups.groups();
    const withAppointment = new Set(
      this.calendar.occurrences(date, date).flatMap(({ appointment: a }) =>
        a.studentId ? [a.studentId] : (groups.find((g) => g.id === a.groupId)?.memberIds ?? []),
      ),
    );
    return (student) => withAppointment.has(student.id);
  }
}
