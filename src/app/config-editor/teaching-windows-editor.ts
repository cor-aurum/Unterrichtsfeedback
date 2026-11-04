import { Component, computed, inject, input, signal } from '@angular/core';
import { WEEKDAY_NAMES } from '../calendar/appointments';
import { ConfigStore } from '../config.store';
import { TeachingWindow, WindowsOwner } from '../model';

/**
 * Unterrichtszeiten je Wochentag bearbeiten: die eines Lehrers in einem Berichtszeitraum oder, ohne `teacherId`,
 * die gemeinsamen eines Zeitraums.
 */
@Component({
  selector: 'app-teaching-windows-editor',
  templateUrl: './teaching-windows-editor.html',
  styleUrl: './teaching-windows-editor.scss',
})
export class TeachingWindowsEditor {
  private readonly store = inject(ConfigStore);
  /** Ohne Lehrer: die gemeinsamen Zeiten des Zeitraums */
  readonly teacherId = input<string | null>(null);
  /** Bei einem Lehrer: `null` für seine Standardzeiten */
  readonly periodId = input.required<string | null>();

  protected readonly weekdays = WEEKDAY_NAMES.map((name, index) => ({ name, index }));
  protected readonly error = signal<string | null>(null);

  private readonly owner = computed<WindowsOwner>(() => {
    const teacherId = this.teacherId();
    const periodId = this.periodId();
    return teacherId ? { teacherId, periodId } : { sharedPeriodId: periodId! };
  });

  /** Zeitfenster je Wochentag, nach Beginn sortiert */
  protected readonly windowsByDay = computed(() => {
    const windows = this.store.windowsOf(this.owner());
    return this.weekdays.map((day) =>
      windows.filter((w) => w.weekday === day.index).sort((a, b) => a.from.localeCompare(b.from)),
    );
  });

  protected add(weekday: number): void {
    this.store.addTeachingWindow(this.owner(), weekday);
  }

  protected remove(window: TeachingWindow): void {
    this.store.removeTeachingWindow(this.owner(), window.id);
  }

  protected applyStandard(weekday: number): void {
    this.store.applyStandardWindows(this.owner(), weekday);
  }

  /** Ein Zeitfenster muss enden, nachdem es beginnt; sonst bleibt der alte Wert und es gibt einen Hinweis. */
  protected setTime(window: TeachingWindow, key: 'from' | 'to', event: Event): void {
    const input = event.target as HTMLInputElement;
    const changed = { ...window, [key]: input.value };
    if (!input.value || changed.from >= changed.to) {
      input.value = window[key];
      this.error.set('Ein Zeitfenster muss später enden, als es beginnt.');
      return;
    }
    this.error.set(null);
    this.store.updateTeachingWindow(this.owner(), window.id, { [key]: input.value });
  }
}
