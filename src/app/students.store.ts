import { computed, effect, inject, Injectable, untracked } from '@angular/core';
import { ConfigStore } from './config.store';
import { formatShortDate, isActiveIn, Lesson, lessonAt, newId, Student, Teacher, teacherOf, today } from './model';
import { samePerson } from './import/student-import';
import { ReportPeriod } from './report-period';
import { storedSignal } from './stored-signal';

/** Angaben für eine neue Person; der Lehrer gilt im gewählten Berichtszeitraum. */
export interface NewStudent {
  name: string;
  instrumentId: string | null;
  teacherId: string | null;
  birthDate?: string;
}

/**
 * Personen und ihre Stunden. Gespeichert sind alle Personen; `students` sind die im gewählten Berichtszeitraum
 * aktiven, nur sie erscheinen in Listen, Kalender und Export.
 */
@Injectable({ providedIn: 'root' })
export class StudentsStore {
  private readonly reportPeriod = inject(ReportPeriod);
  private readonly config = inject(ConfigStore).config;
  private readonly periodId = computed(() => this.reportPeriod.period().id);

  /** Alle Personen aller Zeiträume, z. B. für Sicherung und Synchronisation */
  readonly allStudents = storedSignal<Student[]>('feedback.students', () => [], parseStudents);
  readonly students = computed(() => this.allStudents().filter((student) => isActiveIn(student, this.periodId())));
  readonly selectedStudentId = storedSignal<string | null>('feedback.selectedStudent', () => null);
  readonly selectedLessonId = storedSignal<string | null>('feedback.selectedLesson', () => null);

  constructor() {
    // Wechselt der Berichtszeitraum, gehört die gewählte Person meist nicht mehr dazu: abwählen.
    let previous: string | undefined;
    effect(() => {
      const periodId = this.periodId();
      if (previous !== undefined && previous !== periodId) untracked(() => this.selectStudent(null));
      previous = periodId;
    });
  }

  readonly sortedStudents = computed(() =>
    [...this.students()].sort((a, b) => a.name.localeCompare(b.name, 'de')),
  );
  /** Auch eine Person anderer Zeiträume lässt sich auswählen, z. B. um frühere Stunden anzusehen. */
  readonly selectedStudent = computed(() =>
    this.allStudents().find((s) => s.id === this.selectedStudentId()),
  );
  readonly selectedLesson = computed(() =>
    this.selectedStudent()?.lessons.find((l) => l.id === this.selectedLessonId()),
  );

  /**
   * Anzeigename je Person: der Name, bei gleichnamigen Personen mit Geburtsdatum, z. B. „Anna Berg (geb. 03.05.2015)“
   */
  readonly labels = computed(() => {
    const students = this.allStudents();
    const count = new Map<string, number>();
    students.forEach((s) => count.set(s.name.trim().toLowerCase(), (count.get(s.name.trim().toLowerCase()) ?? 0) + 1));
    return new Map(
      students.map((s) => {
        const twin = (count.get(s.name.trim().toLowerCase()) ?? 0) > 1;
        return [s.id, twin && s.birthDate ? `${s.name} (geb. ${formatShortDate(s.birthDate)})` : s.name] as const;
      }),
    );
  });

  label(student: Student): string {
    return this.labels().get(student.id) ?? student.name;
  }

  /** Lehrer der Person im gewählten Berichtszeitraum */
  teacherOf(student: Student): Teacher {
    return teacherOf(student, this.config(), this.periodId());
  }

  /**
   * Wie `addStudent`, aber eine vorhandene Person (siehe `samePerson`: gleicher Name, kein abweichendes
   * Geburtsdatum) wird weiterverwendet: Ist sie im gewählten Zeitraum, wird sie nur ausgewählt; stammt sie aus
   * anderen Zeiträumen, kommt sie mit ihrem bisherigen Lehrer in den gewählten, und ihre früheren Stunden bleiben
   * sichtbar. Ein angegebenes Geburtsdatum wird bei ihr ergänzt.
   */
  addOrReuse(entry: NewStudent): 'created' | 'reused' | 'existing' {
    const existing = this.findPerson(entry);
    if (!existing) {
      this.addStudent(entry);
      return 'created';
    }
    const active = isActiveIn(existing, this.periodId());
    if (!active) this.addToPeriod([{ studentId: existing.id, teacherId: this.teacherOf(existing).id }]);
    if (entry.birthDate && !existing.birthDate) this.setBirthDate(existing.id, entry.birthDate);
    this.selectStudent(existing.id);
    return active ? 'existing' : 'reused';
  }

  /** Vorhandene Person zu Name und Geburtsdatum; eine mit gleichem Geburtsdatum geht vor. */
  findPerson(entry: { name: string; birthDate?: string }): Student | undefined {
    const candidates = this.allStudents().filter((s) => samePerson(s, entry));
    return candidates.find((s) => s.birthDate && s.birthDate === entry.birthDate) ?? candidates[0];
  }

  /** Neue Personen sind im gewählten Berichtszeitraum aktiv. */
  addStudent(entry: NewStudent): void {
    const student = this.newStudent(entry);
    this.allStudents.update((students) => [...students, student]);
    this.selectStudent(student.id);
  }

  /** Legt mehrere Personen auf einmal an, z. B. beim Import; die Auswahl bleibt unverändert. */
  addStudents(entries: NewStudent[]): void {
    const students = entries.map((entry) => this.newStudent(entry));
    this.allStudents.update((list) => [...list, ...students]);
  }

  renameStudent(studentId: string, name: string): void {
    this.mutateStudent(studentId, (student) => (student.name = name));
  }

  /** Leer entfernt das Geburtsdatum. */
  setBirthDate(studentId: string, birthDate: string): void {
    this.mutateStudent(studentId, (student) => {
      if (birthDate) student.birthDate = birthDate;
      else delete student.birthDate;
    });
  }

  /** Lehrer im gewählten Berichtszeitraum; frühere Zeiträume behalten ihren Lehrer. */
  setTeacher(studentId: string, teacherId: string): void {
    this.mutateStudent(studentId, (student) => (student.periods[this.periodId()] = teacherId));
  }

  /** In der Schüler-Planung gewählt: Mit dem ersten Termin steht der Lehrer für den Zeitraum fest. */
  chooseTeacher(studentId: string, periodId: string, teacherId: string | null): void {
    this.mutateStudent(studentId, (student) => (student.periods[periodId] = teacherId));
  }

  /** Nimmt Personen eines anderen Zeitraums in den gewählten auf, mit ihrem Lehrer dort. */
  addToPeriod(entries: { studentId: string; teacherId: string | null }[]): void {
    for (const { studentId, teacherId } of entries) {
      this.mutateStudent(studentId, (student) => (student.periods[this.periodId()] = teacherId));
    }
  }

  /** Die Person bleibt mit ihren Stunden erhalten, ist im gewählten Zeitraum aber inaktiv. */
  removeFromPeriod(studentId: string): void {
    this.mutateStudent(studentId, (student) => delete student.periods[this.periodId()]);
    if (this.selectedStudentId() === studentId) this.selectStudent(null);
  }

  setInstrument(studentId: string, instrumentId: string | null): void {
    this.mutateStudent(studentId, (student) => (student.instrumentId = instrumentId));
  }

  /**
   * Führt zwei Einträge derselben Person zusammen: `keepId` bleibt und bekommt die Zeiträume, Stunden und fehlenden
   * Angaben von `dropId`; bei Widersprüchen gilt `keepId`. Liefert `false`, wenn eine der beiden fehlt.
   */
  mergeInto(keepId: string, dropId: string): boolean {
    const students = this.allStudents();
    const keep = students.find((s) => s.id === keepId);
    const drop = students.find((s) => s.id === dropId);
    if (!keep || !drop || keep === drop) return false;
    const texts = { ...drop.generalTexts };
    for (const [section, text] of Object.entries(keep.generalTexts)) if (text.trim()) texts[section] = text;
    const merged: Student = {
      ...keep,
      ...((keep.birthDate ?? drop.birthDate) ? { birthDate: keep.birthDate ?? drop.birthDate } : {}),
      instrumentId: keep.instrumentId ?? drop.instrumentId,
      periods: { ...drop.periods, ...keep.periods },
      generalTexts: texts,
      lessons: [...keep.lessons, ...drop.lessons.filter((l) => !keep.lessons.some((k) => k.id === l.id))],
    };
    this.allStudents.set(students.filter((s) => s !== drop).map((s) => (s === keep ? merged : s)));
    if (this.selectedStudentId() === dropId) this.selectedStudentId.set(keepId);
    return true;
  }

  /** Gibt der Person eine neue ID, z. B. wenn ein anderer Lehrer sie mit einer hier unbekannten zusammengeführt hat. */
  changeId(from: string, into: string): boolean {
    if (!this.allStudents().some((s) => s.id === from)) return false;
    this.allStudents.update((students) => students.map((s) => (s.id === from ? { ...s, id: into } : s)));
    if (this.selectedStudentId() === from) this.selectedStudentId.set(into);
    return true;
  }

  removeStudent(studentId: string): void {
    this.allStudents.update((students) => students.filter((s) => s.id !== studentId));
    if (this.selectedStudentId() === studentId) this.selectStudent(null);
  }

  selectStudent(studentId: string | null): void {
    this.selectedStudentId.set(studentId);
    const lessons = this.selectedStudent()?.lessons ?? [];
    this.selectedLessonId.set(lessons.at(-1)?.id ?? null);
  }

  /**
   * Wählt die Person und ihre Stunde zu einem Termin aus; gibt es noch keine, wird sie mit Datum und
   * Uhrzeit des Termins angelegt. Einer vorhandenen Stunde ohne Uhrzeit wird die des Termins ergänzt.
   * Neue Stunden gibt es nur im gewählten Berichtszeitraum, und nur, wenn die Person dort ist (siehe
   * `canHaveLesson`); sonst `false`.
   */
  openLesson(studentId: string, date: string, time?: { start: string; durationMinutes?: number }): boolean {
    this.selectStudent(studentId);
    const student = this.selectedStudent();
    if (!student) return false;
    const existing = lessonAt(student, date, time?.start);
    if (existing) {
      if (time && !existing.start) this.mutateLesson(studentId, existing.id, (lesson) => Object.assign(lesson, time));
      this.selectedLessonId.set(existing.id);
      return true;
    }
    if (!this.canHaveLesson(student, date)) return false;
    const lesson: Lesson = { id: newId(), date, ...time, checked: {}, texts: {} };
    this.mutateStudent(studentId, (s) => s.lessons.push(lesson));
    this.selectedLessonId.set(lesson.id);
    return true;
  }

  /** Stunden liegen im gewählten Berichtszeitraum, und die Person ist dort. */
  canHaveLesson(student: Student, date: string): boolean {
    return this.reportPeriod.contains(date) && isActiveIn(student, this.periodId());
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
  ): boolean {
    if (!this.reportPeriod.contains(time.date)) return false;
    this.mutateLesson(studentId, lessonId, (lesson) => Object.assign(lesson, {
      date: time.date,
      start: time.start,
      durationMinutes: time.durationMinutes,
    }));
    return true;
  }

  removeLesson(studentId: string, lessonId: string): void {
    this.mutateStudent(studentId, (student) => (student.lessons = student.lessons.filter((l) => l.id !== lessonId)));
    if (this.selectedLessonId() === lessonId) this.selectedLessonId.set(null);
  }

  /** Nur innerhalb des gewählten Berichtszeitraums; sonst `false` */
  setLessonDate(studentId: string, lessonId: string, date: string): boolean {
    if (!this.reportPeriod.contains(date)) return false;
    this.mutateLesson(studentId, lessonId, (lesson) => (lesson.date = date));
    return true;
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

  private newStudent(entry: NewStudent): Student {
    const { name, instrumentId, teacherId, birthDate } = entry;
    return {
      id: newId(),
      name,
      ...(birthDate ? { birthDate } : {}),
      instrumentId,
      periods: { [this.periodId()]: teacherId },
      generalTexts: {},
      lessons: [],
    };
  }

  private mutateStudent(studentId: string, change: (student: Student) => void): void {
    this.allStudents.update((students) =>
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
  return data.map((student: Partial<Student> & { teacherId?: unknown }) => {
    if (typeof student?.name !== 'string' || !Array.isArray(student.lessons)) {
      throw new Error('Eine Person hat keinen Namen oder keine Stundenliste.');
    }
    return {
      id: typeof student.id === 'string' ? student.id : newId(),
      name: student.name,
      ...(typeof student.birthDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(student.birthDate)
        ? { birthDate: student.birthDate }
        : {}),
      instrumentId: typeof student.instrumentId === 'string' ? student.instrumentId : null,
      periods: isRecord(student.periods) ? parsePeriods(student.periods) : {},
      // Ältere Daten haben noch keine allgemeinen Freitexte.
      generalTexts: isRecord(student.generalTexts) ? student.generalTexts : {},
      lessons: student.lessons.map(parseLesson),
      // Ältere Daten haben einen Lehrer statt Zeiträumen; die Zeiträume ergänzt `withPeriodMembership`.
      ...(isRecord(student.periods)
        ? {}
        : { legacyTeacherId: typeof student.teacherId === 'string' ? student.teacherId : null }),
    };
  });
}

function parsePeriods(data: Record<string, unknown>): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(data).map(([periodId, teacherId]) => [periodId, typeof teacherId === 'string' ? teacherId : null]),
  );
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
