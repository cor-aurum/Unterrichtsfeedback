import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ConfigStore } from '../config.store';
import { defaultInstrument, formatDate, Instrument, instrumentOf, Lesson, PLACEHOLDERS, Student } from '../model';
import { sortedLessons, StudentsStore } from '../students.store';

@Component({
  selector: 'app-lessons',
  imports: [RouterLink],
  templateUrl: './lessons.html',
  styleUrl: './lessons.scss',
})
export class Lessons {
  protected readonly store = inject(StudentsStore);
  protected readonly config = inject(ConfigStore).config;
  protected readonly formatDate = formatDate;
  protected readonly placeholderHint = 'Platzhalter: ' + PLACEHOLDERS.map((p) => p.key).join(', ');
  protected readonly defaultInstrumentId = computed(() => defaultInstrument(this.config()).id);

  protected readonly lessonsOfSelected = computed(() => {
    const student = this.store.selectedStudent();
    return student ? sortedLessons(student).reverse() : [];
  });

  /** Nach dem Anlegen steht die Auswahl wieder auf dem Standardinstrument. */
  protected addStudent(nameInput: HTMLInputElement, instrumentSelect: HTMLSelectElement): void {
    const name = nameInput.value.trim();
    if (!name) return;
    this.store.addStudent(name, instrumentSelect.value);
    nameInput.value = '';
    instrumentSelect.value = this.defaultInstrumentId();
  }

  protected setInstrument(student: Student, event: Event): void {
    this.store.setInstrument(student.id, (event.target as HTMLSelectElement).value);
  }

  protected instrumentOf(student: Student): Instrument {
    return instrumentOf(student, this.config());
  }

  protected renameStudent(student: Student, event: Event): void {
    const name = (event.target as HTMLInputElement).value.trim();
    if (name) this.store.renameStudent(student.id, name);
  }

  protected removeStudent(student: Student): void {
    if (confirm(`${student.name} mit allen Unterrichtsstunden löschen?`)) {
      this.store.removeStudent(student.id);
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

  protected checkedInOtherLesson(student: Student, lesson: Lesson, sectionId: string, itemId: string): boolean {
    return student.lessons.some((other) => other.id !== lesson.id && this.isChecked(other, sectionId, itemId));
  }

  protected entryCount(lesson: Lesson): number {
    const checked = Object.values(lesson.checked).reduce((sum, ids) => sum + ids.length, 0);
    const texts = Object.values(lesson.texts).filter((text) => text.trim()).length;
    return checked + texts;
  }
}
