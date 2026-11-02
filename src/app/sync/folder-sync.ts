import { effect, inject, Injectable, signal, untracked } from '@angular/core';
import { BackupService } from '../backup';
import { isNativeApp } from '../save-file';
import { storedSignal } from '../stored-signal';
import {
  browserFoldersSupported,
  forgetBrowserFolder,
  pickAndroidFolder,
  pickBrowserFolder,
  restoreAndroidFolder,
  restoreBrowserFolder,
  StoredFolder,
  SyncFolder,
  WebDavFolder,
  WebDavSettings,
} from './sync-folder';
import { isSyncFile, SyncFiles } from './sync-files';

/**
 * - `off`: kein Ordner gewählt
 * - `reconnect`: Zugriff muss erneut erlaubt werden (Browser nach Neustart)
 * - `changed`: Der Ordner wurde außerhalb geändert, z. B. von einem anderen Gerät; es wird nichts geschrieben,
 *   bis entschieden ist, welche Seite gilt.
 */
export type SyncStatus = 'off' | 'reconnect' | 'ok' | 'changed' | 'error';

const WRITE_DELAY_MS = 1500;

/**
 * Schreibt alle Daten bei jeder Änderung als Dateien in einen gewählten Ordner: im Browser einen lokalen
 * Ordner, in der Android-App z. B. einen Ordner der Nextcloud-App, die ihn hochlädt, oder überall direkt
 * per WebDAV in eine Nextcloud.
 */
@Injectable({ providedIn: 'root' })
export class FolderSync {
  private readonly backup = inject(BackupService);
  /** Lokale Ordner gibt es nur in der App und in Chromium-Browsern; WebDAV geht überall. */
  readonly localFoldersSupported = isNativeApp || browserFoldersSupported;

  private readonly stored = storedSignal<StoredFolder | null>('feedback.syncFolder', () => null);
  /** Prüfsumme je Datei, wie sie zuletzt geschrieben oder gelesen wurde */
  private readonly known = storedSignal<Record<string, string>>('feedback.syncKnown', () => ({}));
  readonly folderName = signal<string | null>(this.stored()?.name ?? null);
  readonly status = signal<SyncStatus>('off');
  readonly error = signal<string | null>(null);
  readonly lastWrite = signal<Date | null>(null);

  private folder: SyncFolder | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor() {
    effect(() => {
      this.backup.files();
      if (untracked(this.status) === 'ok') this.scheduleWrite();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.status() === 'ok') this.run(() => this.check());
    });
    this.run(() => this.restore());
  }

  async connect(): Promise<void> {
    try {
      if (isNativeApp) {
        const { folder, stored } = await pickAndroidFolder();
        this.use(folder, stored);
      } else {
        this.use(await pickBrowserFolder(), { kind: 'browser', name: '' });
      }
    } catch (e) {
      if (!isCancel(e)) this.fail(e);
      return;
    }
    this.known.set({});
    this.run(() => this.check());
  }

  /**
   * Verbindet mit einem WebDAV-Ordner. Wirft einen Fehler mit verständlichem Text, wenn Adresse oder
   * Zugangsdaten nicht passen; dann bleibt die bisherige Einstellung.
   */
  async connectWebDav(settings: WebDavSettings): Promise<void> {
    const folder = new WebDavFolder(settings);
    await folder.prepare();
    this.use(folder, { kind: 'webdav', name: folder.name, settings });
    this.known.set({});
    await this.run(() => this.check());
  }

  /** Gespeicherte WebDAV-Zugangsdaten, um sie im Formular vorzubelegen */
  webDavSettings(): WebDavSettings | null {
    const stored = this.stored();
    return stored?.kind === 'webdav' ? stored.settings : null;
  }

  /** Im Browser nach einem Neustart; muss direkt aus einem Klick kommen. */
  async reconnect(): Promise<void> {
    if (!this.folder || this.stored()?.kind === 'android') return this.connect();
    if (await this.folder.requestAccess()) this.run(() => this.check());
  }

  async disconnect(): Promise<void> {
    clearTimeout(this.timer);
    const wasBrowserFolder = this.stored()?.kind === 'browser';
    this.folder = null;
    this.stored.set(null);
    this.known.set({});
    this.folderName.set(null);
    this.status.set('off');
    this.error.set(null);
    if (wasBrowserFolder) await forgetBrowserFolder();
  }

  /** Übernimmt die Daten aus dem Ordner; die Daten auf diesem Gerät werden ersetzt. */
  loadFromFolder(): Promise<void> {
    return this.run(async () => {
      const files = await this.readFolder();
      this.backup.importFiles(files);
      this.known.set(checksums(files));
      await this.write();
    });
  }

  /** Überschreibt den Ordner mit den Daten auf diesem Gerät. */
  overwriteFolder(): Promise<void> {
    return this.run(() => this.write());
  }

  private use(folder: SyncFolder, stored: StoredFolder): void {
    this.folder = folder;
    this.stored.set({ ...stored, name: folder.name });
    this.folderName.set(folder.name);
  }

  private async restore(): Promise<void> {
    const stored = this.stored();
    if (!stored) return;
    const folder = await restoreFolder(stored);
    if (!folder) return this.disconnect();
    this.folder = folder;
    if (await folder.hasAccess()) {
      await this.check();
    } else {
      this.status.set('reconnect');
    }
  }

  /** Schreibt nur, wenn der Ordner noch so ist, wie diese App ihn hinterlassen hat. */
  private async check(): Promise<void> {
    const files = await this.readFolder();
    const unchanged = files.size === 0 || sameChecksums(checksums(files), this.known());
    if (unchanged) {
      await this.write();
    } else {
      this.status.set('changed');
    }
  }

  private scheduleWrite(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(() => this.write()), WRITE_DELAY_MS);
  }

  /** Schreibt geänderte Dateien und entfernt Lehrerdateien, die es nicht mehr gibt. */
  private async write(): Promise<void> {
    const folder = this.folder!;
    const files = this.backup.files();
    const known = this.known();
    const next = checksums(files);
    for (const [name, content] of files) {
      if (known[name] !== next[name]) await folder.write(name, content);
    }
    for (const name of await folder.list()) {
      if (isSyncFile(name) && !files.has(name)) await folder.remove(name);
    }
    this.known.set(next);
    this.lastWrite.set(new Date());
    this.status.set('ok');
    this.error.set(null);
  }

  private async readFolder(): Promise<SyncFiles> {
    const folder = this.folder!;
    const names = (await folder.list()).filter(isSyncFile);
    return new Map(await Promise.all(names.map(async (name) => [name, await folder.read(name)] as const)));
  }

  /** Nacheinander ausführen, damit sich Schreibvorgänge nicht überholen */
  private run(action: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(action).catch((e) => this.fail(e));
    return this.queue;
  }

  private fail(e: unknown): void {
    this.status.set('error');
    this.error.set(e instanceof Error ? e.message : String(e));
  }
}

function restoreFolder(stored: StoredFolder): Promise<SyncFolder | null> | SyncFolder {
  switch (stored.kind) {
    case 'android':
      return restoreAndroidFolder(stored);
    case 'webdav':
      return new WebDavFolder(stored.settings);
    case 'browser':
      return restoreBrowserFolder();
  }
}

function isCancel(e: unknown): boolean {
  const text = String(e instanceof Error ? `${e.name} ${e.message}` : e).toLowerCase();
  return text.includes('abort') || text.includes('cancel');
}

function checksums(files: SyncFiles): Record<string, string> {
  return Object.fromEntries([...files].map(([name, content]) => [name, checksum(content)]));
}

function sameChecksums(a: Record<string, string>, b: Record<string, string>): boolean {
  const names = Object.keys(a);
  return names.length === Object.keys(b).length && names.every((name) => a[name] === b[name]);
}

/** cyrb53: schnelle Prüfsumme, um geänderte Dateien zu erkennen (keine Sicherheitsfunktion) */
function checksum(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
