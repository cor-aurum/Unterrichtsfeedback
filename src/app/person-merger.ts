import { computed, inject, Injectable } from '@angular/core';
import { CalendarStore } from './calendar/calendar.store';
import { GroupsStore } from './groups.store';
import { samePerson } from './import/student-import';
import { Student } from './model';
import { storedSignal } from './stored-signal';
import { StudentsStore } from './students.store';

/** Zusammenführung: `from` ist in `into` aufgegangen. */
export interface PersonMerge {
  from: string;
  into: string;
}

/** Zwei Einträge, die vermutlich dieselbe Person sind; `keep` bleibt beim Zusammenführen. */
export interface DuplicatePair {
  keep: Student;
  drop: Student;
}

/**
 * Personen zusammenführen, die doppelt angelegt wurden – z. B. von zwei Lehrern, die einander nicht sehen konnten.
 * Vorgeschlagen werden Paare mit gleichem Namen und passendem Geburtsdatum unter den Personen, die dieser Lehrer
 * sieht. Zusammenführungen merkt sich die App, bis der Server sie kennt; die Apps der anderen Lehrer übernehmen
 * sie dann beim nächsten Abgleich (`applyMerges`).
 */
@Injectable({ providedIn: 'root' })
export class PersonMerger {
  private readonly studentsStore = inject(StudentsStore);
  private readonly groupsStore = inject(GroupsStore);
  private readonly calendar = inject(CalendarStore);

  /** Zusammenführungen, die der Server noch nicht kennt */
  readonly pending = storedSignal<PersonMerge[]>('feedback.pendingMerges', () => [], parseMerges);
  /** Paare, die laut Nutzer verschiedene Personen sind („id|id“, sortiert) */
  private readonly dismissed = storedSignal<string[]>('feedback.notDuplicates', () => []);

  readonly duplicates = computed<DuplicatePair[]>(() => {
    const students = this.studentsStore.allStudents();
    const dismissed = new Set(this.dismissed());
    const pairs: DuplicatePair[] = [];
    students.forEach((a, i) => {
      for (const b of students.slice(i + 1)) {
        if (!samePerson(a, b) || dismissed.has(pairKey(a, b))) continue;
        const [keep, drop] = preferred(a, b);
        pairs.push({ keep, drop });
      }
    });
    return pairs;
  });

  /** Führt `drop` in `keep` zusammen und merkt es für den Server vor. */
  merge(keepId: string, dropId: string): void {
    if (!this.mergeLocally(keepId, dropId)) return;
    this.pending.update((list) => [...list.filter((m) => m.from !== dropId), { from: dropId, into: keepId }]);
  }

  dismiss(pair: DuplicatePair): void {
    this.dismissed.update((keys) => [...keys, pairKey(pair.keep, pair.drop)]);
  }

  /**
   * Übernimmt Zusammenführungen anderer Lehrer: Gibt es hier beide Personen, werden sie zusammengeführt; gibt es
   * nur die alte, bekommt sie die neue ID. Liefert, ob sich etwas geändert hat.
   */
  applyMerges(merges: PersonMerge[]): boolean {
    let changed = false;
    for (const { from, into } of merges) {
      const ids = new Set(this.studentsStore.allStudents().map((s) => s.id));
      if (!ids.has(from)) continue;
      changed = ids.has(into) ? this.mergeLocally(into, from) || changed : this.changeId(from, into) || changed;
    }
    return changed;
  }

  /** Nach dem Senden an den Server (oder wenn der Server sie ablehnt, weil er eine der Personen nicht kennt) */
  forgetPending(merge: PersonMerge): void {
    this.pending.update((list) => list.filter((m) => m.from !== merge.from || m.into !== merge.into));
  }

  private mergeLocally(keepId: string, dropId: string): boolean {
    if (!this.studentsStore.mergeInto(keepId, dropId)) return false;
    this.groupsStore.replaceMember(dropId, keepId);
    this.calendar.replaceStudent(dropId, keepId);
    return true;
  }

  private changeId(from: string, into: string): boolean {
    if (!this.studentsStore.changeId(from, into)) return false;
    this.groupsStore.replaceMember(from, into);
    this.calendar.replaceStudent(from, into);
    return true;
  }
}

/** Es bleibt der Eintrag mit Geburtsdatum, sonst der mit mehr Stunden, sonst der erste. */
function preferred(a: Student, b: Student): [Student, Student] {
  if (!!a.birthDate !== !!b.birthDate) return a.birthDate ? [a, b] : [b, a];
  return b.lessons.length > a.lessons.length ? [b, a] : [a, b];
}

function pairKey(a: Student, b: Student): string {
  return [a.id, b.id].sort().join('|');
}

function parseMerges(data: unknown): PersonMerge[] {
  return Array.isArray(data)
    ? data.filter((m) => typeof m?.from === 'string' && typeof m?.into === 'string').map(({ from, into }) => ({ from, into }))
    : [];
}
