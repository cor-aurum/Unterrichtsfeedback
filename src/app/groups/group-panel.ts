import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CalendarStore } from '../calendar/calendar.store';
import { Clock } from '../calendar/clock';
import { lessonStartAt } from '../calendar/lesson-start';
import { ConfigStore } from '../config.store';
import { GroupsStore } from '../groups.store';
import {
  formatDate,
  GROUP_PLACEHOLDERS,
  Group,
  groupLabel,
  groupTeacherOf,
  Lesson,
  lessonTime,
  memberNames,
  Section,
  Student,
  teacherOf,
  today,
} from '../model';
import { sortedLessons, StudentsStore } from '../students.store';

/**
 * Bereich einer ausgewählten Gruppe unter „Stunden erfassen“: Gruppenstunden, Einstellungen und Mitglieder,
 * daneben das Erfassen einer Gruppenstunde mit den Gruppen-Abschnitten der Konfiguration.
 */
@Component({
  selector: 'app-group-panel',
  imports: [RouterLink],
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
  protected readonly config = this.configStore.config;
  protected readonly formatDate = formatDate;
  protected readonly lessonTime = lessonTime;
  protected readonly placeholderHint = 'Platzhalter: ' + GROUP_PLACEHOLDERS.map((p) => p.key).join(', ');

  protected readonly label = computed(() => groupLabel(this.group(), this.studentsStore.students()));
  protected readonly members = computed(() => memberNames(this.group(), this.studentsStore.students()));
  protected readonly teachers = computed(() => this.config().teachers);
  protected readonly groupTeacherId = computed(() => groupTeacherOf(this.group(), this.config()).id);
  protected readonly lessons = computed(() => sortedLessons(this.group()).reverse());

  /** Alle Personen, nach Lehrer gegliedert, zum Ankreuzen der Mitglieder */
  protected readonly candidates = computed(() => {
    const config = this.config();
    const students = this.studentsStore.sortedStudents();
    return config.teachers
      .map((teacher) => ({ teacher, students: students.filter((s) => teacherOf(s, config).id === teacher.id) }))
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
    const groupId = this.group().id;
    const occurrences = this.calendar.occurrences(date, date, (a) => a.groupId === groupId);
    const next = lessonStartAt(this.group(), date, occurrences, this.clock.now());
    if ('open' in next) {
      this.store.selectedLessonId.set(next.open.id);
    } else {
      this.store.openLesson(groupId, date, next.create);
    }
  }

  protected removeGroup(): void {
    if (confirm(`Gruppe „${this.label()}“ mit allen Gruppenstunden und Gruppenterminen löschen?`)) {
      this.store.remove(this.group().id);
    }
  }

  protected setDate(lesson: Lesson, event: Event): void {
    const date = this.valueOf(event);
    if (date) this.store.setLessonDate(this.group().id, lesson.id, date);
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
