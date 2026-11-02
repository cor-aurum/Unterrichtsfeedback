import { computed, Injectable } from '@angular/core';
import { Lesson, lessonAt, newId, Student, today } from './model';
import { storedSignal } from './stored-signal';

@Injectable({ providedIn: 'root' })
export class StudentsStore {
  readonly students = storedSignal<Student[]>('feedback.students', () => [], parseStudents);
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

  addStudent(name: string, instrumentId: string | null, teacherId: string | null): void {
    const student: Student = { id: newId(), name, instrumentId, teacherId, generalTexts: {}, lessons: [] };
    this.students.update((students) => [...students, student]);
    this.selectStudent(student.id);
  }

  renameStudent(studentId: string, name: string): void {
    this.mutateStudent(studentId, (student) => (student.name = name));
  }

  setTeacher(studentId: string, teacherId: string): void {
    this.mutateStudent(studentId, (student) => (student.teacherId = teacherId));
  }

  setInstrument(studentId: string, instrumentId: string | null): void {
    this.mutateStudent(studentId, (student) => (student.instrumentId = instrumentId));
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

  /**
   * Wählt die Person und ihre Stunde zu einem Termin aus; gibt es noch keine, wird sie mit Datum und
   * Uhrzeit des Termins angelegt. Einer vorhandenen Stunde ohne Uhrzeit wird die des Termins ergänzt.
   */
  openLesson(studentId: string, date: string, time?: { start: string; durationMinutes: number }): void {
    this.selectStudent(studentId);
    const student = this.selectedStudent();
    if (!student) return;
    const existing = lessonAt(student, date, time?.start);
    if (existing) {
      if (time && !existing.start) this.mutateLesson(studentId, existing.id, (lesson) => Object.assign(lesson, time));
      this.selectedLessonId.set(existing.id);
      return;
    }
    const lesson: Lesson = { id: newId(), date, ...time, checked: {}, texts: {} };
    this.mutateStudent(studentId, (s) => s.lessons.push(lesson));
    this.selectedLessonId.set(lesson.id);
  }

  /** Ohne `start` hat die Stunde keine Uhrzeit mehr; die Länge gilt nur zusammen mit dem Beginn. */
  setLessonStart(studentId: string, lessonId: string, start: string): void {
    this.mutateLesson(studentId, lessonId, (lesson) => {
      if (start) {
        lesson.start = start;
      } else {
        delete lesson.start;
        delete lesson.durationMinutes;
      }
    });
  }

  /** Aus dem Kalender: Datum, Beginn und Dauer der Stunde ändern sich mit ihrem Termin. */
  setLessonTime(
    studentId: string,
    lessonId: string,
    time: { date: string; start: string; durationMinutes: number },
  ): void {
    this.mutateLesson(studentId, lessonId, (lesson) => Object.assign(lesson, {
      date: time.date,
      start: time.start,
      durationMinutes: time.durationMinutes,
    }));
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

  /** Entfernt einen Textbaustein aus mehreren Stunden, z. B. aus allen im Berichtszeitraum. */
  uncheckItem(studentId: string, lessonIds: string[], sectionId: string, itemId: string): void {
    this.mutateStudent(studentId, (student) => {
      for (const lesson of student.lessons.filter((l) => lessonIds.includes(l.id))) {
        lesson.checked[sectionId] = (lesson.checked[sectionId] ?? []).filter((id) => id !== itemId);
      }
    });
  }

  setText(studentId: string, lessonId: string, sectionId: string, text: string): void {
    this.mutateLesson(studentId, lessonId, (lesson) => (lesson.texts[sectionId] = text));
  }

  setGeneralText(studentId: string, sectionId: string, text: string): void {
    this.mutateStudent(studentId, (student) => (student.generalTexts[sectionId] = text));
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
      instrumentId: typeof student.instrumentId === 'string' ? student.instrumentId : null,
      teacherId: typeof student.teacherId === 'string' ? student.teacherId : null,
      // Ältere Daten haben noch keine allgemeinen Freitexte.
      generalTexts: isRecord(student.generalTexts) ? student.generalTexts : {},
      lessons: student.lessons.map(parseLesson),
    };
  });
}

export function parseLesson(lesson: Partial<Lesson>): Lesson {
  if (typeof lesson?.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(lesson.date)) {
    throw new Error('Eine Unterrichtsstunde hat kein gültiges Datum.');
  }
  const start = typeof lesson.start === 'string' && /^\d{2}:\d{2}$/.test(lesson.start) ? lesson.start : undefined;
  const durationMinutes = start && Number(lesson.durationMinutes) > 0 ? Number(lesson.durationMinutes) : undefined;
  return {
    id: typeof lesson.id === 'string' ? lesson.id : newId(),
    date: lesson.date,
    ...(start ? { start } : {}),
    ...(durationMinutes ? { durationMinutes } : {}),
    checked: isRecord(lesson.checked) ? lesson.checked : {},
    texts: isRecord(lesson.texts) ? lesson.texts : {},
  };
}

export function isRecord<T>(value: Record<string, T> | undefined): value is Record<string, T> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sortedLessons(owner: { lessons: Lesson[] }): Lesson[] {
  return [...owner.lessons].sort(
    (a, b) => a.date.localeCompare(b.date) || (a.start ?? '').localeCompare(b.start ?? ''),
  );
}
