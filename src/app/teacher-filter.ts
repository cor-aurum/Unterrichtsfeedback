import { computed, inject, Injectable } from '@angular/core';
import { ConfigStore } from './config.store';
import { storedSignal } from './stored-signal';

/**
 * Lehrerfilter unter „Stunden erfassen“ für Personen- und Gruppenliste; `null` zeigt alle. Gilt nur auf
 * diesem Gerät. Gibt es den gewählten Lehrer nicht mehr, sind wieder alle zu sehen.
 */
@Injectable({ providedIn: 'root' })
export class TeacherFilter {
  private readonly config = inject(ConfigStore).config;
  private readonly selected = storedSignal<string | null>('feedback.teacherFilter', () => null, (data) =>
    typeof data === 'string' ? data : null,
  );
  readonly teacherId = computed(() => {
    const id = this.selected();
    return this.config().teachers.some((t) => t.id === id) ? id : null;
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
