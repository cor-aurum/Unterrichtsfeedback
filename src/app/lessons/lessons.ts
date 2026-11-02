import { Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FreeSlot, slotText } from '../calendar/appointments';
import { CalendarStore } from '../calendar/calendar.store';
import { Clock } from '../calendar/clock';
import { QuickStart } from '../calendar/quick-start';
import { ActiveTeacher } from '../active-teacher';
import { GroupList } from '../groups/group-list';
import { GroupPanel } from '../groups/group-panel';
import { GroupsStore } from '../groups.store';
import { ConfigStore } from '../config.store';
import { ReportPeriod } from '../report-period';
import {
  defaultInstrument,
  doubleLessonDates,
  formatDate,
  Instrument,
  instrumentOf,
  Lesson,
  lessonTime,
  PLACEHOLDERS,
  Section,
  Student,
  Teacher,
  teacherOf,
} from '../model';
import { sortedLessons, StudentsStore } from '../students.store';

@Component({
  selector: 'app-lessons',
  imports: [RouterLink, QuickStart, GroupList, GroupPanel],
  templateUrl: './lessons.html',
  styleUrl: './lessons.scss',
})
export class Lessons {
  protected readonly store = inject(StudentsStore);
  protected readonly groups = inject(GroupsStore);
  private readonly configStore = inject(ConfigStore);
  protected readonly config = this.configStore.config;
  private readonly calendar = inject(CalendarStore);
  private readonly clock = inject(Clock);
  private readonly activeTeacher = inject(ActiveTeacher);
  protected readonly reportPeriod = inject(ReportPeriod);
  protected readonly slotMessage = signal<string | null>(null);
  protected readonly formatDate = formatDate;
  protected readonly lessonTime = lessonTime;
  protected readonly placeholderHint = 'Platzhalter: ' + PLACEHOLDERS.map((p) => p.key).join(', ');
  protected readonly defaultInstrumentId = computed(() => defaultInstrument(this.config()).id);

  protected readonly lessonsOfSelected = computed(() => {
    const student = this.store.selectedStudent();
    return student ? sortedLessons(student).reverse() : [];
  });

  /**
   * Nächster freier Slot im Kalender des Lehrers der ausgewählten Person; aktualisiert sich mit der
   * Uhrzeit und neuen Terminen.
   */
  protected readonly nextSlot = computed(() => {
    const student = this.store.selectedStudent();
    if (!student) return null;
    const config = this.config();
    const teacher = teacherOf(student, config);
    return this.calendar.nextFreeSlot(config.calendar, teacher, this.groups.calendarOwnerIds(teacher), this.clock.now());
  });
  protected readonly slotText = slotText;
  protected readonly teachers = computed(() => this.config().teachers);

  constructor() {
    // Die Meldung zum vergebenen Termin gehört zur Person, bei der sie entstanden ist.
    effect(() => {
      this.store.selectedStudentId();
      this.slotMessage.set(null);
    });
  }

  /** Neue Personen gehören zum aktiven Lehrer; danach steht die Auswahl wieder auf dem Standardinstrument. */
  protected addStudent(nameInput: HTMLInputElement, instrumentSelect: HTMLSelectElement): void {
    const name = nameInput.value.trim();
    if (!name) return;
    this.store.addStudent(name, instrumentSelect.value, this.activeTeacher.teacher().id);
    nameInput.value = '';
    instrumentSelect.value = this.defaultInstrumentId();
  }

  protected setInstrument(student: Student, event: Event): void {
    this.store.setInstrument(student.id, (event.target as HTMLSelectElement).value);
  }

  /** Mit dem Lehrer wechseln auch die Termine der Person in dessen Kalender. */
  protected setTeacher(student: Student, event: Event): void {
    this.store.setTeacher(student.id, (event.target as HTMLSelectElement).value);
  }

  protected instrumentOf(student: Student): Instrument {
    return instrumentOf(student, this.config());
  }

  protected teacherOf(student: Student): Teacher {
    return teacherOf(student, this.config());
  }

  protected renameStudent(student: Student, event: Event): void {
    const name = (event.target as HTMLInputElement).value.trim();
    if (name) this.store.renameStudent(student.id, name);
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

  protected removeLesson(student: Student, lesson: Lesson): void {
    if (confirm(`Unterrichtsstunde vom ${formatDate(lesson.date)} löschen?`)) {
      this.store.removeLesson(student.id, lesson.id);
    }
  }

  protected setDate(student: Student, lesson: Lesson, event: Event): void {
    const date = (event.target as HTMLInputElement).value;
    if (date) this.store.setLessonDate(student.id, lesson.id, date);
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
