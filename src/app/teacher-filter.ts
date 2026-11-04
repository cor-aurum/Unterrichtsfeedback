import { computed, inject, Injectable } from '@angular/core';
import { ReportPeriod } from './report-period';
import { storedSignal } from './stored-signal';

/**
 * Lehrerfilter für Personen- und Gruppenliste; `null` zeigt alle. Gilt nur auf diesem Gerät. Zur Wahl stehen die
 * Lehrer des gewählten Berichtszeitraums; ist der gewählte dort nicht (mehr) dabei, sind wieder alle zu sehen.
 */
@Injectable({ providedIn: 'root' })
export class TeacherFilter {
  /** Lehrer, nach denen sich filtern lässt */
  readonly options = inject(ReportPeriod).teachers;
  private readonly selected = storedSignal<string | null>('feedback.teacherFilter', () => null, (data) =>
    typeof data === 'string' ? data : null,
  );
  readonly teacherId = computed(() => {
    const id = this.selected();
    return this.options().some((t) => t.id === id) ? id : null;
  });

  set(teacherId: string | null): void {
    this.selected.set(teacherId || null);
  }

  /** Passt der Lehrer zum Filter? */
  shows(teacherId: string): boolean {
    const selected = this.teacherId();
    return selected === null || selected === teacherId;
  }
}
