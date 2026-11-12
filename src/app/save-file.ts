import { signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';

export const isNativeApp = Capacitor.isNativePlatform();

/**
 * Datei, die auf dem Handy aufs Teilen wartet: Browser erlauben das Teilen nur direkt nach einem Antippen. Dauert
 * das Erzeugen (z. B. vieler PDFs) zu lange, ist das Antippen „verbraucht“; dann bietet `ShareSheet` die Datei mit
 * einem eigenen Knopf an.
 */
export const pendingShare = signal<File | null>(null);

/**
 * Gibt eine Datei an die Nutzerin oder den Nutzer weiter: in der Android-App und im Browser auf Handy und Tablet
 * über den Teilen-Dialog (Mail, Messenger, Dateien …), am Computer als Download.
 */
export async function saveFile(fileName: string, content: Blob): Promise<void> {
  try {
    const file = new File([content], fileName, { type: content.type });
    if (isNativeApp) {
      await shareNative(fileName, content);
    } else if (canShareFile(file)) {
      await shareInBrowser(file);
    } else {
      download(fileName, content);
    }
  } catch (e) {
    // Schließt man den Teilen-Dialog ohne Auswahl, meldet das Plugin einen Fehler; das ist kein Problem.
    if (!String(e).toLowerCase().includes('cancel')) {
      alert(`Die Datei „${fileName}“ konnte nicht gespeichert werden: ${e instanceof Error ? e.message : e}`);
    }
  }
}

/** Öffnet die Datei in der Android-App mit der passenden App (z. B. einem PDF-Viewer); im Browser als Download. */
export async function openFile(fileName: string, content: Blob): Promise<void> {
  if (!isNativeApp) {
    download(fileName, content);
    return;
  }
  try {
    const [uri, { FileOpener }] = await Promise.all([
      writeToCache(fileName, content),
      import('@capacitor-community/file-opener'),
    ]);
    await FileOpener.open({ filePath: uri, contentType: content.type || undefined });
  } catch (e) {
    alert(
      `Die Datei „${fileName}“ konnte nicht geöffnet werden. Ist eine App zum Anzeigen installiert? ` +
        `Über „Teilen“ lässt sie sich trotzdem weitergeben. (${e instanceof Error ? e.message : e})`,
    );
  }
}

export function safeFileName(name: string): string {
  return name.trim().replace(/[^\p{L}\p{N}_-]+/gu, '_') || 'export';
}

/** Teilt die Datei; ohne frisches Antippen wartet sie in `pendingShare`. Abbrechen ist kein Fehler. */
export async function shareInBrowser(file: File): Promise<void> {
  try {
    await navigator.share({ files: [file], title: file.name });
    pendingShare.set(null);
  } catch (e) {
    const name = e instanceof DOMException ? e.name : '';
    if (name === 'AbortError') return;
    if (name === 'NotAllowedError') {
      pendingShare.set(file);
      return;
    }
    throw e;
  }
}

/** Nur mit dem Finger (Handy, Tablet) und wenn der Browser Dateien teilen kann */
function canShareFile(file: File): boolean {
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return touch && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
}

export function download(fileName: string, content: Blob): void {
  const url = URL.createObjectURL(content);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

/** Öffnet den Android-Teilen-Dialog (Mail, Drive, „Dateien“ …). */
async function shareNative(fileName: string, content: Blob): Promise<void> {
  const [uri, { Share }] = await Promise.all([writeToCache(fileName, content), import('@capacitor/share')]);
  await Share.share({ title: fileName, files: [uri], dialogTitle: 'Speichern oder teilen' });
}

/** Legt die Datei im Cache der App ab und liefert ihre Adresse. */
async function writeToCache(fileName: string, content: Blob): Promise<string> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const { uri } = await Filesystem.writeFile({
    path: fileName,
    data: await toBase64(content),
    directory: Directory.Cache,
  });
  return uri;
}

function toBase64(content: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(content);
  });
}
