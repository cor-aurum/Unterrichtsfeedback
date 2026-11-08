import { Component, computed, inject, input, linkedSignal, output } from '@angular/core';
import { ConfigStore } from '../config.store';
import { GroupsStore } from '../groups.store';
import { ActiveTeacher } from '../active-teacher';
import { activeTeachersOn, containsDate, Group, groupLabel, groupTeacherOf } from '../model';
import { StudentsStore } from '../students.store';
import { CalendarStore } from './calendar.store';
import { RecurrenceFields } from './recurrence-fields';
import { SharedAppointment } from './shared-appointments';

/** Formularinhalt; `id` ist bei einem neuen Termin `null`. */
export type SharedDraft = Omit<SharedAppointment, 'id'> & { id: string | null };

/** Neuer allgemeiner Termin am Tag: für alle Lehrkräfte des Berichtszeitraums, auch später dazukommende. */
export function newSharedDraft(config: ConfigStore['config'], date: string, start = '15:00'): SharedDraft {
  const settings = config().calendar;
  return {
    id: null,
    title: '',
    date,
    start,
    durationMinutes: Math.max(60, settings.defaultDurationMinutes),
    location: '',
    teacherIds: [],
    allTeachers: true,
    blocksPlanning: true,
  };
}

/**
 * Formular für einen Termin mehrerer Lehrkräfte, z. B. eine Konferenz. Er gehört zum Berichtszeitraum seines
 * Datums: Dabei sein können nur dessen Lehrkräfte.
 */
@Component({
  selector: 'app-shared-appointment-form',
  imports: [RecurrenceFields],
  templateUrl: './shared-appointment-form.html',
  styleUrl: './shared-appointment-form.scss',
})
export class SharedAppointmentForm {
  private readonly calendar = inject(CalendarStore);
  private readonly groupsStore = inject(GroupsStore);
  private readonly studentsStore = inject(StudentsStore);
  private readonly activeTeacher = inject(ActiveTeacher);
  protected readonly config = inject(ConfigStore).config;

  readonly initial = input.required<SharedDraft>();
  /** Mit Text, wenn der Termin umgewandelt wurde; die Seite zeigt ihn als Hinweis. */
  readonly closed = output<string | void>();

  protected readonly draft = linkedSignal(() => this.initial());
  protected readonly error = linkedSignal<SharedDraft, string | null>({ source: this.initial, computation: () => null });
  /** Die Lehrkräfte des Berichtszeitraums am Tag des Termins, die man sehen darf */
  protected readonly teachers = computed(() =>
    activeTeachersOn(this.config(), this.draft().date).filter((t) => this.activeTeacher.isVisible(t.id)),
  );
  /** Name des Berichtszeitraums am Tag des Termins für den Hinweis; leer, wenn der Tag in keinem liegt */
  protected readonly periodName = computed(
    () => this.config().reportPeriods.find((p) => containsDate(p, this.draft().date))?.name ?? '',
  );
  protected readonly groups = computed(() =>
    [...this.groupsStore.groups()].sort((a, b) => this.groupName(a).localeCompare(this.groupName(b), 'de')),
  );
  /** Gruppen, die beim Umwandeln einen Gruppentermin bekommen; `null`, solange nicht umgewandelt wird */
  protected readonly convertGroupIds = linkedSignal<SharedDraft, string[] | null>({ source: this.initial, computation: () => null });

  protected groupName(group: Group): string {
    return groupLabel(group, this.studentsStore.students());
  }

  protected groupTeacherName(group: Group): string {
    return groupTeacherOf(group, this.config()).name;
  }

  /** Vorausgewählt: die Gruppen der Lehrer, die am allgemeinen Termin teilnehmen */
  protected startConverting(): void {
    const draft = this.draft();
    const teacherIds = draft.allTeachers ? this.teachers().map((t) => t.id) : draft.teacherIds;
    this.convertGroupIds.set(
      this.groups().filter((group) => teacherIds.includes(groupTeacherOf(group, this.config()).id)).map((g) => g.id),
    );
  }

  protected toggleConvertGroup(groupId: string): void {
    this.convertGroupIds.update((ids) =>
      ids && (ids.includes(groupId) ? ids.filter((id) => id !== groupId) : [...ids, groupId]),
    );
  }

  /** Legt je Gruppe einen Gruppentermin mit Zeit und Wiederholung des Formulars an und löscht den allgemeinen Termin. */
  protected convert(): void {
    const { id, date, start, durationMinutes, repeat } = this.draft();
    const groupIds = this.convertGroupIds() ?? [];
    if (!id || groupIds.length === 0) return;
    groupIds.forEach((groupId) => this.calendar.add({ groupId, date, start, durationMinutes, ...(repeat ? { repeat } : {}) }));
    this.calendar.removeShared(id);
    this.closed.emit(
      `${groupIds.length === 1 ? '1 Gruppentermin' : `${groupIds.length} Gruppentermine`} angelegt, der allgemeine Termin ist gelöscht.`,
    );
  }

  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected set(change: Partial<SharedDraft>): void {
    this.draft.update((draft) => ({ ...draft, ...change }));
  }

  /** Alle Lehrkräfte des Zeitraums (auch später dazukommende) oder ausgewählte; beim Abwählen sind alle angehakt. */
  protected setAllTeachers(all: boolean): void {
    this.set(all ? { allTeachers: true, teacherIds: [] } : { allTeachers: false, teacherIds: this.teachers().map((t) => t.id) });
  }

  protected toggleTeacher(teacherId: string): void {
    const ids = this.draft().teacherIds;
    this.set({ teacherIds: ids.includes(teacherId) ? ids.filter((id) => id !== teacherId) : [...ids, teacherId] });
  }

  /** Lehrkräfte aus anderen Zeiträumen (z. B. nach Änderung des Datums) fallen weg. */
  protected save(): void {
    const { id, ...rest } = this.draft();
    const allowed = new Set(activeTeachersOn(this.config(), rest.date).map((t) => t.id));
    const appointment = rest.allTeachers
      ? { ...rest, teacherIds: [] }
      : { ...rest, allTeachers: false, teacherIds: rest.teacherIds.filter((teacherId) => allowed.has(teacherId)) };
    const problem = this.problemOf(appointment);
    if (problem) {
      this.error.set(problem);
      return;
    }
    const cleaned = { ...appointment, title: appointment.title.trim(), location: appointment.location.trim() };
    if (id) {
      this.calendar.updateShared(id, cleaned);
    } else {
      this.calendar.addShared(cleaned);
    }
    this.closed.emit();
  }

  protected remove(): void {
    const { id, repeat } = this.draft();
    if (!id) return;
    const what = repeat ? 'die Terminserie mit allen Wiederholungen' : 'den Termin';
    if (confirm(`Möchtest du ${what} für alle beteiligten Lehrkräfte löschen?`)) {
      this.calendar.removeShared(id);
      this.closed.emit();
    }
  }

  private problemOf(appointment: Omit<SharedAppointment, 'id'>): string | null {
    if (!appointment.title.trim()) return 'Bitte gib dem Termin eine Bezeichnung, z. B. „Konferenz“.';
    if (!appointment.date || !appointment.start) return 'Bitte Datum und Beginn angeben.';
    if (!(appointment.durationMinutes >= 5)) return 'Die Dauer muss mindestens 5 Minuten betragen.';
    if (!appointment.allTeachers && appointment.teacherIds.length === 0) {
      return 'Bitte mindestens eine Lehrkraft des Berichtszeitraums auswählen.';
    }
    return null;
  }
}
