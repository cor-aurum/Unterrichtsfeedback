import { Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ActiveTeacher } from '../active-teacher';
import { ConfigStore } from '../config.store';
import { GroupsStore } from '../groups.store';
import { Group, groupLabel, groupMembers, groupTeacherOf, instrumentOf, Student, Teacher, today } from '../model';
import { ReportPeriod } from '../report-period';
import { StudentLabelPipe } from '../student-label.pipe';
import { StudentsStore } from '../students.store';
import { TeacherFilter } from '../teacher-filter';
import { AgeChart, ChartGroup } from './age-chart';
import { ageOn, ageStats, formatAge, instrumentCounts, planAgeGroups, planByAge } from './age-groups';

/** Mögliche Anzahl Gruppen bei der automatischen Einteilung */
const GROUP_COUNTS = [2, 3, 4, 5, 6, 7, 8];

/**
 * - `mixed`: Gruppen mit möglichst ähnlichem Altersgefüge
 * - `byAge`: nach Alter, die jüngsten in die erste Gruppe, die ältesten in die letzte
 */
type PlanMode = 'mixed' | 'byAge';

/**
 * Gruppen des gewählten Berichtszeitraums planen: auf einen Blick sehen, wer noch in keiner Gruppe ist, Personen
 * gesammelt zuordnen und Gruppen mit ähnlichem Altersgefüge automatisch vorschlagen lassen. Gruppenstunden
 * erfasst man weiter unter „Stunden erfassen“.
 */
@Component({
  selector: 'app-group-planning-page',
  imports: [RouterLink, AgeChart, StudentLabelPipe],
  templateUrl: './group-planning-page.html',
  styleUrl: './group-planning-page.scss',
})
export class GroupPlanningPage {
  private readonly studentsStore = inject(StudentsStore);
  private readonly groupsStore = inject(GroupsStore);
  private readonly config = inject(ConfigStore).config;
  private readonly activeTeacher = inject(ActiveTeacher);
  protected readonly teacherFilter = inject(TeacherFilter);
  protected readonly reportPeriod = inject(ReportPeriod);
  protected readonly today = today();
  protected readonly groupCounts = GROUP_COUNTS;
  protected readonly message = signal<string | null>(null);

  /** Personen des Zeitraums, die zum Lehrerfilter passen, nach Namen */
  protected readonly students = computed(() =>
    this.studentsStore.sortedStudents().filter((s) => this.teacherFilter.shows(this.studentsStore.teacherOf(s).id)),
  );
  /** Gruppen des Zeitraums, die zum Lehrerfilter passen, nach Namen */
  protected readonly groups = computed(() =>
    this.groupsStore
      .groups()
      .filter((group) => this.teacherFilter.shows(groupTeacherOf(group, this.config()).id))
      .sort((a, b) => this.label(a).localeCompare(this.label(b), 'de')),
  );
  protected readonly unassigned = computed(() =>
    this.students().filter((student) => this.groupsStore.groupsOf(student.id).length === 0),
  );
  protected readonly showTeachers = computed(() => this.reportPeriod.teachers().length > 1);

  /** Lehrer neuer Gruppen: der gefilterte, sonst der aktive, wenn er im Zeitraum unterrichtet */
  private readonly defaultTeacherId = computed(() => {
    const teachers = this.reportPeriod.teachers();
    const active = this.activeTeacher.teacher().id;
    return this.teacherFilter.teacherId() ?? (teachers.some((t) => t.id === active) ? active : teachers[0]?.id) ?? active;
  });

  // --- Zuordnen ---
  protected readonly selected = signal(new Set<string>());
  /** ID der Zielgruppe oder `new` */
  protected readonly target = signal('new');
  protected readonly newGroupName = signal('');
  protected readonly allSelected = computed(
    () => this.unassigned().length > 0 && this.unassigned().every((s) => this.selected().has(s.id)),
  );

  protected toggle(studentId: string): void {
    this.selected.update((ids) => {
      const next = new Set(ids);
      if (!next.delete(studentId)) next.add(studentId);
      return next;
    });
  }

  protected selectAll(checked: boolean): void {
    this.selected.set(new Set(checked ? this.unassigned().map((s) => s.id) : []));
  }

  /** Ordnet die ausgewählten Personen der Zielgruppe zu; bei „Neue Gruppe“ entsteht sie dabei. */
  protected assign(): void {
    const ids = this.unassigned().filter((s) => this.selected().has(s.id)).map((s) => s.id);
    if (ids.length === 0) return;
    const count = ids.length === 1 ? '1 Person' : `${ids.length} Personen`;
    if (this.target() === 'new') {
      const name = this.newGroupName().trim() || this.nextGroupNames(1)[0];
      this.groupsStore.createGroups([{ name, teacherId: this.defaultTeacherId(), memberIds: ids }]);
      this.message.set(`Gruppe „${name}“ mit ${count} angelegt.`);
    } else {
      const group = this.groupsStore.groups().find((g) => g.id === this.target());
      if (!group) return;
      this.groupsStore.addMembers(group.id, ids);
      this.message.set(`${count} in „${this.label(group)}“ aufgenommen.`);
    }
    this.selected.set(new Set());
    this.newGroupName.set('');
  }

  // --- Gruppen ---
  protected label(group: Group): string {
    return groupLabel(group, this.studentsStore.allStudents());
  }

  protected members(group: Group): Student[] {
    return groupMembers(group, this.studentsStore.allStudents()).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  protected teacherId(group: Group): string {
    return groupTeacherOf(group, this.config()).id;
  }

  /** Lehrer des Zeitraums; der bisherige der Gruppe bleibt wählbar, auch wenn er dort nicht unterrichtet. */
  protected teachersFor(group: Group): Teacher[] {
    return this.reportPeriod.teachersWith(this.teacherId(group));
  }

  /** Die Gruppentermine wandern mit in den Kalender des neuen Lehrers. */
  protected setTeacher(group: Group, event: Event): void {
    const teacherId = (event.target as HTMLSelectElement).value;
    this.groupsStore.update(group.id, { teacherId });
    const teacher = this.reportPeriod.teachers().find((t) => t.id === teacherId);
    if (teacher) this.message.set(`„${this.label(group)}“ gehört jetzt zu ${teacher.name}.`);
  }

  /** z. B. „5 Personen · Ø 10,4 J. · 8,1–12,9 J.“ */
  protected statsText(members: Student[]): string {
    const stats = ageStats(members, this.today);
    const parts = [`${stats.count} ${stats.count === 1 ? 'Person' : 'Personen'}`];
    if (stats.mean !== null) {
      parts.push(`Ø ${formatAge(stats.mean)}`);
      parts.push(`${formatAge(stats.min!).replace(' J.', '')}–${formatAge(stats.max!)}`);
    }
    return parts.join(' · ');
  }

  /** z. B. „Klavier 2 · Gitarre 1“ */
  protected instrumentText(members: Student[]): string {
    return instrumentCounts(members, (s) => instrumentOf(s, this.config()).name);
  }

  protected ageText(student: Student): string {
    const age = ageOn(student, this.today);
    return age === null ? '' : formatAge(age);
  }

  protected addEmptyGroup(input: HTMLInputElement): void {
    const name = input.value.trim() || this.nextGroupNames(1)[0];
    this.groupsStore.createGroups([{ name, teacherId: this.defaultTeacherId(), memberIds: [] }]);
    input.value = '';
  }

  protected rename(group: Group, event: Event): void {
    this.groupsStore.update(group.id, { name: (event.target as HTMLInputElement).value.trim() });
  }

  protected removeMember(group: Group, student: Student): void {
    this.groupsStore.toggleMember(group.id, student.id);
  }

  protected deleteGroup(group: Group): void {
    if (confirm(`Gruppe „${this.label(group)}“ mit allen Gruppenstunden und Gruppenterminen löschen?`)) {
      this.groupsStore.remove(group.id);
    }
  }

  protected readonly existingChart = computed<ChartGroup[]>(() =>
    this.groups().map((group) => ({ name: this.label(group), members: this.members(group) })),
  );

  // --- Automatisch einteilen ---
  protected readonly poolKind = signal<'unassigned' | 'all'>('unassigned');
  protected readonly pool = computed(() => (this.poolKind() === 'all' ? this.students() : this.unassigned()));
  protected readonly poolWithoutBirthDate = computed(() => this.pool().filter((s) => !s.birthDate).length);
  protected readonly groupCount = signal(2);
  protected readonly mode = signal<PlanMode>('mixed');
  /** Bei „Gemischt“: jedes Instrument möglichst gleichmäßig auf die Gruppen verteilen */
  protected readonly balanceInstruments = signal(false);
  /** Bei der Einteilung nach Alter: Personen ohne Geburtsdatum, die keiner Gruppe zugeordnet wurden */
  protected readonly leftOut = signal<Student[]>([]);
  protected readonly planTeacherId = linkedSignal(() => this.defaultTeacherId());
  protected readonly proposal = signal<ChartGroup[] | null>(null);
  /** Hinweis direkt bei der automatischen Einteilung */
  protected readonly planMessage = signal<string | null>(null);

  protected valueOf(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  protected plan(): void {
    const count = this.groupCount();
    const byAge = this.mode() === 'byAge';
    // Nach Alter lassen sich nur Personen mit Geburtsdatum einteilen.
    const usable = byAge ? this.pool().filter((s) => s.birthDate) : this.pool();
    if (usable.length < count) {
      const who = byAge ? 'Personen mit Geburtsdatum' : 'Personen';
      this.planMessage.set(`Für ${count} Gruppen braucht es mindestens ${count} ${who}; ausgewählt sind ${usable.length}.`);
      this.proposal.set(null);
      return;
    }
    const names = this.nextGroupNames(count);
    const instrument = this.balanceInstruments() ? (s: Student) => instrumentOf(s, this.config()).id : undefined;
    const planned = byAge
      ? planByAge(this.pool(), count)
      : { groups: planAgeGroups(this.pool(), count, this.today, instrument), withoutAge: [] };
    this.proposal.set(planned.groups.map((members, i) => ({ name: names[i], members })));
    this.leftOut.set(planned.withoutAge);
    this.planMessage.set(null);
  }

  protected leftNames(): string {
    return this.leftOut().map((s) => this.studentsStore.label(s)).join(', ');
  }

  protected renameProposal(index: number, event: Event): void {
    const name = (event.target as HTMLInputElement).value;
    this.proposal.update((groups) => groups?.map((g, i) => (i === index ? { ...g, name } : g)) ?? null);
  }

  /** Speichert den Vorschlag als neue Gruppen im gewählten Zeitraum. */
  protected saveProposal(): void {
    const groups = this.proposal();
    if (!groups) return;
    const fallback = this.nextGroupNames(groups.length);
    this.groupsStore.createGroups(
      groups.map((group, i) => ({
        name: group.name.trim() || fallback[i],
        teacherId: this.planTeacherId(),
        memberIds: group.members.map((m) => m.id),
      })),
    );
    this.proposal.set(null);
    const left = this.leftOut().length;
    this.leftOut.set([]);
    const rest = left > 0 ? ` ${left === 1 ? '1 Person' : left + ' Personen'} ohne Geburtsdatum noch zuordnen.` : '';
    this.planMessage.set(`${groups.length} Gruppen in „${this.reportPeriod.period().name}“ angelegt.${rest}`);
  }

  /**
   * „A“, „B“, … – ohne „Gruppe“ davor, das setzt die App bei der Anzeige selbst dazu. Namen, die es im Zeitraum
   * schon gibt, werden übersprungen.
   */
  private nextGroupNames(count: number): string[] {
    const used = new Set(this.groupsStore.groups().map((g) => g.name.trim().toLowerCase()));
    const names: string[] = [];
    for (let i = 0; names.length < count; i++) {
      const name = i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
      if (!used.has(name.toLowerCase())) names.push(name);
    }
    return names;
  }
}
