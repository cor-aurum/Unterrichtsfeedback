import { Capacitor } from '@capacitor/core';

export const isNativeApp = Capacitor.isNativePlatform();

/**
 * Gibt eine Datei an die Nutzerin oder den Nutzer weiter: im Browser als Download, in der
 * Android-App über den Teilen-Dialog (dort gibt es keinen Download über einen Link).
 */
export async function saveFile(fileName: string, content: Blob): Promise<void> {
  try {
    if (isNativeApp) {
      await shareNative(fileName, content);
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

function download(fileName: string, content: Blob): void {
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
