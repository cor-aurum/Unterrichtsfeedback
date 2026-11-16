import { FeedbackConfig, Group, groupTeacherOf, Lesson, lessonPeriodId, Student, Teacher, teacherOf } from '../model';

/** Unterricht einer Art: Zahl der Stunden und ihre Dauer in Minuten */
export interface LessonTally {
  count: number;
  minutes: number;
}

/** Unterricht einer Lehrkraft in einem Berichtszeitraum */
export interface TeacherHours {
  teacher: Teacher;
  individual: LessonTally;
  group: LessonTally;
  total: LessonTally;
  /** Stunden ohne Länge (von Hand ohne Uhrzeit angelegt); sie zählen mit der Standardlänge */
  withoutDuration: number;
}

/**
 * Wie viel Unterricht jede Lehrkraft im Berichtszeitraum gegeben hat: alle Stunden von Personen und Gruppen dieses
 * Zeitraums, getrennt nach Einzel- und Gruppenunterricht. Gezählt wird bei der Lehrkraft, die die Stunde gegeben hat
 * (`Lesson.teacherId`), bei älteren Stunden bei der Lehrkraft der Person bzw. Gruppe. Stunden ohne Länge zählen mit
 * der Standardlänge. Lehrkräfte ohne Stunden stehen mit 0 dabei, wenn sie im Zeitraum eingetragen sind; die Reihenfolge
 * ist die des Zeitraums, danach weitere nach Namen.
 */
export function teacherHours(config: FeedbackConfig, periodId: string, students: Student[], groups: Group[]): TeacherHours[] {
  const period = config.reportPeriods.find((p) => p.id === periodId);
  const fallback = config.calendar.defaultDurationMinutes;
  const rows = new Map<string, TeacherHours>();
  const row = (teacher: Teacher) => {
    let entry = rows.get(teacher.id);
    if (!entry) {
      entry = { teacher, individual: tally(), group: tally(), total: tally(), withoutDuration: 0 };
      rows.set(teacher.id, entry);
    }
    return entry;
  };
  const count = (teacherId: string, lesson: Lesson, kind: 'individual' | 'group') => {
    const teacher = config.teachers.find((t) => t.id === teacherId);
    if (!teacher) return;
    const entry = row(teacher);
    const minutes = lesson.durationMinutes ?? fallback;
    if (!lesson.durationMinutes) entry.withoutDuration++;
    add(entry[kind], minutes);
    add(entry.total, minutes);
  };
  for (const teacherId of period?.teacherIds ?? []) {
    const teacher = config.teachers.find((t) => t.id === teacherId);
    if (teacher) row(teacher);
  }
  for (const student of students) {
    for (const lesson of student.lessons.filter((l) => lessonPeriodId(student, l, config.reportPeriods) === periodId)) {
      count(lesson.teacherId ?? teacherOf(student, config, periodId).id, lesson, 'individual');
    }
  }
  for (const group of groups.filter((g) => g.periodId === periodId)) {
    for (const lesson of group.lessons) count(lesson.teacherId ?? groupTeacherOf(group, config).id, lesson, 'group');
  }
  const order = period?.teacherIds ?? [];
  const rank = (t: Teacher) => (order.includes(t.id) ? order.indexOf(t.id) : order.length);
  return [...rows.values()].sort((a, b) => rank(a.teacher) - rank(b.teacher) || a.teacher.name.localeCompare(b.teacher.name, 'de'));
}

/** „12:30 h“ für 750 Minuten */
export function hoursText(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')} h`;
}

function tally(): LessonTally {
  return { count: 0, minutes: 0 };
}

function add(target: LessonTally, minutes: number): void {
  target.count++;
  target.minutes += minutes;
}
