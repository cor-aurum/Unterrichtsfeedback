import { computed, Injectable } from '@angular/core';
import { Lesson, newId, Student, today } from './model';
import { storedSignal } from './stored-signal';

@Injectable({ providedIn: 'root' })
export class StudentsStore {
  readonly students = storedSignal<Student[]>('feedback.students', () => []);
  readonly selectedStudentId = storedSignal<string | null>('feedback.selectedStudent', () => null);
  readonly selectedLessonId = storedSignal<string | null>('feedback.selectedLesson', () => null);

  readonly sortedStudents = computed(() =>
    [...this.students()].sort((a, b) => a.name.localeCompare(b.name, 'de')),
  );
  readonly selectedStudent = computed(() =>
    this.students().find((s) => s.id === this.selectedStudentId()),
  );
  readonly selectedLesson = computed(() =>
    this.selectedStudent()?.lessons.find((l) => l.id === this.selectedLessonId()),
  );

  addStudent(name: string): void {
    const student: Student = { id: newId(), name, lessons: [] };
    this.students.update((students) => [...students, student]);
    this.selectStudent(student.id);
  }

  renameStudent(studentId: string, name: string): void {
    this.mutateStudent(studentId, (student) => (student.name = name));
  }

  removeStudent(studentId: string): void {
    this.students.update((students) => students.filter((s) => s.id !== studentId));
    if (this.selectedStudentId() === studentId) this.selectStudent(null);
  }

  selectStudent(studentId: string | null): void {
    this.selectedStudentId.set(studentId);
    const lessons = this.selectedStudent()?.lessons ?? [];
    this.selectedLessonId.set(lessons.at(-1)?.id ?? null);
  }

  addLesson(studentId: string): void {
    const lesson: Lesson = { id: newId(), date: today(), checked: {}, texts: {} };
    this.mutateStudent(studentId, (student) => student.lessons.push(lesson));
    this.selectedLessonId.set(lesson.id);
  }

  removeLesson(studentId: string, lessonId: string): void {
    this.mutateStudent(studentId, (student) => (student.lessons = student.lessons.filter((l) => l.id !== lessonId)));
    if (this.selectedLessonId() === lessonId) this.selectedLessonId.set(null);
  }

  setLessonDate(studentId: string, lessonId: string, date: string): void {
    this.mutateLesson(studentId, lessonId, (lesson) => (lesson.date = date));
  }

  toggleItem(studentId: string, lessonId: string, sectionId: string, itemId: string): void {
    this.mutateLesson(studentId, lessonId, (lesson) => {
      const checked = lesson.checked[sectionId] ?? [];
      lesson.checked[sectionId] = checked.includes(itemId)
        ? checked.filter((id) => id !== itemId)
        : [...checked, itemId];
    });
  }

  setText(studentId: string, lessonId: string, sectionId: string, text: string): void {
    this.mutateLesson(studentId, lessonId, (lesson) => (lesson.texts[sectionId] = text));
  }

  private mutateLesson(studentId: string, lessonId: string, change: (lesson: Lesson) => void): void {
    this.mutateStudent(studentId, (student) => {
      const lesson = student.lessons.find((l) => l.id === lessonId);
      if (lesson) change(lesson);
    });
  }

  private mutateStudent(studentId: string, change: (student: Student) => void): void {
    this.students.update((students) =>
      students.map((student) => {
        if (student.id !== studentId) return student;
        const copy = structuredClone(student);
        change(copy);
        return copy;
      }),
    );
  }
}

export function parseStudents(data: unknown): Student[] {
  if (!Array.isArray(data)) {
    throw new Error('Die Datei enthält keine Personen.');
  }
  return data.map((student: Partial<Student>) => {
    if (typeof student?.name !== 'string' || !Array.isArray(student.lessons)) {
      throw new Error('Eine Person hat keinen Namen oder keine Stundenliste.');
    }
    return {
      id: typeof student.id === 'string' ? student.id : newId(),
      name: student.name,
      lessons: student.lessons.map(parseLesson),
    };
  });
}

function parseLesson(lesson: Partial<Lesson>): Lesson {
  if (typeof lesson?.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(lesson.date)) {
    throw new Error('Eine Unterrichtsstunde hat kein gültiges Datum.');
  }
  return {
    id: typeof lesson.id === 'string' ? lesson.id : newId(),
    date: lesson.date,
    checked: isRecord(lesson.checked) ? lesson.checked : {},
    texts: isRecord(lesson.texts) ? lesson.texts : {},
  };
}

function isRecord<T>(value: Record<string, T> | undefined): value is Record<string, T> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sortedLessons(student: Student): Lesson[] {
  return [...student.lessons].sort((a, b) => a.date.localeCompare(b.date));
}
