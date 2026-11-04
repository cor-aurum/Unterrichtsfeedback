import { effect, inject, Injectable, signal, untracked } from '@angular/core';
import { BackupService } from '../backup';
import { CalendarFeed } from '../calendar/calendar-feed';
import { PersonMerger } from '../person-merger';
import { storedSignal } from '../stored-signal';
import { ServerError, ServerFolder, ServerLogin, serverApi } from './server-folder';
import { SyncFolder } from './sync-folder';
import { fromSyncFiles, isSyncFile, SyncFiles } from './sync-files';
import { Checksums, planSync } from './sync-plan';

/**
 * - `off`: nicht mit einem Server verbunden
 * - `reconnect`: Die Anmeldung ist abgelaufen; das Passwort muss erneut eingegeben werden.
 * - `initial`: Auf dem Server und hier liegen schon Daten; Nutzer entscheidet, welche gelten.
 * - `conflict`: Dieselbe Datei wurde hier und auf dem Server geändert; bis zur Entscheidung wird nichts abgeglichen.
 */
export type SyncStatus = 'off' | 'reconnect' | 'ok' | 'initial' | 'conflict' | 'error';

/** Wartezeit nach einer Änderung, damit nicht jeder Tastendruck einzeln geschrieben wird */
const WRITE_DELAY_MS = 1500;
/** Wie oft der Server auf Änderungen anderer Geräte geprüft wird, solange die App sichtbar ist */
const POLL_INTERVAL_MS = 20_000;
/** Einstellungen der früheren Ordner-Synchronisation; sie werden beim Start entfernt. */
const LEGACY_KEYS = ['feedback.syncFolder', 'feedback.syncKnown'];

/**
 * Gleicht alle Daten mit dem Unterrichtsfeedback-Server ab. Die Daten liegen weiter auf dem Gerät, die App
 * funktioniert also auch offline: Änderungen anderer Geräte und Lehrer werden je Datei übernommen, eigene
 * geschrieben, sobald der Server erreichbar ist; nur wenn beide Seiten dieselbe Datei geändert haben, wird gefragt.
 * Was ein Lehrer sehen darf, entscheidet der Server (Personen nur aus seinen Berichtszeiträumen).
 */
@Injectable({ providedIn: 'root' })
export class ServerSync {
  private readonly backup = inject(BackupService);
  private readonly merger = inject(PersonMerger);
  private readonly feed = inject(CalendarFeed);
  /** Prüfsumme des zuletzt gesendeten Abo-Kalenders, damit er nur bei Änderungen erneut geht */
  private readonly publishedFeed = storedSignal<string>('feedback.publishedFeed', () => '');

  /** Anmeldung samt Token; liegt nur auf diesem Gerät */
  readonly login = storedSignal<ServerLogin | null>('feedback.server', () => null);
  /** Prüfsumme je Datei beim letzten Abgleich: Grundlage, um eigene von fremden Änderungen zu unterscheiden */
  private readonly known = storedSignal<Checksums>('feedback.serverKnown', () => ({}));
  readonly status = signal<SyncStatus>('off');
  readonly error = signal<string | null>(null);
  readonly conflicts = signal<string[]>([]);
  readonly lastSync = signal<Date | null>(null);
  /** Zeitpunkt, zu dem zuletzt Änderungen vom Server übernommen wurden */
  readonly lastPull = signal<Date | null>(null);
  /** Nach `loadFromServer`: Der Server hatte noch keine Daten, z. B. für den ersten Lehrer. */
  readonly serverEmpty = signal(false);
  /** Hinweis, wenn auf diesem Gerät noch die frühere Ordner-Synchronisation eingerichtet war */
  readonly legacyNotice = signal(LEGACY_KEYS.some((key) => localStorage.getItem(key) !== null));

  private folder: SyncFolder | null = null;
  /** Zuletzt gelesene Inhalte; eine Datei wird nur neu gelesen, wenn sich ihre Version geändert hat. */
  private readonly cache = new Map<string, { version: string; content: string }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor() {
    LEGACY_KEYS.forEach((key) => localStorage.removeItem(key));
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

  /**
   * Verbindet mit dem Server. `load` übernimmt dessen Daten und ersetzt die auf diesem Gerät, z. B. auf einem neuen
   * Gerät oder für einen neuen Lehrer; sonst wird abgeglichen (liegen auf beiden Seiten Daten, wird gefragt).
   */
  connect(login: ServerLogin, mode: 'sync' | 'load' = 'sync'): Promise<void> {
    const previous = this.login();
    const sameAccount = previous?.url === login.url && previous.teacherId === login.teacherId;
    this.use(login, sameAccount);
    return mode === 'load' ? this.loadFromServer() : this.run(() => this.sync());
  }

  /** Nach abgelaufener Anmeldung: mit dem Passwort neu anmelden, der Abgleich geht weiter. */
  async reconnect(password: string): Promise<void> {
    const login = this.login();
    if (!login) return;
    this.use(await serverApi.login(login.url, login.username, password), true);
    await this.run(() => this.sync());
  }

  async disconnect(): Promise<void> {
    clearTimeout(this.timer);
    const login = this.login();
    this.folder = null;
    this.cache.clear();
    this.login.set(null);
    this.known.set({});
    this.conflicts.set([]);
    this.status.set('off');
    this.error.set(null);
    if (login) await serverApi.logout(login);
  }

  /** Übernimmt alle Daten vom Server; die Daten auf diesem Gerät werden ersetzt. */
  loadFromServer(): Promise<void> {
    return this.run(async () => {
      const remote = await this.readServer();
      this.serverEmpty.set(remote.size === 0);
      // Ohne Daten auf dem Server bleiben die dieses Geräts; sie werden hochgeladen.
      if (remote.size > 0) this.backup.importFiles(remote);
      await this.applyMerges();
      await this.writeLocal(remote);
    });
  }

  /** Schreibt alle Daten dieses Geräts auf den Server (soweit dieser Lehrer sie ändern darf). */
  overwriteServer(): Promise<void> {
    return this.run(async () => this.writeLocal(await this.readServer()));
  }

  retry(): Promise<void> {
    return this.run(() => this.sync());
  }

  /** Löst die Konflikte: `server` übernimmt die Fassung vom Server, `local` behält die dieses Geräts. */
  resolveConflicts(keep: 'server' | 'local'): Promise<void> {
    return this.run(() => this.sync(keep));
  }

  /** Gleicher Lehrer auf demselben Server: Der Stand des letzten Abgleichs gilt weiter. */
  private use(login: ServerLogin, sameAccount: boolean): void {
    this.folder = new ServerFolder(login);
    this.cache.clear();
    if (!sameAccount) this.known.set({});
    this.conflicts.set([]);
    this.login.set(login);
    this.legacyNotice.set(false);
  }

  private async restore(): Promise<void> {
    const login = this.login();
    if (!login) return;
    this.folder = new ServerFolder(login);
    await this.sync();
  }

  private scheduleSync(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(() => this.sync()), WRITE_DELAY_MS);
  }

  /**
   * Übernimmt, was nur auf dem Server geändert wurde, und schreibt, was nur hier geändert wurde. Bei Konflikten
   * wird ohne `keep` nichts verändert. Zusammenführungen von Personen gehen vorher an den Server und kommen von ihm.
   */
  private async sync(keep?: 'server' | 'local'): Promise<void> {
    await this.sendMerges();
    const remote = await this.readServer();
    const base = this.known();
    if (Object.keys(base).length === 0 && remote.size > 0 && this.hasLocalData()) {
      this.status.set('initial');
      return;
    }
    if (Object.keys(base).length === 0 && remote.size > 0) {
      // Neues Gerät ohne eigene Daten: einfach übernehmen
      this.backup.importFiles(remote);
    }
    const local = this.backup.files();
    const plan = planSync(base, checksums(local), checksums(remote));
    if (plan.conflicts.length > 0 && !keep) {
      this.conflicts.set(plan.conflicts);
      this.status.set('conflict');
      return;
    }
    const pull = keep === 'server' ? [...plan.pull, ...plan.conflicts] : plan.pull;
    if (pull.length > 0) this.pull(local, remote, pull);
    // Erst nach dem Übernehmen: Wer zusammengeführt hat, hat die betroffenen Dateien meist schon geschrieben. Davor
    // wäre die Zusammenführung hier eine eigene Änderung an denselben Dateien und damit ein Konflikt.
    await this.applyMerges();
    await this.writeLocal(remote);
  }

  /** Hat dieses Gerät eigene Personen? Eine frische Einrichtung zählt nicht. */
  private hasLocalData(): boolean {
    return this.backup.data().students.length > 0;
  }

  /** Vor dem Schreiben senden, solange der Server beide Personen noch kennt */
  private async sendMerges(): Promise<void> {
    const login = this.login();
    if (!login) return;
    for (const merge of this.merger.pending()) {
      try {
        await serverApi.addMerge(login, merge.from, merge.into);
      } catch (e) {
        // Kennt der Server eine der Personen nicht (z. B. offline angelegt), braucht niemand sonst die Zusammenführung.
        if (!(e instanceof ServerError) || e.status !== 403) throw e;
      }
      this.merger.forgetPending(merge);
    }
  }

  private async applyMerges(): Promise<void> {
    const login = this.login();
    if (login) this.merger.applyMerges(await serverApi.merges(login));
  }

  /** Setzt die Daten aus den unveränderten eigenen und den übernommenen Dateien vom Server zusammen. */
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
   * Bringt den Server auf den Stand dieses Geräts: schreibt abweichende Dateien und entfernt Dateien, die es hier
   * nicht mehr gibt. Danach ist dieser Stand die Grundlage für den nächsten Abgleich.
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
    await this.publishFeed();
  }

  /**
   * Schickt den Kalender für das Abo, wenn er sich seit dem letzten Mal geändert hat (`force`: auf jeden Fall). Der
   * Server erzeugt ihn nicht selbst; er ist so aktuell wie der letzte Abgleich eines Geräts dieses Lehrers. Fehler
   * stören den Abgleich nicht, z. B. bei einem älteren Server ohne Abo.
   */
  async publishFeed(force = false): Promise<void> {
    const login = this.login();
    const calendar = login && this.feed.render(login.teacherId);
    if (!login || !calendar) return;
    const fingerprint = checksum(`${login.url}|${login.teacherId}|${withoutStamps(calendar)}`);
    if (!force && fingerprint === this.publishedFeed()) return;
    try {
      await serverApi.putFeed(login, calendar);
      this.publishedFeed.set(fingerprint);
    } catch (e) {
      console.warn('Kalender für das Abo nicht gesendet', e);
    }
  }

  private async readServer(): Promise<SyncFiles> {
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
    if (e instanceof ServerError && e.status === 401) {
      this.status.set('reconnect');
      this.error.set(null);
      return;
    }
    this.status.set('error');
    this.error.set(e instanceof Error ? e.message : String(e));
  }
}

/** Der Zeitstempel jedes Eintrags ändert sich bei jedem Erzeugen; für den Vergleich zählt nur der Inhalt. */
function withoutStamps(calendar: string): string {
  return calendar.replace(/^DTSTAMP:[^\r\n]*\r\n/gm, '');
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
