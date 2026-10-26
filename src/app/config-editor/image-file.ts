import { BlockImage } from '../model';

/** Größere Bilder werden verkleinert, damit der Local Storage (meist rund 5 MB) nicht überläuft. */
const MAX_SIDE_PX = 1200;

/** Liest eine Bilddatei ein und liefert sie als PNG (bei PNG-Dateien, wegen Transparenz) oder JPEG. */
export async function readImageFile(file: File): Promise<BlockImage> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Die Datei ist kein Bild.');
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE_PX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const dataUrl = file.type === 'image/png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.85);
  return { dataUrl, widthPx: canvas.width, heightPx: canvas.height, widthMm: 50, align: 'left' };
}
