import { Component, computed, inject, input, output } from '@angular/core';
import { ConfigStore } from '../config.store';
import { formatLongDate } from '../model';
import { lastDate, Recurrence, recurrenceUntilPeriodEnd } from './appointments';

/** Neue Serien: täglich, so oft, bis der Berichtszeitraum des ersten Termins endet */
const DEFAULT_EVERY_DAYS = 1;

/**
 * „Wiederholen“ für Termin-Formulare: alle m Tage, n-mal. Angehakt läuft die Serie bis zum Ende des
 * Berichtszeitraums; ändert man den Abstand, passt sich die Anzahl wieder daran an.
 */
@Component({
  selector: 'app-recurrence-fields',
  templateUrl: './recurrence-fields.html',
  styleUrl: './recurrence-fields.scss',
})
export class RecurrenceFields {
  private readonly config = inject(ConfigStore).config;

  /** Datum des ersten Termins */
  readonly date = input.required<string>();
  readonly repeat = input<Recurrence | undefined>();
  readonly repeatChange = output<Recurrence | undefined>();

  protected readonly last = computed(() => formatLongDate(lastDate({ date: this.date(), repeat: this.repeat() })));

  protected toggle(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.repeatChange.emit(checked ? this.untilPeriodEnd(DEFAULT_EVERY_DAYS) : undefined);
  }

  protected setEveryDays(event: Event): void {
    const input = event.target as HTMLInputElement;
    const days = Math.round(Number(input.value));
    if (days >= 1) {
      this.repeatChange.emit(this.untilPeriodEnd(days));
    } else {
      input.value = String(this.repeat()?.everyDays ?? DEFAULT_EVERY_DAYS);
    }
  }

  protected setCount(event: Event): void {
    const input = event.target as HTMLInputElement;
    const count = Math.round(Number(input.value));
    const repeat = this.repeat();
    if (repeat && count >= 2) {
      this.repeatChange.emit({ ...repeat, count });
    } else {
      input.value = String(repeat?.count ?? 2);
    }
  }

  private untilPeriodEnd(everyDays: number): Recurrence {
    return recurrenceUntilPeriodEnd(this.config().reportPeriods, this.date(), everyDays);
  }
}
