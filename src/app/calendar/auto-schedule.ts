import { FreeSlot, minutesOf, weekday } from './appointments';

/** Wie Mitglieder derselben Gruppe verteilt werden: nah beieinander oder gemischt mit anderen */
export type GroupPlacement = 'close' | 'mixed';

export interface ScheduleInput {
  slots: FreeSlot[];
  studentIds: string[];
  /** Je Gruppe die Mitglieder, die verteilt werden; Gruppen mit weniger als zwei zählen nicht. */
  groups: string[][];
  /** Wie oft der Slot im geprüften Zeitraum mit anderem Unterricht der Person kollidiert (0 = nie) */
  conflicts: (studentId: string, slot: FreeSlot) => number;
  /** Darf die Person den Slot überhaupt bekommen? Nein z. B. bei eigenem Einzelunterricht bei einem anderen Lehrer. */
  allowed?: (studentId: string, slot: FreeSlot) => boolean;
  placement: GroupPlacement;
}

export interface ScheduleResult {
  assignments: { studentId: string; slot: FreeSlot; conflicts: number }[];
  unassigned: string[];
}

/** Wertung eines Plans; verglichen wird der Reihe nach (wichtigstes zuerst). */
type Score = [assigned: number, conflicts: number, groupCost: number];

/** Unterschiedliche Tage wiegen beim Zusammenlegen so viel wie ein großer Abstand am selben Tag. */
const OTHER_DAY_DISTANCE = 24 * 60;
const MAX_ROUNDS = 50;

/**
 * Verteilt Personen auf freie wöchentliche Slots. Vorrang hat, möglichst viele Slots zu füllen; danach sollen
 * möglichst wenige Slots mit anderem Unterricht der Person kollidieren (z. B. Gruppenunterricht bei einem
 * anderen Lehrer); zuletzt zählt die Verteilung der Gruppenmitglieder (`placement`).
 *
 * Erst eine gierige Verteilung (Personen mit den wenigsten passenden Slots zuerst), dann lokale Verbesserung
 * durch Verschieben und Tauschen, solange sich die Wertung verbessert.
 */
export function planSchedule(input: ScheduleInput): ScheduleResult {
  const { slots, studentIds } = input;
  const conflictTable = new Map(studentIds.map((id) => [id, slots.map((slot) => input.conflicts(id, slot))]));
  const allowedTable = allowedTableOf(studentIds, slots, input.allowed);
  const groups = input.groups.filter((members) => members.length > 1);
  const slotOf = new Map<string, number | null>(studentIds.map((id) => [id, null]));
  const takenBy = new Map<number, string>();

  const conflictsOf = (id: string, slot: number | null) => (slot === null ? 0 : conflictTable.get(id)![slot]);
  const score = (): Score => {
    let assigned = 0;
    let conflicts = 0;
    for (const [id, slot] of slotOf) {
      if (slot === null) continue;
      assigned++;
      conflicts += conflictsOf(id, slot);
    }
    return [assigned, conflicts, groupCost(groups, slotOf, slots, input.placement)];
  };

  const allowed = (id: string, slot: number | null) => slot === null || allowedTable.get(id)![slot];
  greedy(studentIds, slots, conflictTable, allowed, slotOf, takenBy, () => score());
  improve(studentIds, slots.length, allowed, slotOf, takenBy, score);

  const assignments = studentIds
    .filter((id) => slotOf.get(id) !== null)
    .map((id) => ({ studentId: id, slot: slots[slotOf.get(id)!], conflicts: conflictsOf(id, slotOf.get(id)!) }))
    .sort((a, b) => a.slot.date.localeCompare(b.slot.date) || a.slot.start.localeCompare(b.slot.start));
  return { assignments, unassigned: studentIds.filter((id) => slotOf.get(id) === null) };
}

function greedy(
  studentIds: string[],
  slots: FreeSlot[],
  conflictTable: Map<string, number[]>,
  allowed: (id: string, slot: number | null) => boolean,
  slotOf: Map<string, number | null>,
  takenBy: Map<number, string>,
  score: () => Score,
): void {
  const freeChoices = (id: string) => conflictTable.get(id)!.filter((c, slot) => c === 0 && allowed(id, slot)).length;
  const order = [...studentIds].sort((a, b) => freeChoices(a) - freeChoices(b));
  for (const id of order) {
    let best: { slot: number; score: Score } | null = null;
    for (let slot = 0; slot < slots.length; slot++) {
      if (takenBy.has(slot) || !allowed(id, slot)) continue;
      slotOf.set(id, slot);
      const candidate = score();
      if (!best || better(candidate, best.score)) best = { slot, score: candidate };
    }
    slotOf.set(id, best?.slot ?? null);
    if (best) takenBy.set(best.slot, id);
  }
}

/** Verschiebt eine Person auf einen anderen (auch freien) Slot oder tauscht mit der Person dort. */
function improve(
  studentIds: string[],
  slotCount: number,
  allowed: (id: string, slot: number | null) => boolean,
  slotOf: Map<string, number | null>,
  takenBy: Map<number, string>,
  score: () => Score,
): void {
  let current = score();
  for (let round = 0, improved = true; improved && round < MAX_ROUNDS; round++) {
    improved = false;
    for (const id of studentIds) {
      for (let target = 0; target < slotCount; target++) {
        const from = slotOf.get(id) ?? null;
        if (from === target) continue;
        const other = takenBy.get(target);
        if (!allowed(id, target) || (other !== undefined && !allowed(other, from))) continue;
        apply(id, other, from, target, slotOf, takenBy);
        const candidate = score();
        if (better(candidate, current)) {
          current = candidate;
          improved = true;
        } else {
          apply(id, other, target, from, slotOf, takenBy);
        }
      }
    }
  }
}

/** Setzt `id` von `from` auf `to`; `other` (bisher auf `to`) bekommt `from`. Mit vertauschten Slots rückgängig. */
function apply(
  id: string,
  other: string | undefined,
  from: number | null,
  to: number | null,
  slotOf: Map<string, number | null>,
  takenBy: Map<number, string>,
): void {
  if (from !== null) takenBy.delete(from);
  if (to !== null) takenBy.delete(to);
  slotOf.set(id, to);
  if (to !== null) takenBy.set(to, id);
  if (other !== undefined) {
    slotOf.set(other, from);
    if (from !== null) takenBy.set(from, other);
  }
}

function better([a1, c1, g1]: Score, [a2, c2, g2]: Score): boolean {
  if (a1 !== a2) return a1 > a2;
  if (c1 !== c2) return c1 < c2;
  return g1 < g2 - 1e-9;
}

/**
 * „close“: Summe der Lücken zwischen Mitgliedern derselben Gruppe (verschiedene Tage zählen viel).
 * „mixed“: Strafe für Mitglieder, die am selben Tag nah beieinander liegen; direkt hintereinander am meisten.
 */
function groupCost(
  groups: string[][],
  slotOf: Map<string, number | null>,
  slots: FreeSlot[],
  placement: GroupPlacement,
): number {
  let cost = 0;
  for (const members of groups) {
    const placed = members.map((id) => slotOf.get(id) ?? null);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const [a, b] = [placed[i], placed[j]];
        // Ohne Slot ist ein Mitglied beim Zusammenlegen „weit weg“; sonst wäre Weglassen billiger als Einplanen.
        if (a === null || b === null) {
          cost += placement === 'close' ? OTHER_DAY_DISTANCE : 0;
        } else {
          cost += pairCost(slots[a], slots[b], placement);
        }
      }
    }
  }
  return cost;
}

function pairCost(a: FreeSlot, b: FreeSlot, placement: GroupPlacement): number {
  const sameDay = weekday(a.date) === weekday(b.date);
  const gap = Math.abs(minutesOf(a.start) - minutesOf(b.start)) - a.durationMinutes;
  if (placement === 'close') return sameDay ? Math.max(0, gap) : OTHER_DAY_DISTANCE;
  // Gemischt: bis zu zwei Slots Abstand am selben Tag gilt als „zu nah“.
  return sameDay ? Math.max(0, 2 * a.durationMinutes - gap) : 0;
}

// ---------- Einmalige Termine in einem Zeitraum ----------

export interface FillInput {
  slots: FreeSlot[];
  studentIds: string[];
  groups: string[][];
  /** Wie oft der Slot mit anderem Unterricht der Person kollidiert (0 = nie) */
  conflicts: (studentId: string, slot: FreeSlot) => number;
  /** Wie viele Termine die Person an diesem Tag schon hat */
  existingOnDay: (studentId: string, date: string) => number;
  /** Wie bei `ScheduleInput.allowed`; ein Slot, den niemand bekommen darf, bleibt frei. */
  allowed?: (studentId: string, slot: FreeSlot) => boolean;
  placement: GroupPlacement;
}

export interface FillResult {
  assignments: { studentId: string; slot: FreeSlot; conflicts: number; secondOnDay: boolean }[];
  /** Slots, die niemand bekommen durfte */
  empty: FreeSlot[];
}

/** Wertung beim Füllen; verglichen wird der Reihe nach (wichtigstes zuerst). */
type FillScore = [empty: number, secondOnDay: number, conflicts: number, balance: number, groupCost: number];

/**
 * Füllt alle freien Slots eines Zeitraums mit einmaligen Terminen; jede Person kann mehrere bekommen. Danach
 * zählt der Reihe nach: möglichst niemand zweimal am selben Tag (vorhandene Termine eingerechnet), möglichst
 * wenige Überschneidungen mit anderem Unterricht, möglichst gleich viele Termine je Person, zuletzt die
 * Verteilung der Gruppenmitglieder (`placement`).
 */
export function fillSlots(input: FillInput): FillResult {
  const { slots, studentIds } = input;
  if (studentIds.length === 0) return { assignments: [], empty: slots };
  const conflictTable = new Map(studentIds.map((id) => [id, slots.map((slot) => input.conflicts(id, slot))]));
  const allowedTable = allowedTableOf(studentIds, slots, input.allowed);
  const allowed = (id: string | null, slot: number) => id === null || allowedTable.get(id)![slot];
  const groupsOf = new Map<string, number[]>();
  input.groups
    .filter((members) => members.length > 1)
    .forEach((members, index) => members.forEach((id) => groupsOf.set(id, [...(groupsOf.get(id) ?? []), index])));
  // Die Slots je Tag stehen fest; „zweimal am Tag“ und die Gruppenwertung betreffen nur Slots desselben Tages.
  const byDay = new Map<string, number[]>();
  slots.forEach((slot, i) => byDay.set(slot.date, [...(byDay.get(slot.date) ?? []), i]));
  const owner: (string | null)[] = slots.map(() => null);

  const score = (): FillScore => {
    const empty = owner.filter((id) => id === null).length;
    let secondOnDay = 0;
    let conflicts = 0;
    let group = 0;
    const counts = new Map(studentIds.map((id) => [id, 0]));
    for (const [date, indices] of byDay) {
      const perStudent = new Map<string, number>();
      for (const i of indices) {
        const id = owner[i];
        if (!id) continue;
        perStudent.set(id, (perStudent.get(id) ?? 0) + 1);
        counts.set(id, counts.get(id)! + 1);
        conflicts += conflictTable.get(id)![i];
      }
      for (const [id, n] of perStudent) secondOnDay += Math.max(0, n + input.existingOnDay(id, date) - 1);
      group += dayGroupCost(indices, owner, slots, groupsOf, input.placement);
    }
    const balance = [...counts.values()].reduce((sum, n) => sum + n * n, 0);
    return [empty, secondOnDay, conflicts, balance, group];
  };

  // Gierig: Slot für Slot die Person, mit der die Wertung am besten bleibt
  for (let i = 0; i < slots.length; i++) {
    let best: { id: string; score: FillScore } | null = null;
    for (const id of studentIds.filter((s) => allowed(s, i))) {
      owner[i] = id;
      const candidate = score();
      if (!best || betterFill(candidate, best.score)) best = { id, score: candidate };
    }
    owner[i] = best?.id ?? null;
  }

  // Verbessern: einem Slot eine andere Person geben oder zwei Slots tauschen
  let current = score();
  for (let round = 0, improved = true; improved && round < MAX_ROUNDS; round++) {
    improved = false;
    for (let i = 0; i < slots.length; i++) {
      for (const id of studentIds) {
        const before = owner[i];
        if (before === id || !allowed(id, i)) continue;
        owner[i] = id;
        const candidate = score();
        if (betterFill(candidate, current)) {
          current = candidate;
          improved = true;
        } else {
          owner[i] = before;
        }
      }
      for (let j = i + 1; j < slots.length; j++) {
        if (owner[i] === owner[j] || !allowed(owner[i], j) || !allowed(owner[j], i)) continue;
        [owner[i], owner[j]] = [owner[j], owner[i]];
        const candidate = score();
        if (betterFill(candidate, current)) {
          current = candidate;
          improved = true;
        } else {
          [owner[i], owner[j]] = [owner[j], owner[i]];
        }
      }
    }
  }

  return {
    assignments: slots.flatMap((slot, i) => {
      const id = owner[i];
      if (!id) return [];
      const onDay = byDay.get(slot.date)!.filter((j) => owner[j] === id).length + input.existingOnDay(id, slot.date);
      return [{ studentId: id, slot, conflicts: conflictTable.get(id)![i], secondOnDay: onDay > 1 }];
    }),
    empty: slots.filter((_, i) => owner[i] === null),
  };
}

function allowedTableOf(
  studentIds: string[],
  slots: FreeSlot[],
  allowed?: (studentId: string, slot: FreeSlot) => boolean,
): Map<string, boolean[]> {
  return new Map(studentIds.map((id) => [id, slots.map((slot) => !allowed || allowed(id, slot))]));
}

function betterFill(a: FillScore, b: FillScore): boolean {
  for (let k = 0; k < a.length; k++) {
    if (Math.abs(a[k] - b[k]) > 1e-9) return a[k] < b[k];
  }
  return false;
}

/**
 * Gruppenwertung eines Tages. „close“: Jeder Termin eines Gruppenmitglieds kostet den Abstand zum nächsten Termin
 * eines anderen Mitglieds derselben Gruppe an diesem Tag (ohne solchen: viel). „mixed“: Strafe für nahe Termine.
 */
function dayGroupCost(
  indices: number[],
  owner: (string | null)[],
  slots: FreeSlot[],
  groupsOf: Map<string, number[]>,
  placement: GroupPlacement,
): number {
  let cost = 0;
  for (const i of indices) {
    const groups = owner[i] ? groupsOf.get(owner[i]!) : undefined;
    if (!groups) continue;
    const partners = indices.filter(
      (j) => j !== i && owner[j] && owner[j] !== owner[i] && groupsOf.get(owner[j]!)?.some((g) => groups.includes(g)),
    );
    if (placement === 'close') {
      cost += partners.length ? Math.min(...partners.map((j) => gapBetween(slots[i], slots[j]))) : OTHER_DAY_DISTANCE;
    } else {
      // Jedes Paar zählt von beiden Seiten; am Vergleich ändert das nichts.
      cost += partners.reduce((sum, j) => sum + Math.max(0, 2 * slots[i].durationMinutes - gapBetween(slots[i], slots[j])), 0);
    }
  }
  return cost;
}

function gapBetween(a: FreeSlot, b: FreeSlot): number {
  return Math.max(0, Math.abs(minutesOf(a.start) - minutesOf(b.start)) - a.durationMinutes);
}
