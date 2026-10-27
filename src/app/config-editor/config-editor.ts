import { Component, computed, inject, signal } from '@angular/core';
import { ConfigStore } from '../config.store';
import { defaultInstrument, FixedBlock, Instrument, PLACEHOLDERS, Section } from '../model';
import { BlockContentEditor } from './block-content-editor';
import { readImageFile } from './image-file';
import { DEFAULT_THEME_COLOR, isHexColor } from '../theme';

@Component({
  selector: 'app-config-editor',
  imports: [BlockContentEditor],
  templateUrl: './config-editor.html',
  styleUrl: './config-editor.scss',
})
export class ConfigEditor {
  protected readonly store = inject(ConfigStore);
  protected readonly placeholders = PLACEHOLDERS;
  protected readonly defaultThemeColor = DEFAULT_THEME_COLOR;
  protected readonly message = signal<{ text: string; error: boolean } | null>(null);
  protected readonly defaultInstrumentId = computed(() => defaultInstrument(this.store.config()).id);

  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected setThemeColorFromText(event: Event): void {
    const input = event.target as HTMLInputElement;
    const color = input.value.trim().replace(/^#?/, '#');
    if (isHexColor(color)) {
      this.store.setThemeColor(color);
    } else {
      input.value = this.store.config().themeColor;
      this.showError('Bitte die Farbe als Hex-Wert angeben, z. B. #f57115.');
    }
  }

  protected showError(text: string): void {
    this.message.set({ text, error: true });
  }

  protected addInstrument(input: HTMLInputElement): void {
    const name = input.value.trim();
    if (!name) return;
    this.store.addInstrument(name);
    input.value = '';
  }

  protected removeInstrument(instrument: Instrument): void {
    if (confirm(`Instrument „${instrument.name}“ löschen? Personen mit diesem Instrument bekommen das Standardinstrument.`)) {
      this.store.removeInstrument(instrument.id);
    }
  }

  protected addItem(section: Section, input: HTMLInputElement): void {
    const text = input.value.trim();
    if (!text) return;
    this.store.addItem(section.id, text);
    input.value = '';
  }

  protected removeSection(section: Section): void {
    if (confirm(`Abschnitt „${section.title}“ löschen? Bereits erfasste Einträge dazu erscheinen nicht mehr im PDF.`)) {
      this.store.removeSection(section.id);
    }
  }

  protected async addImage(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      this.store.addImageBlock(await readImageFile(file));
    } catch (e) {
      this.showError(`Bild konnte nicht geladen werden: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  protected removeBlock(block: FixedBlock): void {
    const what = block.type === 'image' ? 'das Bild' : 'den Text';
    if (confirm(`Möchtest du ${what} mit allen Varianten wirklich löschen?`)) this.store.removeBlock(block.id);
  }

  protected async importFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file || !confirm('Die aktuelle Konfiguration wird ersetzt. Fortfahren?')) return;
    try {
      this.store.importFromJson(await file.text());
      this.message.set({ text: `Konfiguration aus „${file.name}“ importiert.`, error: false });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.message.set({ text: `Import fehlgeschlagen: ${reason}`, error: true });
    }
  }

  protected reset(): void {
    if (confirm('Konfiguration auf die Beispielvorlage zurücksetzen?')) {
      this.store.resetToDefault();
      this.message.set(null);
    }
  }
}
