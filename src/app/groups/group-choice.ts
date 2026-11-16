import { computed, inject, Injectable, Injector } from '@angular/core';
import { ConfigStore } from '../config.store';
import { GroupsStore } from '../groups.store';
import { Group, groupLabel, isActiveIn, ReportPeriodEntry, Student } from '../model';
import { storedSignal } from '../stored-signal';
import { StudentsStore } from '../students.store';
import { ServerSync, TransactResult } from '../sync/server-sync';

/** Gruppenwahl am Tablet auf diesem Gerät; solange sie läuft, zeigt die App nur die Wahl. */
export interface GroupChoiceTablet {
  periodId: string;
  /** Zum Beenden; leer: Beenden nur mit Rückfrage */
  pin: string;
}

/**
 * Gruppenwahl durch die Personen selbst: Jede Person des Zeitraums ist in genau einer der angebotenen Gruppen. Wer
 * eine wählt, wird dort Mitglied und aus den anderen angebotenen Gruppen genommen; bis zum Beenden darf sie wechseln.
 * Gewählt wird am Tablet (`tablet`) oder auf der eigenen Seite des Download-Links (übernommen von `PlanGroupChoices`).
 * Automatische Gruppen stehen nicht zur Wahl, denn ihre Mitglieder ergeben sich aus der Lehrkraft.
 */
@Injectable({ providedIn: 'root' })
export class GroupChoice {
  private readonly config = inject(ConfigStore).config;
  private readonly groupsStore = inject(GroupsStore);
  private readonly studentsStore = inject(StudentsStore);
  /** Erst bei Bedarf: Der Abgleich braucht über die Pläne selbst die Gruppenwahl. */
  private readonly injector = inject(Injector);

  readonly tablet = storedSignal<GroupChoiceTablet | null>('feedback.groupChoiceTablet', () => null, parseTablet);
  readonly tabletActive = computed(() => !!this.tablet());

  period(periodId: string): ReportPeriodEntry | undefined {
    return this.config().reportPeriods.find((p) => p.id === periodId);
  }

  /** Die angebotenen Gruppen des Zeitraums in der eingestellten Reihenfolge; leer, wenn keine Wahl läuft */
  offered(periodId: string): Group[] {
    const ids = this.period(periodId)?.groupChoice?.groupIds ?? [];
    const groups = this.groupsStore.allGroups();
    return ids.map((id) => groups.find((g) => g.id === id && g.periodId === periodId && !g.auto)).filter((g): g is Group => !!g);
  }

  /** Alle Personen des Zeitraums, nach Namen */
  students(periodId: string): Student[] {
    return this.studentsStore
      .allStudents()
      .filter((s) => isActiveIn(s, periodId))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  /** Die gewählte Gruppe der Person (die erste angebotene, in der sie ist) */
  choiceOf(studentId: string, periodId: string): Group | undefined {
    return this.offered(periodId).find((g) => g.memberIds.includes(studentId));
  }

  /** Wer noch keine der angebotenen Gruppen gewählt hat */
  missing(periodId: string): Student[] {
    const offered = this.offered(periodId);
    return this.students(periodId).filter((s) => !offered.some((g) => g.memberIds.includes(s.id)));
  }

  label(group: Group): string {
    return groupLabel(group, this.studentsStore.allStudents());
  }

  /**
   * Trägt die Person in die Gruppe ein und aus den übrigen angebotenen aus; `false`, wenn die Gruppe nicht (mehr)
   * angeboten wird oder die Person nicht im Zeitraum ist.
   */
  choose(studentId: string, groupId: string, periodId: string): boolean {
    const offered = this.offered(periodId);
    if (!offered.some((g) => g.id === groupId)) return false;
    if (!this.students(periodId).some((s) => s.id === studentId)) return false;
    const offeredIds = new Set(offered.map((g) => g.id));
    this.groupsStore.allGroups.update((groups) =>
      groups.map((group) => {
        if (!offeredIds.has(group.id)) return group;
        const member = group.memberIds.includes(studentId);
        if (group.id === groupId) return member ? group : { ...group, memberIds: [...group.memberIds, studentId] };
        return member ? { ...group, memberIds: group.memberIds.filter((id) => id !== studentId) } : group;
      }),
    );
    return true;
  }

  /**
   * Am Tablet: Mit Server erst den neuesten Stand holen, dann wählen und sofort speichern, wie bei der
   * Schüler-Planung; mehrere Tablets schreiben so nicht gegeneinander.
   */
  chooseOnTablet(studentId: string, groupId: string, periodId: string): Promise<TransactResult> {
    return this.injector.get(ServerSync).transact(() => {
      const before = this.groupsStore.allGroups();
      return this.choose(studentId, groupId, periodId) ? () => this.groupsStore.allGroups.set(before) : false;
    });
  }

  startTablet(periodId: string, pin: string): void {
    this.tablet.set({ periodId, pin: pin.trim() });
  }

  stopTablet(): void {
    this.tablet.set(null);
  }
}

function parseTablet(data: unknown): GroupChoiceTablet | null {
  const t = data as Partial<GroupChoiceTablet> | null;
  if (typeof t?.periodId !== 'string') return null;
  return { periodId: t.periodId, pin: typeof t.pin === 'string' ? t.pin : '' };
}
