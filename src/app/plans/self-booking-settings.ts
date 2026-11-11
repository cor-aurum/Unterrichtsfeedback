import { Component, computed, inject, input, linkedSignal, output, signal } from '@angular/core';
import { ActiveTeacher } from '../active-teacher';
import { addDays } from '../calendar/appointments';
import { ConfigStore } from '../config.store';
import { activeSelfBooking, formatShortDate, periodTeachers, ReportPeriodEntry, SelfBooking, Teacher, today } from '../model';
import { StudentPlanning } from '../planning/student-planning';

/**
 * Selbsteintragung über den Download-Link, beim Link des Berichtszeitraums: Wie am Tablet tragen sich die Personen
 * der gewählten Lehrkräfte selbst für Einzeltermine ein, nur jede auf ihrer eigenen Seite. Die Einstellung gehört
 * zum Zeitraum und gilt damit für alle seine Lehrkräfte.
 */
@Component({
  selector: 'app-self-booking-settings',
  templateUrl: './self-booking-settings.html',
  styleUrl: './self-booking-settings.scss',
})
export class SelfBookingSettings {
  readonly period = input.required<ReportPeriodEntry>();
  /** Nach dem Starten, Ändern oder Beenden: Die Pläne sollen gleich neu an den Server. */
  readonly changed = output<void>();

  private readonly configStore = inject(ConfigStore);
  private readonly planning = inject(StudentPlanning);
  private readonly activeTeacher = inject(ActiveTeacher).teacher;

  protected readonly running = computed(() => activeSelfBooking(this.period()));
  protected readonly editing = signal(false);
  protected readonly candidates = computed(() => periodTeachers(this.configStore.config(), this.period()));

  private readonly selectedIds = linkedSignal<string[]>(() => this.running()?.teacherIds ?? this.defaultTeacherIds());
  /** Die angehakten in der Reihenfolge des Zeitraums */
  protected readonly teacherIds = computed(() =>
    this.candidates()
      .map((t) => t.id)
      .filter((id) => this.selectedIds().includes(id)),
  );
  protected readonly from = linkedSignal(() => this.running()?.from ?? latest(addDays(today(), 1), this.period().from));
  protected readonly to = linkedSignal(() => this.running()?.to ?? this.period().to);
  /** Leer: der faire Anteil */
  protected readonly max = linkedSignal<number | null>(() => this.running()?.maxPerStudent ?? null);
  protected readonly fair = computed(() => this.planning.fairShare(this.teacherIds(), this.period().id, this.from(), this.to(), true));
  protected readonly effectiveMax = computed(() => this.max() ?? this.fair().share);
  protected readonly valid = computed(
    () => this.teacherIds().length > 0 && this.from() <= this.to() && this.to() >= today() && this.effectiveMax() > 0,
  );
  protected readonly formatShortDate = formatShortDate;

  private defaultTeacherIds(): string[] {
    const own = this.activeTeacher().id;
    return this.period().teacherIds.includes(own) ? [own] : [];
  }

  protected names(ids: string[]): string {
    return this.candidates()
      .filter((t) => ids.includes(t.id))
      .map((t) => t.name)
      .join(', ');
  }

  protected isIncluded(teacher: Teacher): boolean {
    return this.selectedIds().includes(teacher.id);
  }

  protected toggleTeacher(teacher: Teacher): void {
    this.selectedIds.update((ids) => (ids.includes(teacher.id) ? ids.filter((id) => id !== teacher.id) : [...ids, teacher.id]));
  }

  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected setMax(event: Event): void {
    const value = parseInt(this.valueOf(event), 10);
    this.max.set(Number.isFinite(value) && value >= 0 ? value : null);
  }

  protected save(): void {
    if (!this.valid()) return;
    const selfBooking: SelfBooking = {
      teacherIds: this.teacherIds(),
      from: this.from(),
      to: this.to(),
      maxPerStudent: this.effectiveMax(),
    };
    this.configStore.setSelfBooking(this.period().id, selfBooking);
    this.editing.set(false);
    this.changed.emit();
  }

  protected stop(): void {
    const text =
      'Selbsteintragung beenden? Die Seiten bieten dann keine freien Zeiten mehr an. Schon gemachte Eintragungen bleiben.';
    if (!confirm(text)) return;
    this.configStore.setSelfBooking(this.period().id, null);
    this.editing.set(false);
    this.changed.emit();
  }
}

function latest(a: string, b: string): string {
  return a > b ? a : b;
}
