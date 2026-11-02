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
import { fromSyncFiles, isSyncFile, SyncFiles } from './sync-files';
import { Checksums, planSync } from './sync-plan';

/**
 * - `off`: kein Ordner gewählt
 * - `reconnect`: Zugriff muss erneut erlaubt werden (Browser nach Neustart)
 * - `initial`: Der Ordner enthält beim Verbinden schon Daten; Nutzer entscheidet, welche gelten.
 * - `conflict`: Dieselbe Datei wurde hier und im Ordner geändert; bis zur Entscheidung wird nichts abgeglichen.
 */
export type SyncStatus = 'off' | 'reconnect' | 'ok' | 'initial' | 'conflict' | 'error';

/** Wartezeit nach einer Änderung, damit nicht jeder Tastendruck einzeln geschrieben wird */
const WRITE_DELAY_MS = 1500;
/** Wie oft der Ordner auf Änderungen anderer Geräte geprüft wird, solange die App sichtbar ist */
const POLL_INTERVAL_MS = 20_000;

/**
 * Gleicht alle Daten mit einem Ordner ab: im Browser einen lokalen Ordner, in der Android-App z. B. einen
 * Ordner der Nextcloud-App, oder überall direkt per WebDAV eine Nextcloud. Änderungen anderer Geräte werden
 * je Datei übernommen, eigene geschrieben; nur wenn beide Seiten dieselbe Datei geändert haben, wird gefragt.
 */
@Injectable({ providedIn: 'root' })
export class FolderSync {
  private readonly backup = inject(BackupService);
  /** Lokale Ordner gibt es nur in der App und in Chromium-Browsern; WebDAV geht überall. */
  readonly localFoldersSupported = isNativeApp || browserFoldersSupported;

  private readonly stored = storedSignal<StoredFolder | null>('feedback.syncFolder', () => null);
  /** Prüfsumme je Datei beim letzten Abgleich: Grundlage, um eigene von fremden Änderungen zu unterscheiden */
  private readonly known = storedSignal<Checksums>('feedback.syncKnown', () => ({}));
  readonly folderName = signal<string | null>(this.stored()?.name ?? null);
  readonly status = signal<SyncStatus>('off');
  readonly error = signal<string | null>(null);
  readonly conflicts = signal<string[]>([]);
  readonly lastSync = signal<Date | null>(null);
  /** Zeitpunkt, zu dem zuletzt Änderungen aus dem Ordner übernommen wurden */
  readonly lastPull = signal<Date | null>(null);

  private folder: SyncFolder | null = null;
  /** Zuletzt gelesene Inhalte; eine Datei wird nur neu gelesen, wenn sich ihre Version geändert hat. */
  private readonly cache = new Map<string, { version: string; content: string }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor() {
    effect(() => {
      this.backup.files();
      if (untracked(this.status) === 'ok') this.scheduleSync();
    });
    const syncIfVisible = () => {
      if (document.visibilityState === 'visible' && this.status() === 'ok') this.run(() => this.sync());
    };
    document.addEventListener('visibilitychange', syncIfVisible);
    window.addEventListener('focus', syncIfVisible);
    setInterval(syncIfVisible, POLL_INTERVAL_MS);
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
    this.run(() => this.sync());
  }

  /**
   * Verbindet mit einem WebDAV-Ordner. Wirft einen Fehler mit verständlichem Text, wenn Adresse oder
   * Zugangsdaten nicht passen; dann bleibt die bisherige Einstellung.
   */
  async connectWebDav(settings: WebDavSettings): Promise<void> {
    const folder = new WebDavFolder(settings);
    await folder.prepare();
    const sameFolder = JSON.stringify({ ...this.webDavSettings(), password: '' }) ===
      JSON.stringify({ ...settings, password: '' });
    this.use(folder, { kind: 'webdav', name: folder.name, settings }, sameFolder);
    await this.run(() => this.sync());
  }

  /** Gespeicherte WebDAV-Zugangsdaten, um sie im Formular vorzubelegen */
  webDavSettings(): WebDavSettings | null {
    const stored = this.stored();
    return stored?.kind === 'webdav' ? stored.settings : null;
  }

  /** Im Browser nach einem Neustart; muss direkt aus einem Klick kommen. */
  async reconnect(): Promise<void> {
    if (!this.folder || this.stored()?.kind === 'android') return this.connect();
    if (await this.folder.requestAccess()) this.run(() => this.sync());
  }

  async disconnect(): Promise<void> {
    clearTimeout(this.timer);
    const wasBrowserFolder = this.stored()?.kind === 'browser';
    this.folder = null;
    this.cache.clear();
    this.stored.set(null);
    this.known.set({});
    this.folderName.set(null);
    this.conflicts.set([]);
    this.status.set('off');
    this.error.set(null);
    if (wasBrowserFolder) await forgetBrowserFolder();
  }

  /** Übernimmt alle Daten aus dem Ordner; die Daten auf diesem Gerät werden ersetzt. */
  loadFromFolder(): Promise<void> {
    return this.run(async () => {
      const remote = await this.readFolder();
      this.backup.importFiles(remote);
      await this.writeLocal(remote);
    });
  }

  /** Überschreibt den Ordner mit allen Daten auf diesem Gerät. */
  overwriteFolder(): Promise<void> {
    return this.run(async () => this.writeLocal(await this.readFolder()));
  }

  retry(): Promise<void> {
    return this.run(() => this.sync());
  }

  /** Löst die Konflikte: `folder` übernimmt die Fassung aus dem Ordner, `local` behält die dieses Geräts. */
  resolveConflicts(keep: 'folder' | 'local'): Promise<void> {
    return this.run(() => this.sync(keep));
  }

  /** Neuer Ordner: Was beim letzten Abgleich war, gilt dort nicht. Gleicher Ordner (z. B. neues Passwort): bleibt. */
  private use(folder: SyncFolder, stored: StoredFolder, sameFolder = false): void {
    this.folder = folder;
    this.cache.clear();
    if (!sameFolder) this.known.set({});
    this.conflicts.set([]);
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
      await this.sync();
    } else {
      this.status.set('reconnect');
    }
  }

  private scheduleSync(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(() => this.sync()), WRITE_DELAY_MS);
  }

  /**
   * Übernimmt, was nur im Ordner geändert wurde, und schreibt, was nur hier geändert wurde. Bei Konflikten
   * wird ohne `keep` nichts verändert.
   */
  private async sync(keep?: 'folder' | 'local'): Promise<void> {
    const remote = await this.readFolder();
    const base = this.known();
    if (Object.keys(base).length === 0 && remote.size > 0) {
      this.status.set('initial');
      return;
    }
    const local = this.backup.files();
    const plan = planSync(base, checksums(local), checksums(remote));
    if (plan.conflicts.length > 0 && !keep) {
      this.conflicts.set(plan.conflicts);
      this.status.set('conflict');
      return;
    }
    const pull = keep === 'folder' ? [...plan.pull, ...plan.conflicts] : plan.pull;
    if (pull.length > 0) this.pull(local, remote, pull);
    await this.writeLocal(remote);
  }

  /** Setzt die Daten aus den unveränderten eigenen und den übernommenen Dateien aus dem Ordner zusammen. */
  private pull(local: SyncFiles, remote: SyncFiles, names: string[]): void {
    const merged = new Map(local);
    for (const name of names) {
      const content = remote.get(name);
      if (content === undefined) {
        merged.delete(name);
      } else {
        merged.set(name, content);
      }
    }
    this.backup.applySynced(fromSyncFiles(merged));
    this.lastPull.set(new Date());
  }

  /**
   * Bringt den Ordner auf den Stand dieses Geräts: schreibt abweichende Dateien und entfernt Lehrerdateien,
   * die es hier nicht gibt. Danach ist dieser Stand die Grundlage für den nächsten Abgleich.
   */
  private async writeLocal(remote: SyncFiles): Promise<void> {
    const folder = this.folder!;
    const local = this.backup.files();
    for (const [name, content] of local) {
      if (remote.get(name) !== content) await folder.write(name, content);
    }
    for (const name of remote.keys()) {
      if (!local.has(name)) await folder.remove(name);
    }
    this.known.set(checksums(local));
    this.conflicts.set([]);
    this.lastSync.set(new Date());
    this.status.set('ok');
    this.error.set(null);
  }

  private async readFolder(): Promise<SyncFiles> {
    const folder = this.folder!;
    const entries = (await folder.list()).filter((entry) => isSyncFile(entry.name));
    const files: SyncFiles = new Map();
    for (const { name, version } of entries) {
      const cached = this.cache.get(name);
      const content = cached?.version === version ? cached.content : await folder.read(name);
      this.cache.set(name, { version, content });
      files.set(name, content);
    }
    for (const name of this.cache.keys()) {
      if (!files.has(name)) this.cache.delete(name);
    }
    return files;
  }

  /** Nacheinander ausführen, damit sich Abgleiche nicht überholen */
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

function checksums(files: SyncFiles): Checksums {
  return Object.fromEntries([...files].map(([name, content]) => [name, checksum(content)]));
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
