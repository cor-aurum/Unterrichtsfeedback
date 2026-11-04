import { daysFrom } from '../calendar/appointments';
import { Student } from '../model';

/** Alter in Jahren mit Nachkommastellen an einem Tag; `null` ohne Geburtsdatum */
export function ageOn(student: { birthDate?: string }, date: string): number | null {
  return student.birthDate ? daysFrom(student.birthDate, date) / 365.25 : null;
}

/** „10,4 J.“ */
export function formatAge(age: number): string {
  return `${age.toFixed(1).replace('.', ',')} J.`;
}

/** Kennzahlen einer Gruppe; Alterswerte nur von Personen mit Geburtsdatum */
export interface AgeStats {
  count: number;
  /** Personen mit Geburtsdatum */
  withAge: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  /** Standardabweichung, als Maß für die Altersstreuung */
  spread: number | null;
}

export function ageStats(members: { birthDate?: string }[], date: string): AgeStats {
  const ages = members.map((m) => ageOn(m, date)).filter((age) => age !== null);
  if (ages.length === 0) return { count: members.length, withAge: 0, mean: null, min: null, max: null, spread: null };
  const mean = average(ages);
  return {
    count: members.length,
    withAge: ages.length,
    mean,
    min: Math.min(...ages),
    max: Math.max(...ages),
    spread: Math.sqrt(average(ages.map((age) => (age - mean) ** 2))),
  };
}

/**
 * Teilt Personen in `count` Gruppen mit möglichst ähnlichem Altersgefüge: gleich groß (höchstens eine Person
 * Unterschied), mit ähnlichem Durchschnittsalter und ähnlicher Streuung.
 *
 * Nach Geburtsdatum sortiert verteilt die „Schlange“ (1, 2, 3, 3, 2, 1, …) Ältere und Jüngere gleichmäßig; danach
 * tauscht die App so lange Personen zwischen Gruppen, wie die Gruppen dadurch ähnlicher werden. Personen ohne
 * Geburtsdatum kommen in die jeweils kleinste Gruppe.
 *
 * Mit `instrumentOf` zählt zusätzlich und vorrangig, dass jedes Instrument möglichst gleichmäßig auf die Gruppen
 * verteilt ist; dann tauschen auch Personen ohne Geburtsdatum mit.
 */
export function planAgeGroups(
  students: Student[],
  count: number,
  date: string,
  instrumentOf?: (student: Student) => string,
): Student[][] {
  const groups: Student[][] = Array.from({ length: count }, () => []);
  const withAge = students.filter((s) => s.birthDate).sort((a, b) => a.birthDate!.localeCompare(b.birthDate!));
  withAge.forEach((student, index) => {
    const round = Math.floor(index / count);
    const position = index % count;
    groups[round % 2 === 0 ? position : count - 1 - position].push(student);
  });
  const withoutAge = students.filter((s) => !s.birthDate).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const placeWithoutAge = () => {
    for (const student of withoutAge) {
      groups.reduce((smallest, group) => (group.length < smallest.length ? group : smallest)).push(student);
    }
  };
  if (instrumentOf) {
    placeWithoutAge();
    const evaluate = (g: Student[][]) => cost(g, date) + INSTRUMENT_WEIGHT * instrumentCost(g, instrumentOf);
    improveBySwaps(groups, evaluate);
  } else {
    improveBySwaps(groups, (g) => cost(g, date));
    placeWithoutAge();
  }
  return groups;
}

/**
 * Gewicht der Instrumente gegenüber dem Alter: Eine Person zu viel eines Instruments wiegt so schwer wie gut drei
 * Jahre Unterschied im Durchschnittsalter.
 */
const INSTRUMENT_WEIGHT = 10;

/** Abweichung jedes Instruments von seinem Anteil je Gruppe, quadriert und aufsummiert */
function instrumentCost(groups: Student[][], instrumentOf: (student: Student) => string): number {
  const total = groups.reduce((sum, group) => sum + group.length, 0);
  const counts = new Map<string, number>();
  groups.flat().forEach((s) => counts.set(instrumentOf(s), (counts.get(instrumentOf(s)) ?? 0) + 1));
  let sum = 0;
  for (const group of groups) {
    const inGroup = new Map<string, number>();
    group.forEach((s) => inGroup.set(instrumentOf(s), (inGroup.get(instrumentOf(s)) ?? 0) + 1));
    for (const [instrument, count] of counts) {
      sum += ((inGroup.get(instrument) ?? 0) - (count * group.length) / total) ** 2;
    }
  }
  return sum;
}

/** z. B. „Klavier 2 · Gitarre 1“, häufigste zuerst */
export function instrumentCounts(members: Student[], nameOf: (student: Student) => string): string {
  const counts = new Map<string, number>();
  members.forEach((s) => counts.set(nameOf(s), (counts.get(nameOf(s)) ?? 0) + 1));
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'de'))
    .map(([name, count]) => `${name} ${count}`)
    .join(' · ');
}

/**
 * Teilt Personen nach Alter in `count` gleich große Gruppen (höchstens eine Person Unterschied): die jüngsten in
 * die erste, die ältesten in die letzte. Personen ohne Geburtsdatum lassen sich nicht einordnen und stehen in
 * `withoutAge`.
 */
export function planByAge(students: Student[], count: number): { groups: Student[][]; withoutAge: Student[] } {
  // Jüngste zuerst: das späteste Geburtsdatum
  const withAge = students.filter((s) => s.birthDate).sort((a, b) => b.birthDate!.localeCompare(a.birthDate!));
  const base = Math.floor(withAge.length / count);
  const larger = withAge.length % count;
  const groups: Student[][] = [];
  let start = 0;
  for (let i = 0; i < count; i++) {
    const size = base + (i < larger ? 1 : 0);
    groups.push(withAge.slice(start, start + size));
    start += size;
  }
  const withoutAge = students.filter((s) => !s.birthDate).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return { groups, withoutAge };
}

/** Abweichung der Gruppen vom Ganzen: Durchschnitt und Streuung, je Gruppe quadriert und aufsummiert */
function cost(groups: Student[][], date: string): number {
  const all = ageStats(groups.flat(), date);
  return groups
    .map((group) => ageStats(group, date))
    .filter((stats) => stats.mean !== null)
    .reduce((sum, stats) => sum + (stats.mean! - all.mean!) ** 2 + (stats.spread! - all.spread!) ** 2, 0);
}

/** Tauscht Paare zwischen Gruppen, solange es besser wird; die Größen bleiben dabei gleich. */
function improveBySwaps(groups: Student[][], evaluate: (groups: Student[][]) => number): void {
  let best = evaluate(groups);
  for (let pass = 0; pass < 50; pass++) {
    let improved = false;
    for (let a = 0; a < groups.length; a++) {
      for (let b = a + 1; b < groups.length; b++) {
        for (let i = 0; i < groups[a].length; i++) {
          for (let j = 0; j < groups[b].length; j++) {
            [groups[a][i], groups[b][j]] = [groups[b][j], groups[a][i]];
            const next = evaluate(groups);
            if (next < best - 1e-9) {
              best = next;
              improved = true;
            } else {
              [groups[a][i], groups[b][j]] = [groups[b][j], groups[a][i]];
            }
          }
        }
      }
    }
    if (!improved) return;
  }
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
