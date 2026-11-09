import { Component, computed, inject, linkedSignal, output, signal } from '@angular/core';
import { ActiveTeacher } from '../active-teacher';
import { addDays } from '../calendar/appointments';
import { formatShortDate, Teacher, today } from '../model';
import { ReportPeriod } from '../report-period';
import { storedSignal } from '../stored-signal';
import { ServerSync } from '../sync/server-sync';
import { StudentPlanning } from './student-planning';

/**
 * Startet die Schüler-Planung im gewählten Berichtszeitraum für eine oder mehrere seiner Lehrkräfte; vorausgewählt
 * ist der aktive Lehrer. Bei mehreren wählt, wer im Zeitraum noch keinen Termin hat, am Tablet erst seinen Lehrer. Die Höchstzahl je Person ist
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
  private readonly reportPeriod = inject(ReportPeriod);
  protected readonly period = this.reportPeriod.period;
  /** Nur mit Server lassen sich mehrere Tablets gleichzeitig verwenden. */
  private readonly sync = inject(ServerSync);
  protected readonly withServer = computed(() => this.sync.status() !== 'off');

  /** Die Lehrkräfte des Zeitraums (und der aktive Lehrer, falls er dort fehlt) */
  protected readonly candidates = computed(() => this.reportPeriod.teachersWith(this.teacher().id));
  private readonly selectedIds = linkedSignal<string[]>(() => [this.teacher().id]);
  /** Die angehakten in der Reihenfolge des Zeitraums */
  protected readonly teacherIds = computed(() =>
    this.candidates()
      .map((t) => t.id)
      .filter((id) => this.selectedIds().includes(id)),
  );

  /** Ab morgen (oder ab Beginn des Zeitraums) bis zu seinem Ende */
  protected readonly from = linkedSignal(() => maxDate(addDays(today(), 1), this.period().from));
  protected readonly to = linkedSignal(() => this.period().to);
  protected readonly fair = computed(() =>
    this.planning.fairShare(this.teacherIds(), this.period().id, this.from(), this.to()),
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

  protected isIncluded(teacher: Teacher): boolean {
    return this.selectedIds().includes(teacher.id);
  }

  protected toggleTeacher(teacher: Teacher): void {
    this.selectedIds.update((ids) => (ids.includes(teacher.id) ? ids.filter((id) => id !== teacher.id) : [...ids, teacher.id]));
  }

  protected setMax(event: Event): void {
    const value = parseInt(this.valueOf(event), 10);
    this.max.set(Number.isFinite(value) && value >= 0 ? value : null);
  }

  protected start(): void {
    this.planning.start({
      teacherIds: this.teacherIds(),
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
