import { FeedbackConfig, Group, isActiveIn, Student, teacherOf } from '../model';

/** Auf allen Geräten dieselbe ID, damit jede Lehrkraft je Zeitraum genau eine automatische Gruppe hat */
export function autoGroupId(periodId: string, teacherId: string): string {
  return `auto-${periodId}-${teacherId}`;
}

/** Name einer neuen automatischen Gruppe; danach lässt er sich ändern. */
export function autoGroupName(teacherName: string): string {
  return `Alle von ${teacherName}`;
}

/** Mitglieder der automatischen Gruppe: alle Personen, die im Zeitraum diese Lehrkraft haben, nach ihrer ID */
export function autoGroupMembers(students: Student[], config: FeedbackConfig, periodId: string, teacherId: string): string[] {
  return students
    .filter((s) => isActiveIn(s, periodId) && teacherOf(s, config, periodId).id === teacherId)
    .map((s) => s.id)
    .sort();
}

/**
 * Je Lehrkraft und Berichtszeitraum eine automatische Gruppe mit allen Personen, die sie dort haben. Fehlende werden
 * angelegt, die Mitglieder vorhandener nachgeführt, z. B. wenn eine Person ihre Lehrkraft beim Selbsteintragen
 * wählt. Name, Stunden und Texte bleiben. Liefert dieselbe Liste, wenn sich nichts ändert.
 */
export function withAutoGroups(groups: Group[], students: Student[], config: FeedbackConfig): Group[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const added: Group[] = [];
  for (const period of config.reportPeriods.filter((p) => !p.placeholder)) {
    for (const teacherId of period.teacherIds) {
      const id = autoGroupId(period.id, teacherId);
      if (byId.has(id)) continue;
      const teacher = config.teachers.find((t) => t.id === teacherId);
      if (!teacher) continue;
      added.push({ id, name: autoGroupName(teacher.name), memberIds: [], teacherId, periodId: period.id, lessons: [], generalTexts: {}, auto: true });
    }
  }
  let changed = added.length > 0;
  const next = [...groups, ...added].map((group) => {
    if (!group.auto || !group.teacherId) return group;
    const memberIds = autoGroupMembers(students, config, group.periodId, group.teacherId);
    if (sameMembers(group.memberIds, memberIds)) return group;
    changed = true;
    return { ...group, memberIds };
  });
  return changed ? next : groups;
}

function sameMembers(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
