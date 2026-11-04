import { Component, computed, inject, linkedSignal, output, signal } from '@angular/core';
import { ActiveTeacher } from '../active-teacher';
import { addDays } from '../calendar/appointments';
import { formatShortDate, today } from '../model';
import { ReportPeriod } from '../report-period';
import { storedSignal } from '../stored-signal';
import { StudentPlanning } from './student-planning';

/**
 * Startet die Schüler-Planung für den aktiven Lehrer im gewählten Berichtszeitraum. Die Höchstzahl je Person ist
 * anfangs der faire Anteil; wer in Runden planen will, startet erst mit weniger und später erneut mit mehr.
 */
@Component({
  selector: 'app-planning-setup-panel',
  templateUrl: './planning-setup-panel.html',
  styleUrl: './planning-setup-panel.scss',
})
export class PlanningSetupPanel {
  readonly closed = output<void>();

  private readonly planning = inject(StudentPlanning);
  protected readonly teacher = inject(ActiveTeacher).teacher;
  protected readonly period = inject(ReportPeriod).period;

  /** Ab morgen (oder ab Beginn des Zeitraums) bis zu seinem Ende */
  protected readonly from = linkedSignal(() => maxDate(addDays(today(), 1), this.period().from));
  protected readonly to = linkedSignal(() => this.period().to);
  protected readonly fair = computed(() =>
    this.planning.fairShare(this.teacher().id, this.period().id, this.from(), this.to()),
  );
  /** Leer: der faire Anteil */
  protected readonly max = signal<number | null>(null);
  protected readonly effectiveMax = computed(() => this.max() ?? this.fair().share);
  /** Gilt nur auf diesem Gerät und wird für die nächste Planung vorgeschlagen. */
  protected readonly pin = storedSignal<string>('feedback.planningPin', () => '');
  protected readonly formatShortDate = formatShortDate;

  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected setMax(event: Event): void {
    const value = parseInt(this.valueOf(event), 10);
    this.max.set(Number.isFinite(value) && value >= 0 ? value : null);
  }

  protected start(): void {
    this.planning.start({
      teacherId: this.teacher().id,
      periodId: this.period().id,
      from: this.from(),
      to: this.to(),
      maxPerStudent: this.effectiveMax(),
      pin: this.pin().trim(),
    });
  }
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}
