import { Group, Student } from '../model';
import { Occurrence } from './appointments';

/** Geplanter Unterricht einer Person in einem Zeitraum */
export interface LessonLoad {
  student: Student;
  individualCount: number;
  individualMinutes: number;
  groupCount: number;
  groupMinutes: number;
}

export function totalMinutes(load: LessonLoad): number {
  return load.individualMinutes + load.groupMinutes;
}

/**
 * Zählt die Termine je Person: eigene Einzeltermine (bei jedem Lehrer) und die Termine ihrer Gruppen.
 * Sortiert nach Gesamtdauer, am meisten zuerst; Personen ohne Termine stehen am Ende.
 */
export function lessonLoads(students: Student[], groups: Group[], occurrences: Occurrence[]): LessonLoad[] {
  const loads = new Map<string, LessonLoad>(
    students.map((student) => [student.id, { student, individualCount: 0, individualMinutes: 0, groupCount: 0, groupMinutes: 0 }]),
  );
  const membersOf = new Map(groups.map((group) => [group.id, group.memberIds]));
  for (const { appointment } of occurrences) {
    if (appointment.studentId) {
      const load = loads.get(appointment.studentId);
      if (!load) continue;
      load.individualCount++;
      load.individualMinutes += appointment.durationMinutes;
    } else if (appointment.groupId) {
      for (const id of membersOf.get(appointment.groupId) ?? []) {
        const load = loads.get(id);
        if (!load) continue;
        load.groupCount++;
        load.groupMinutes += appointment.durationMinutes;
      }
    }
  }
  return [...loads.values()].sort(
    (a, b) => totalMinutes(b) - totalMinutes(a) || a.student.name.localeCompare(b.student.name, 'de'),
  );
}

/** z. B. „1 h 30 min“, „45 min“, „0 min“ */
export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
