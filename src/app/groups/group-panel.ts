import { Component, computed, inject, input } from '@angular/core';
import { ActiveTeacher } from '../active-teacher';
import { StudentLabelPipe } from '../student-label.pipe';
import { RouterLink } from '@angular/router';
import { CalendarStore } from '../calendar/calendar.store';
import { Clock } from '../calendar/clock';
import { lessonStartAt } from '../calendar/lesson-start';
import { ConfigStore } from '../config.store';
import { GroupsStore } from '../groups.store';
import {
  configForTeacher,
  formatDate,
  Group,
  GROUP_PLACEHOLDERS,
  groupLabel,
  groupTeacherOf,
  isTeachingDay,
  Lesson,
  lessonTime,
  memberNames,
  NO_TEACHING_TEXT,
  Section,
  Student,
  today,
} from '../model';
import { ReportPeriod } from '../report-period';
import { sortedLessons, StudentsStore } from '../students.store';

/**
 * Bereich einer ausgewählten Gruppe unter „Stunden erfassen“: Gruppenstunden, Einstellungen und Mitglieder,
 * daneben das Erfassen einer Gruppenstunde mit den Gruppen-Abschnitten der Konfiguration.
 */
@Component({
  selector: 'app-group-panel',
  imports: [RouterLink, StudentLabelPipe],
  templateUrl: './group-panel.html',
  styleUrl: './groups.scss',
})
export class GroupPanel {
  readonly group = input.required<Group>();

  protected readonly store = inject(GroupsStore);
  private readonly studentsStore = inject(StudentsStore);
  private readonly configStore = inject(ConfigStore);
  private readonly calendar = inject(CalendarStore);
  private readonly clock = inject(Clock);
  private readonly reportPeriod = inject(ReportPeriod);
  protected readonly config = this.configStore.config;
  protected readonly formatDate = formatDate;
  protected readonly lessonTime = lessonTime;
  protected readonly placeholderHint = 'Platzhalter: ' + GROUP_PLACEHOLDERS.map((p) => p.key).join(', ');

  protected readonly label = computed(() => groupLabel(this.group(), this.studentsStore.students()));
  protected readonly members = computed(() => memberNames(this.group(), this.studentsStore.students()));
  protected readonly teachers = inject(ActiveTeacher).visibleTeachers;
  protected readonly groupTeacherId = computed(() => groupTeacherOf(this.group(), this.config()).id);
  protected readonly teacherName = computed(() => groupTeacherOf(this.group(), this.config()).name);
  /** Gemeinsame Gruppen-Abschnitte und die eigenen des Lehrers der Gruppe */
  protected readonly sections = computed(() => configForTeacher(this.config(), this.groupTeacherId()).groupSections);
  /** Lehrer des Zeitraums der Gruppe; ihr bisheriger bleibt wählbar */
  protected readonly groupTeachers = computed(() => this.reportPeriod.teachersWith(this.groupTeacherId()));
  protected readonly lessons = computed(() => sortedLessons(this.group()).reverse());

  /** Alle Personen, nach Lehrer gegliedert, zum Ankreuzen der Mitglieder */
  protected readonly candidates = computed(() => {
    const config = this.config();
    const students = this.studentsStore.sortedStudents();
    return config.teachers
      .map((teacher) => ({ teacher, students: students.filter((s) => this.studentsStore.teacherOf(s).id === teacher.id) }))
      .filter((entry) => entry.students.length > 0);
  });

  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  /** Weitere Gruppen der Person, z. B. „(auch in Chor)“ bei Mitgliedern, sonst „(in Chor)“ */
  protected otherGroupsText(student: Student): string {
    const names = this.store
      .groupsOf(student.id)
      .filter((group) => group.id !== this.group().id)
      .map((group) => groupLabel(group, this.studentsStore.students()));
    if (names.length === 0) return '';
    return `(${this.isMember(student) ? 'auch ' : ''}in ${names.join(', ')})`;
  }

  protected isMember(student: Student): boolean {
    return this.group().memberIds.includes(student.id);
  }

  protected entryCount(lesson: Lesson): number {
    const checked = Object.values(lesson.checked).reduce((sum, ids) => sum + ids.length, 0);
    return checked + Object.values(lesson.texts).filter((text) => text.trim()).length;
  }

  /** „+ Neue Gruppenstunde“: Stunde des gerade laufenden Gruppentermins öffnen oder anlegen, sonst gerundete Uhrzeit */
  protected startLesson(): void {
    const date = today();
    if (!this.reportPeriod.contains(date)) {
      alert(this.notInPeriodText(date));
      return;
    }
    const groupId = this.group().id;
    const occurrences = this.calendar.occurrences(date, date, (a) => a.groupId === groupId);
    const next = lessonStartAt(this.group(), date, occurrences, this.clock.now());
    if ('open' in next) {
      this.store.selectedLessonId.set(next.open.id);
    } else {
      this.store.openLesson(groupId, date, next.create);
    }
  }

  /** Gruppenstunden gibt es nur im Berichtszeitraum der Gruppe, dem gewählten. */
  private notInPeriodText(date: string): string {
    const period = this.reportPeriod.period();
    return isTeachingDay(this.config(), date)
      ? `Der ${formatDate(date)} liegt nicht im Berichtszeitraum „${period.name}“. Gruppen gelten nur für ihren Zeitraum.`
      : `Der ${formatDate(date)} ${NO_TEACHING_TEXT}`;
  }

  protected removeGroup(): void {
    if (confirm(`Gruppe „${this.label()}“ mit allen Gruppenstunden und Gruppenterminen löschen?`)) {
      this.store.remove(this.group().id);
    }
  }

  protected setDate(lesson: Lesson, event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.value && !this.store.setLessonDate(this.group().id, lesson.id, input.value)) {
      alert(this.notInPeriodText(input.value));
      input.value = lesson.date;
    }
  }

  protected setStart(lesson: Lesson, event: Event): void {
    this.store.setLessonStart(this.group().id, lesson.id, this.valueOf(event));
  }

  protected removeLesson(lesson: Lesson): void {
    if (confirm(`Gruppenstunde vom ${formatDate(lesson.date)} löschen?`)) {
      this.store.removeLesson(this.group().id, lesson.id);
    }
  }

  protected isChecked(lesson: Lesson, section: Section, itemId: string): boolean {
    return lesson.checked[section.id]?.includes(itemId) ?? false;
  }

  protected textOf(lesson: Lesson, section: Section): string {
    return lesson.texts[section.id] ?? '';
  }

  protected generalTextOf(section: Section): string {
    return this.group().generalTexts[section.id] ?? '';
  }

  /** Erweitert die Gruppen-Abschnitte um einen Textbaustein und hakt ihn in dieser Gruppenstunde gleich an. */
  protected addItem(lesson: Lesson, section: Section, input: HTMLInputElement): void {
    const text = input.value.trim();
    if (!text) return;
    const itemId = this.configStore.addItem(section.id, text);
    this.store.toggleItem(this.group().id, lesson.id, section.id, itemId);
    input.value = '';
  }
}
