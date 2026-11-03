import { computed, inject, Injectable } from '@angular/core';
import { ConfigStore, isPeriod } from './config.store';
import { containsDate, formatDate, Lesson, Period, ReportPeriodEntry, today } from './model';
import { storedSignal } from './stored-signal';

/** Früher galt ein unbenannter Zeitraum nur auf dem Gerät; er wird beim ersten Start übernommen. */
const LEGACY_KEY = 'feedback.reportPeriod';

/**
 * Der gerade geltende Berichtszeitraum. Die Zeiträume selbst stehen in der Konfiguration (und damit in der
 * Synchronisation); welcher gilt, wählt jedes Gerät selbst. Ohne Wahl gilt der, in dem heute liegt.
 */
@Injectable({ providedIn: 'root' })
export class ReportPeriod {
  private readonly configStore = inject(ConfigStore);
  private readonly selectedId = storedSignal<string | null>('feedback.reportPeriodId', () => null, (data) =>
    typeof data === 'string' ? data : null,
  );

  readonly periods = computed(() => this.configStore.config().reportPeriods);
  readonly period = computed(
    () => this.periods().find((p) => p.id === this.selectedId()) ?? currentPeriod(this.periods()),
  );
  readonly label = computed(() => labelOf(this.period()));

  constructor() {
    this.adoptLegacyPeriod();
  }

  select(periodId: string): void {
    this.selectedId.set(periodId);
  }

  contains(date: string): boolean {
    return containsDate(this.period(), date);
  }

  /** Stunden einer Person oder Gruppe im Zeitraum */
  lessonsOf(owner: { lessons: Lesson[] }): Lesson[] {
    return owner.lessons.filter((lesson) => this.contains(lesson.date));
  }

  /** Ein auf diesem Gerät gewählter Zeitraum einer älteren Version wird zum benannten Zeitraum. */
  private adoptLegacyPeriod(): void {
    const legacy = readLegacyPeriod();
    if (!legacy) return;
    const existing = this.periods().find((p) => p.from === legacy.from && p.to === legacy.to);
    const teacherIds = this.configStore.config().teachers.map((t) => t.id);
    this.select(existing?.id ?? this.configStore.addReportPeriod({ name: 'Berichtszeitraum', ...legacy, teacherIds }));
    localStorage.removeItem(LEGACY_KEY);
  }
}

export function labelOf(period: ReportPeriodEntry): string {
  return `${period.name} (${formatDate(period.from)} – ${formatDate(period.to)})`;
}

/** Der Zeitraum, in dem heute liegt (bei mehreren der zuletzt begonnene), sonst der zuletzt begonnene. */
function currentPeriod(periods: ReportPeriodEntry[]): ReportPeriodEntry {
  const byStart = [...periods].sort((a, b) => a.from.localeCompare(b.from));
  const date = today();
  return byStart.filter((p) => containsDate(p, date)).at(-1) ?? byStart.filter((p) => p.from <= date).at(-1) ?? byStart[0];
}

function readLegacyPeriod(): Period | null {
  try {
    const data = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? 'null');
    return isPeriod(data) ? { from: data.from, to: data.to } : null;
  } catch {
    return null;
  }
}
