import { formatShortDate, Student } from '../model';

/** „Anna Berg“ → „Anna B.“, wie in der Namensliste der Planung */
export function shortName(student: Student): string {
  const [first, ...rest] = student.name.trim().split(/\s+/);
  return rest.length ? `${first} ${rest.at(-1)![0]}.` : first;
}

/**
 * Namen, die niemand verwechselt: Teilen sich mehrere Personen einen Kurznamen, steht ihr voller Name da. Heißen
 * genau zwei gleich und haben beide ein Geburtsdatum, steht hinter dem älteren „sen.“, hinter dem jüngeren „jun.“;
 * sonst das Geburtsjahr oder, wenn es fehlt oder gleich ist, das Geburtsdatum.
 */
export function planningLabels(students: Student[], short: (student: Student) => string): Map<string, string> {
  const labels = new Map<string, string>();
  const byShort = groupBy(students, short);
  for (const [label, group] of byShort) {
    if (group.length === 1) {
      labels.set(group[0].id, label);
      continue;
    }
    for (const [name, twins] of groupBy(group, (s) => s.name.trim())) {
      if (twins.length === 1) labels.set(twins[0].id, name);
      else twinLabels(name, twins).forEach((text, id) => labels.set(id, text));
    }
  }
  return labels;
}

function twinLabels(name: string, twins: Student[]): Map<string, string> {
  const dated = twins.every((s) => s.birthDate) && new Set(twins.map((s) => s.birthDate)).size === twins.length;
  if (dated && twins.length === 2) {
    const [older, younger] = [...twins].sort((a, b) => a.birthDate!.localeCompare(b.birthDate!));
    return new Map([
      [older.id, `${name} sen.`],
      [younger.id, `${name} jun.`],
    ]);
  }
  const years = twins.map((s) => s.birthDate?.slice(0, 4));
  const yearsDistinct = years.every(Boolean) && new Set(years).size === twins.length;
  return new Map(
    twins.map((s) => {
      if (yearsDistinct) return [s.id, `${name} (${s.birthDate!.slice(0, 4)})`];
      return [s.id, s.birthDate ? `${name} (${formatShortDate(s.birthDate)})` : name];
    }),
  );
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
}
