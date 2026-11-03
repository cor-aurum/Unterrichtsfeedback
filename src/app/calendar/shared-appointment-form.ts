import { Component, computed, inject, input, linkedSignal, output } from '@angular/core';
import { ConfigStore } from '../config.store';
import { activeTeachersOn } from '../model';
import { CalendarStore } from './calendar.store';
import { RecurrenceFields } from './recurrence-fields';
import { SharedAppointment } from './shared-appointments';

/** Formularinhalt; `id` ist bei einem neuen Termin `null`. */
export type SharedDraft = Omit<SharedAppointment, 'id'> & { id: string | null };

/** Neuer allgemeiner Termin am Tag: vorausgewählt sind die Lehrer, die dann im Berichtszeitraum aktiv sind. */
export function newSharedDraft(config: ConfigStore['config'], date: string): SharedDraft {
  const settings = config().calendar;
  return {
    id: null,
    title: '',
    date,
    start: '15:00',
    durationMinutes: Math.max(60, settings.defaultDurationMinutes),
    location: '',
    teacherIds: activeTeachersOn(config(), date).map((teacher) => teacher.id),
    blocksPlanning: true,
  };
}

/** Formular für einen Termin mehrerer Lehrer, z. B. eine Konferenz */
@Component({
  selector: 'app-shared-appointment-form',
  imports: [RecurrenceFields],
  templateUrl: './shared-appointment-form.html',
  styleUrl: './shared-appointment-form.scss',
})
export class SharedAppointmentForm {
  private readonly calendar = inject(CalendarStore);
  protected readonly config = inject(ConfigStore).config;

  readonly initial = input.required<SharedDraft>();
  readonly closed = output<void>();

  protected readonly draft = linkedSignal(() => this.initial());
  protected readonly error = linkedSignal<SharedDraft, string | null>({ source: this.initial, computation: () => null });
  protected readonly teachers = computed(() => this.config().teachers);

  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected set(change: Partial<SharedDraft>): void {
    this.draft.update((draft) => ({ ...draft, ...change }));
  }

  protected toggleTeacher(teacherId: string): void {
    const ids = this.draft().teacherIds;
    this.set({ teacherIds: ids.includes(teacherId) ? ids.filter((id) => id !== teacherId) : [...ids, teacherId] });
  }

  protected save(): void {
    const { id, ...appointment } = this.draft();
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
    if (confirm(`Möchtest du ${what} für alle beteiligten Lehrer löschen?`)) {
      this.calendar.removeShared(id);
      this.closed.emit();
    }
  }

  private problemOf(appointment: Omit<SharedAppointment, 'id'>): string | null {
    if (!appointment.title.trim()) return 'Bitte gib dem Termin eine Bezeichnung, z. B. „Konferenz“.';
    if (!appointment.date || !appointment.start) return 'Bitte Datum und Beginn angeben.';
    if (!(appointment.durationMinutes >= 5)) return 'Die Dauer muss mindestens 5 Minuten betragen.';
    if (appointment.teacherIds.length === 0) return 'Bitte mindestens einen Lehrer auswählen.';
    return null;
  }
}
