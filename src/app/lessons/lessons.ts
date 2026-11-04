import { Component, computed, effect, inject, signal } from '@angular/core';
import { StudentLabelPipe } from '../student-label.pipe';
import { RouterLink } from '@angular/router';
import { CalendarStore } from '../calendar/calendar.store';
import { lessonStartAt } from '../calendar/lesson-start';
import { Clock } from '../calendar/clock';
import { QuickStart } from '../calendar/quick-start';
import { GroupList } from '../groups/group-list';
import { GroupPanel } from '../groups/group-panel';
import { GroupsStore } from '../groups.store';
import { TeacherFilter } from '../teacher-filter';
import { ConfigStore } from '../config.store';
import { ReportPeriod } from '../report-period';
import {
  doubleLessonDates,
  formatDate,
  Group,
  groupLabel,
  Instrument,
  instrumentOf,
  isTeachingDay,
  Lesson,
  lessonTime,
  NO_TEACHING_TEXT,
  PLACEHOLDERS,
  Section,
  Student,
  Teacher,
  today,
  isActiveIn,
} from '../model';
import { sortedLessons, StudentsStore } from '../students.store';

@Component({
  selector: 'app-lessons',
  imports: [RouterLink, QuickStart, GroupList, GroupPanel, StudentLabelPipe],
  templateUrl: './lessons.html',
  styleUrl: './lessons.scss',
})
export class Lessons {
  protected readonly store = inject(StudentsStore);
  protected readonly groups = inject(GroupsStore);
  protected readonly teacherFilter = inject(TeacherFilter);
  /** Suche in der Personenliste; mehr Filter gibt es unter „Personen“. */
  protected readonly search = signal('');
  /** Personen des gewählten Berichtszeitraums, die zu Suche und Lehrerfilter passen */
  protected readonly visibleStudents = computed(() => {
    const search = this.search().trim().toLowerCase();
    return this.store
      .sortedStudents()
      .filter((student) => this.teacherFilter.shows(this.store.teacherOf(student).id))
      .filter((student) => !search || student.name.toLowerCase().includes(search));
  });
  private readonly configStore = inject(ConfigStore);
  protected readonly config = this.configStore.config;
  private readonly calendar = inject(CalendarStore);
  private readonly clock = inject(Clock);
  protected readonly reportPeriod = inject(ReportPeriod);
  /** Hinweis, warum keine neue Stunde angelegt wurde */
  protected readonly lessonMessage = signal<string | null>(null);
  protected readonly formatDate = formatDate;
  protected readonly lessonTime = lessonTime;
  protected readonly placeholderHint = 'Platzhalter: ' + PLACEHOLDERS.map((p) => p.key).join(', ');

  protected readonly lessonsOfSelected = computed(() => {
    const student = this.store.selectedStudent();
    return student ? sortedLessons(student).reverse() : [];
  });

  protected readonly teachers = computed(() => this.config().teachers);

  constructor() {
    // Der Hinweis gehört zur Person, bei der er entstanden ist.
    effect(() => {
      this.store.selectedStudentId();
      this.lessonMessage.set(null);
    });
  }

  /** Stunden gibt es nur im gewählten Berichtszeitraum. */
  private notInPeriodText(date: string): string {
    const period = this.reportPeriod.period();
    return isTeachingDay(this.config(), date)
      ? `Der ${formatDate(date)} liegt nicht im Berichtszeitraum „${period.name}“ (${formatDate(period.from)} – ${formatDate(period.to)}). Stunden gibt es nur im gewählten Zeitraum.`
      : `Der ${formatDate(date)} ${NO_TEACHING_TEXT}`;
  }

  protected valueOf(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  protected groupName(group: Group): string {
    return groupLabel(group, this.store.students());
  }

  protected isActive(student: Student): boolean {
    return isActiveIn(student, this.reportPeriod.period().id);
  }

  /** Nimmt die Person mit ihrem bisherigen Lehrer in den gewählten Zeitraum auf. */
  protected adoptToPeriod(student: Student): void {
    this.store.addToPeriod([{ studentId: student.id, teacherId: this.teacherOf(student).id }]);
  }

  /**
   * „+ Neue Stunde“: Läuft laut Kalender gerade ein Termin der Person (±10 Minuten), öffnet sich dessen Stunde
   * oder entsteht mit Beginn und Dauer des Termins; sonst beginnt sie zur aktuellen Uhrzeit, gerundet auf 10 Minuten.
   */
  protected startLesson(student: Student): void {
    const date = today();
    if (!this.store.canHaveLesson(student, date)) {
      this.lessonMessage.set(this.notInPeriodText(date));
      return;
    }
    const occurrences = this.calendar.occurrences(date, date, (a) => a.studentId === student.id);
    const next = lessonStartAt(student, date, occurrences, this.clock.now());
    if ('open' in next) {
      this.store.selectedLessonId.set(next.open.id);
    } else {
      this.store.openLesson(student.id, date, next.create);
    }
  }

  protected instrumentOf(student: Student): Instrument {
    return instrumentOf(student, this.config());
  }

  protected teacherOf(student: Student): Teacher {
    return this.store.teacherOf(student);
  }

  protected removeLesson(student: Student, lesson: Lesson): void {
    if (confirm(`Unterrichtsstunde vom ${formatDate(lesson.date)} löschen?`)) {
      this.store.removeLesson(student.id, lesson.id);
    }
  }

  protected setDate(student: Student, lesson: Lesson, event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.value && !this.store.setLessonDate(student.id, lesson.id, input.value)) {
      alert(this.notInPeriodText(input.value));
      input.value = lesson.date;
    }
  }

  protected setStart(student: Student, lesson: Lesson, event: Event): void {
    this.store.setLessonStart(student.id, lesson.id, (event.target as HTMLInputElement).value);
  }

  protected setText(student: Student, lesson: Lesson, sectionId: string, event: Event): void {
    this.store.setText(student.id, lesson.id, sectionId, (event.target as HTMLTextAreaElement).value);
  }

  protected setGeneralText(student: Student, sectionId: string, event: Event): void {
    this.store.setGeneralText(student.id, sectionId, (event.target as HTMLTextAreaElement).value);
  }

  protected generalTextOf(student: Student, sectionId: string): string {
    return student.generalTexts[sectionId] ?? '';
  }

  protected textOf(lesson: Lesson, sectionId: string): string {
    return lesson.texts[sectionId] ?? '';
  }

  protected isChecked(lesson: Lesson, sectionId: string, itemId: string): boolean {
    return lesson.checked[sectionId]?.includes(itemId) ?? false;
  }

  /**
   * Stunden, für die die Haken im allgemeinen Teil gelten: alle im Berichtszeitraum, oder nur die Stunde
   * selbst, wenn sie außerhalb liegt.
   */
  protected generalLessons(student: Student, lesson: Lesson): Lesson[] {
    return this.reportPeriod.contains(lesson.date) ? this.reportPeriod.lessonsOf(student) : [lesson];
  }

  protected isGeneralChecked(student: Student, lesson: Lesson, sectionId: string, itemId: string): boolean {
    return this.generalLessons(student, lesson).some((l) => this.isChecked(l, sectionId, itemId));
  }

  /** Anhaken gilt für diese Stunde, Entfernen für alle Stunden, für die der allgemeine Teil gilt. */
  protected toggleGeneralItem(student: Student, lesson: Lesson, sectionId: string, itemId: string): void {
    if (this.isGeneralChecked(student, lesson, sectionId, itemId)) {
      const lessonIds = this.generalLessons(student, lesson).map((l) => l.id);
      this.store.uncheckItem(student.id, lessonIds, sectionId, itemId);
    } else {
      this.store.toggleItem(student.id, lesson.id, sectionId, itemId);
    }
  }

  /** Daten der anderen Stunden, in denen der Textbaustein angehakt ist, neueste zuerst */
  protected checkedElsewhere(lessons: Lesson[], lesson: Lesson, sectionId: string, itemId: string): string {
    return this.otherLessons(lessons, lesson)
      .filter((other) => this.isChecked(other, sectionId, itemId))
      .map((other) => formatDate(other.date))
      .join(', ');
  }

  /** Freitexte desselben Abschnitts aus den anderen Stunden, neueste zuerst */
  protected textsElsewhere(student: Student, lesson: Lesson, sectionId: string): { date: string; text: string }[] {
    return this.otherLessons(student.lessons, lesson)
      .filter((other) => this.textOf(other, sectionId).trim())
      .map((other) => ({ date: formatDate(other.date), text: this.textOf(other, sectionId) }));
  }

  private otherLessons(lessons: Lesson[], lesson: Lesson): Lesson[] {
    return lessons
      .filter((other) => other.id !== lesson.id)
      .sort((a, b) => b.date.localeCompare(a.date) || (b.start ?? '').localeCompare(a.start ?? ''));
  }

  /** Warnung nur in der App; die Exporte kennen sie nicht. */
  protected hasDoubleLessons(student: Student): boolean {
    return doubleLessonDates(student).size > 0;
  }

  protected isDoubleLesson(student: Student, lesson: Lesson): boolean {
    return doubleLessonDates(student).has(lesson.date);
  }

  /** Erweitert die Konfiguration um einen Textbaustein und hakt ihn in dieser Stunde gleich an. */
  protected addItem(student: Student, lesson: Lesson, section: Section, input: HTMLInputElement): void {
    const text = input.value.trim();
    if (!text) return;
    const itemId = this.configStore.addItem(section.id, text);
    this.store.toggleItem(student.id, lesson.id, section.id, itemId);
    input.value = '';
  }

  protected entryCount(lesson: Lesson): number {
    const checked = Object.values(lesson.checked).reduce((sum, ids) => sum + ids.length, 0);
    const texts = Object.values(lesson.texts).filter((text) => text.trim()).length;
    return checked + texts;
  }
}
