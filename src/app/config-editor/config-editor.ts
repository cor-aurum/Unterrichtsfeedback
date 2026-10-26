import { Component, inject, signal } from '@angular/core';
import { ConfigStore } from '../config.store';
import { BlockImage, FixedBlock, PLACEHOLDERS, Section } from '../model';
import { readImageFile } from './image-file';

/** Breite des Textbereichs im PDF (A4 abzüglich Ränder) */
const MAX_IMAGE_WIDTH_MM = 170;

@Component({
  selector: 'app-config-editor',
  templateUrl: './config-editor.html',
  styleUrl: './config-editor.scss',
})
export class ConfigEditor {
  protected readonly store = inject(ConfigStore);
  protected readonly placeholders = PLACEHOLDERS;
  protected readonly maxImageWidth = MAX_IMAGE_WIDTH_MM;
  protected readonly message = signal<{ text: string; error: boolean } | null>(null);

  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement).value;
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
    const image = await this.readImage(input);
    if (image) this.store.addImageBlock(image);
  }

  protected async replaceImage(block: FixedBlock, input: HTMLInputElement): Promise<void> {
    const image = await this.readImage(input);
    if (image) this.store.updateBlock(block.id, { image: { ...image, widthMm: block.image!.widthMm, align: block.image!.align } });
  }

  protected setImageWidth(block: FixedBlock, event: Event): void {
    const widthMm = Number(this.valueOf(event));
    if (widthMm > 0) this.store.updateBlockImage(block.id, { widthMm: Math.min(widthMm, MAX_IMAGE_WIDTH_MM) });
  }

  protected removeBlock(block: FixedBlock): void {
    const what = block.type === 'image' ? 'das Bild' : 'den Text';
    if (confirm(`Möchtest du ${what} wirklich löschen?`)) this.store.removeBlock(block.id);
  }

  private async readImage(input: HTMLInputElement): Promise<BlockImage | null> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return null;
    try {
      return await readImageFile(file);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.message.set({ text: `Bild konnte nicht geladen werden: ${reason}`, error: true });
      return null;
    }
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
