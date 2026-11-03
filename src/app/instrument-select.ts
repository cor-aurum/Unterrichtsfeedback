import { Component, computed, inject, input, model } from '@angular/core';
import { ConfigStore } from './config.store';

/** Wert der letzten Auswahl, die kein Instrument ist */
const NEW_INSTRUMENT = '__new';

/**
 * Auswahl eines Instruments; der letzte Eintrag „+ Neues Instrument …“ legt eines an und wählt es gleich aus.
 * Gibt es den Namen schon (Groß-/Kleinschreibung egal), wird das vorhandene gewählt.
 */
@Component({
  selector: 'app-instrument-select',
  template: `
    <select [attr.id]="selectId()" [attr.aria-label]="label()" (change)="choose($event)">
      @for (instrument of instruments(); track instrument.id) {
        <option [value]="instrument.id" [selected]="instrument.id === value()">{{ instrument.name }}</option>
      }
      <option [value]="newInstrument">+ Neues Instrument …</option>
    </select>
  `,
  styles: `
    :host {
      display: contents;
    }
  `,
})
export class InstrumentSelect {
  private readonly configStore = inject(ConfigStore);

  /** ID des gewählten Instruments */
  readonly value = model.required<string>();
  readonly label = input<string>();
  /** Für ein `<label for>` außerhalb */
  readonly selectId = input<string>();

  protected readonly instruments = computed(() => this.configStore.config().instruments);
  protected readonly newInstrument = NEW_INSTRUMENT;

  protected choose(event: Event): void {
    const select = event.target as HTMLSelectElement;
    if (select.value !== NEW_INSTRUMENT) {
      this.value.set(select.value);
      return;
    }
    const name = prompt('Name des neuen Instruments:')?.trim();
    const id = name ? this.configStore.ensureInstruments([name]).get(name.toLowerCase()) : undefined;
    if (id) this.value.set(id);
    // Die Auswahl zeigt sonst weiter „+ Neues Instrument …“; nach dem Neuzeichnen der Optionen richtigstellen.
    setTimeout(() => (select.value = this.value()));
  }
}
