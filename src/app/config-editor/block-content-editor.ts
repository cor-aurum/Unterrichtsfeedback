import { Component, input, output } from '@angular/core';
import { BlockContent, BlockImage, FixedBlock } from '../model';
import { readImageFile } from './image-file';

/** Breite des Textbereichs im PDF (A4 abzüglich Ränder) */
const MAX_IMAGE_WIDTH_MM = 170;

/** Bearbeitet den Inhalt eines festen Blocks: Standardinhalt oder eine Variante. */
@Component({
  selector: 'app-block-content-editor',
  templateUrl: './block-content-editor.html',
  styleUrl: './block-content-editor.scss',
})
export class BlockContentEditor {
  readonly type = input.required<FixedBlock['type']>();
  readonly content = input.required<BlockContent>();
  readonly placeholder = input('');

  readonly contentChange = output<Partial<BlockContent>>();
  readonly imageSettingsChange = output<Partial<Pick<BlockImage, 'widthMm' | 'align'>>>();
  readonly error = output<string>();

  protected readonly maxImageWidth = MAX_IMAGE_WIDTH_MM;

  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected setWidth(event: Event): void {
    const widthMm = Number(this.valueOf(event));
    if (widthMm > 0) this.imageSettingsChange.emit({ widthMm: Math.min(widthMm, MAX_IMAGE_WIDTH_MM) });
  }

  /** Ein neues Bild übernimmt Breite und Ausrichtung des bisherigen. */
  protected async chooseImage(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const image = await readImageFile(file);
      const previous = this.content().image;
      this.contentChange.emit({ image: previous ? { ...image, widthMm: previous.widthMm, align: previous.align } : image });
    } catch (e) {
      this.error.emit(`Bild konnte nicht geladen werden: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
