import { computed, effect, inject, Injectable, untracked } from '@angular/core';
import { Appointment, ownerOf, withLessonAppointments } from './calendar/appointments';
import { CalendarStore } from './calendar/calendar.store';
import { ConfigStore } from './config.store';
import { withPeriodMembership } from './period-membership';
import { ReportPeriod } from './report-period';
import { Group, groupLabel, groupTeacherOf, Lesson, lessonAt, newId, Teacher, teacherOf, today } from './model';
import { storedSignal } from './stored-signal';
import { isRecord, parseLesson, sortedLessons, StudentsStore } from './students.store';

/**
 * Gruppen und ihre Gruppenstunden. Gruppenstunden gehören der Gruppe, nutzen die Gruppen-Abschnitte der
 * Konfiguration und erscheinen im Gruppen-PDF, nicht in den PDFs der Mitglieder. Jede Gruppe gilt für einen
 * Berichtszeitraum; `groups` sind die des gewählten.
 */
@Injectable({ providedIn: 'root' })
export class GroupsStore {
  private readonly studentsStore = inject(StudentsStore);
  private readonly calendar = inject(CalendarStore);
  private readonly config = inject(ConfigStore).config;
  private readonly reportPeriod = inject(ReportPeriod);
  private readonly periodId = computed(() => this.reportPeriod.period().id);

  /** Gruppen aller Zeiträume, z. B. für Sicherung und Synchronisation */
  readonly allGroups = storedSignal<Group[]>('feedback.groups', () => [], parseGroups);
  readonly groups = computed(() => this.allGroups().filter((group) => group.periodId === this.periodId()));
  readonly selectedGroupId = storedSignal<string | null>('feedback.selectedGroup', () => null);
  readonly selectedLessonId = storedSignal<string | null>('feedback.selectedGroupLesson', () => null, (data) =>
    typeof data === 'string' ? data : null,
  );
  readonly selectedGroup = computed(() => this.groups().find((g) => g.id === this.selectedGroupId()));
  readonly selectedLesson = computed(() => this.selectedGroup()?.lessons.find((l) => l.id === this.selectedLessonId()));

  constructor() {
    // Wer eine Person auswählt (auch aus dem Kalender), verlässt die Gruppe.
    effect(() => {
      if (this.studentsStore.selectedStudentId()) this.selectedGroupId.set(null);
    });
    // Gruppenstunden mit Uhrzeit stehen im Kalender des Lehrers der Gruppe.
    effect(() => {
      const appointments = this.calendar.appointments();
      const next = withLessonAppointments(appointments, this.allGroups(), 'group', this.config().calendar.defaultDurationMinutes);
      if (next !== appointments) this.calendar.appointments.set(next);
    });
    // Ältere Daten, auch aus einer Sicherung oder der Synchronisation, bekommen ihre Berichtszeiträume.
    effect(() => {
      const data = { students: this.studentsStore.allStudents(), groups: this.allGroups() };
      const periods = this.config().reportPeriods;
      const migrated = untracked(() =>
        withPeriodMembership({ ...data, appointments: this.calendar.appointments() }, periods, today()),
      );
      if (!migrated) return;
      this.studentsStore.allStudents.set(migrated.students);
      this.allGroups.set(migrated.groups);
    });
  }

  /**
   * Termine im Kalender des Lehrers: die seiner Personen und Gruppen, außer sie sind ausnahmsweise einem anderen
   * Lehrer zugeordnet, und Termine anderer Personen, die ausnahmsweise ihm zugeordnet sind.
   */
  calendarFilter(teacher: Teacher): (appointment: Appointment) => boolean {
    const owners = this.calendarOwnerIds(teacher);
    return (appointment) => (appointment.teacherId ? appointment.teacherId === teacher.id : owners.has(ownerOf(appointment)));
  }

  /**
   * In wessen Kalender der Termin steht: bei Ausnahmen der eingetragene Lehrer, sonst der der Person oder Gruppe;
   * ohne beide der erste Lehrer.
   */
  calendarTeacherOf(appointment: Appointment): Teacher {
    const config = this.config();
    const exception = config.teachers.find((t) => t.id === appointment.teacherId);
    if (exception) return exception;
    const group = appointment.groupId ? this.allGroups().find((g) => g.id === appointment.groupId) : undefined;
    if (group) return groupTeacherOf(group, config);
    const student = appointment.studentId
      ? this.studentsStore.allStudents().find((s) => s.id === appointment.studentId)
      : undefined;
    return student ? teacherOf(student, config, this.periodId()) : config.teachers[0];
  }

  /** Anzeigename je Termin-Besitzer: der Name der Person oder „Gruppe …“, auch aus anderen Zeiträumen */
  readonly ownerNames = computed(() => {
    const students = this.studentsStore.allStudents();
    return new Map([
      ...students.map((student) => [student.id, student.name] as const),
      ...this.allGroups().map((group) => [group.id, `Gruppe ${groupLabel(group, students)}`] as const),
    ]);
  });

  /** Gruppen jeder Person, nach Namen sortiert; Personen ohne Gruppe fehlen in der Map. */
  readonly groupsByStudent = computed(() => {
    const students = this.studentsStore.students();
    const sorted = [...this.groups()].sort((a, b) => groupLabel(a, students).localeCompare(groupLabel(b, students), 'de'));
    const byStudent = new Map<string, Group[]>();
    for (const group of sorted) {
      for (const id of group.memberIds) byStudent.set(id, [...(byStudent.get(id) ?? []), group]);
    }
    return byStudent;
  });

  groupsOf(studentId: string): Group[] {
    return this.groupsByStudent().get(studentId) ?? [];
  }

  /** IDs der Personen und Gruppen des Lehrers im gewählten Berichtszeitraum */
  calendarOwnerIds(teacher: Teacher): Set<string> {
    const config = this.config();
    const periodId = this.periodId();
    return new Set([
      ...this.studentsStore.students().filter((s) => teacherOf(s, config, periodId).id === teacher.id).map((s) => s.id),
      ...this.groups().filter((g) => groupTeacherOf(g, config).id === teacher.id).map((g) => g.id),
    ]);
  }

  /** Neue Gruppen gelten im gewählten Berichtszeitraum. */
  add(teacherId: string | null): void {
    const group = this.newGroup('', teacherId);
    this.allGroups.update((groups) => [...groups, group]);
    this.select(group.id);
  }

  /**
   * Legt Gruppen mit diesen Namen im gewählten Zeitraum an, ohne Mitglieder; Namen, die es dort schon gibt,
   * entfallen. Gibt die Zahl der neuen Gruppen zurück.
   */
  addNamed(entries: { name: string; teacherId: string | null }[]): number {
    const known = new Set(this.groups().map((group) => group.name.trim().toLowerCase()));
    const added: Group[] = [];
    for (const { name, teacherId } of entries) {
      const key = name.trim().toLowerCase();
      if (!key || known.has(key)) continue;
      known.add(key);
      added.push(this.newGroup(name.trim(), teacherId));
    }
    if (added.length > 0) this.allGroups.update((groups) => [...groups, ...added]);
    return added.length;
  }

  /**
   * Legt Gruppen mit Namen und Mitgliedern im gewählten Zeitraum an, z. B. aus der Gruppenplanung; die Auswahl
   * bleibt unverändert. Gibt die IDs der neuen Gruppen zurück.
   */
  createGroups(entries: { name: string; teacherId: string | null; memberIds: string[] }[]): string[] {
    const created = entries.map(({ name, teacherId, memberIds }) => ({
      ...this.newGroup(name.trim(), teacherId),
      memberIds: [...new Set(memberIds)],
    }));
    this.allGroups.update((groups) => [...groups, ...created]);
    return created.map((group) => group.id);
  }

  /** Nimmt Personen in die Gruppe auf; wer schon Mitglied ist, bleibt es. */
  addMembers(groupId: string, studentIds: string[]): void {
    this.mutate(groupId, (group) => (group.memberIds = [...new Set([...group.memberIds, ...studentIds])]));
  }

  private newGroup(name: string, teacherId: string | null): Group {
    return { id: newId(), name, memberIds: [], teacherId, periodId: this.periodId(), lessons: [], generalTexts: {} };
  }

  update(groupId: string, change: Partial<Pick<Group, 'name' | 'teacherId'>>): void {
    this.mutate(groupId, (group) => Object.assign(group, change));
  }

  toggleMember(groupId: string, studentId: string): void {
    this.mutate(groupId, (group) => {
      group.memberIds = group.memberIds.includes(studentId)
        ? group.memberIds.filter((id) => id !== studentId)
        : [...group.memberIds, studentId];
    });
  }

  /** Mit der Gruppe entfallen ihre Gruppenstunden und Termine. */
  remove(groupId: string): void {
    this.allGroups.update((groups) => groups.filter((g) => g.id !== groupId));
    this.calendar.removeForOwner(groupId);
    if (this.selectedGroupId() === groupId) this.select(null);
  }

  /** Die Person ist im gewählten Zeitraum inaktiv und damit auch in keiner seiner Gruppen mehr. */
  leavePeriod(studentId: string): void {
    const periodId = this.periodId();
    this.allGroups.update((groups) =>
      groups.map((g) =>
        g.periodId === periodId && g.memberIds.includes(studentId)
          ? { ...g, memberIds: g.memberIds.filter((id) => id !== studentId) }
          : g,
      ),
    );
    this.studentsStore.removeFromPeriod(studentId);
  }

  /** Nach dem Zusammenführen zweier Personen: Mitglied ist die verbleibende. */
  replaceMember(from: string, into: string): void {
    this.allGroups.update((groups) =>
      groups.map((g) =>
        g.memberIds.includes(from)
          ? { ...g, memberIds: [...new Set(g.memberIds.map((id) => (id === from ? into : id)))] }
          : g,
      ),
    );
  }

  /** Nach dem Löschen einer Person: Sie ist in keiner Gruppe mehr. */
  removeMember(studentId: string): void {
    this.allGroups.update((groups) =>
      groups.map((g) => (g.memberIds.includes(studentId) ? { ...g, memberIds: g.memberIds.filter((id) => id !== studentId) } : g)),
    );
  }

  select(groupId: string | null): void {
    this.selectedGroupId.set(groupId);
    const group = this.groups().find((g) => g.id === groupId);
    this.selectedLessonId.set(group ? (sortedLessons(group).at(-1)?.id ?? null) : null);
    if (groupId) this.studentsStore.selectStudent(null);
  }

  /**
   * Wählt die Gruppenstunde zum Termin aus; gibt es noch keine, wird sie mit Datum und Uhrzeit angelegt – nur im
   * gewählten Berichtszeitraum, sonst `false`.
   */
  openLesson(groupId: string, date: string, time?: { start: string; durationMinutes?: number }): boolean {
    const group = this.groups().find((g) => g.id === groupId);
    if (!group) return false;
    let lesson = lessonAt(group, date, time?.start);
    if (lesson) {
      if (time && !lesson.start) this.mutateLesson(groupId, lesson.id, (l) => Object.assign(l, time));
    } else {
      if (!this.reportPeriod.contains(date)) return false;
      lesson = { id: newId(), date, ...time, checked: {}, texts: {} };
      const created = lesson;
      this.mutate(groupId, (g) => g.lessons.push(created));
    }
    this.selectedGroupId.set(groupId);
    this.selectedLessonId.set(lesson.id);
    this.studentsStore.selectStudent(null);
    return true;
  }

  removeLesson(groupId: string, lessonId: string): void {
    this.mutate(groupId, (group) => (group.lessons = group.lessons.filter((l) => l.id !== lessonId)));
    if (this.selectedLessonId() === lessonId) this.selectedLessonId.set(null);
  }

  /** Nur innerhalb des gewählten Berichtszeitraums, dem der Gruppe; sonst `false` */
  setLessonDate(groupId: string, lessonId: string, date: string): boolean {
    if (!this.reportPeriod.contains(date)) return false;
    this.mutateLesson(groupId, lessonId, (lesson) => (lesson.date = date));
    return true;
  }

  /** Ohne `start` hat die Stunde keine Uhrzeit mehr; die Länge gilt nur zusammen mit dem Beginn. */
  setLessonStart(groupId: string, lessonId: string, start: string): void {
    this.mutateLesson(groupId, lessonId, (lesson) => {
      if (start) {
        lesson.start = start;
      } else {
        delete lesson.start;
        delete lesson.durationMinutes;
      }
    });
  }

  /** Aus dem Kalender: Datum, Beginn und Dauer der Gruppenstunde ändern sich mit ihrem Termin. */
  setLessonTime(groupId: string, lessonId: string, time: { date: string; start: string; durationMinutes: number }): boolean {
    if (!this.reportPeriod.contains(time.date)) return false;
    this.mutateLesson(groupId, lessonId, (lesson) =>
      Object.assign(lesson, { date: time.date, start: time.start, durationMinutes: time.durationMinutes }),
    );
    return true;
  }

  toggleItem(groupId: string, lessonId: string, sectionId: string, itemId: string): void {
    this.mutateLesson(groupId, lessonId, (lesson) => {
      const checked = lesson.checked[sectionId] ?? [];
      lesson.checked[sectionId] = checked.includes(itemId) ? checked.filter((id) => id !== itemId) : [...checked, itemId];
    });
  }

  setText(groupId: string, lessonId: string, sectionId: string, text: string): void {
    this.mutateLesson(groupId, lessonId, (lesson) => (lesson.texts[sectionId] = text));
  }

  setGeneralText(groupId: string, sectionId: string, text: string): void {
    this.mutate(groupId, (group) => (group.generalTexts[sectionId] = text));
  }

  private mutateLesson(groupId: string, lessonId: string, change: (lesson: Lesson) => void): void {
    this.mutate(groupId, (group) => {
      const lesson = group.lessons.find((l) => l.id === lessonId);
      if (lesson) change(lesson);
    });
  }

  private mutate(groupId: string, change: (group: Group) => void): void {
    this.allGroups.update((groups) =>
      groups.map((group) => {
        if (group.id !== groupId) return group;
        const copy = structuredClone(group);
        change(copy);
        return copy;
      }),
    );
  }
}

export function parseGroups(data: unknown): Group[] {
  if (!Array.isArray(data)) return [];
  return data
    .filter((g: Partial<Group>) => typeof g?.id === 'string')
    .map((g: Partial<Group>) => ({
      id: g.id!,
      name: typeof g.name === 'string' ? g.name : '',
      memberIds: Array.isArray(g.memberIds) ? g.memberIds.filter((id) => typeof id === 'string') : [],
      teacherId: typeof g.teacherId === 'string' ? g.teacherId : null,
      // Ältere Gruppen haben noch keinen Zeitraum; ihn ergänzt `withPeriodMembership`.
      periodId: typeof g.periodId === 'string' ? g.periodId : '',
      // Ältere Gruppen haben noch keine eigenen Stunden.
      lessons: Array.isArray(g.lessons) ? g.lessons.map(parseLesson) : [],
      generalTexts: isRecord(g.generalTexts) ? g.generalTexts : {},
    }));
}
