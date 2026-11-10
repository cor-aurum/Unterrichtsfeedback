import { effect, inject, Injectable, signal, untracked } from '@angular/core';
import { BackupService } from '../backup';
import { addDays } from '../calendar/appointments';
import { CalendarFeed, FEED_DAYS_BACK } from '../calendar/calendar-feed';
import { today } from '../model';
import { ConfigStore } from '../config.store';
import { PersonMerger } from '../person-merger';
import { PlanPublisher } from '../plans/plan-publisher';
import { demoMode, storageKey, storedSignal } from '../stored-signal';
import { checksum } from './checksum';
import { mergePeriodFile } from './merge-files';
import { ServerError, ServerFolder, ServerLogin, serverApi, StaleError } from './server-folder';
import { SyncFolder } from './sync-folder';
import { fromSyncFiles, isPeriodFile, isSyncFile, SyncFiles } from './sync-files';
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
/** Während Schüler:innen sich an Tablets eintragen, öfter: Vergebene Zeiten verschwinden so schnell überall. */
const FAST_POLL_INTERVAL_MS = 4_000;
/** So oft wird neu abgeglichen, wenn ein anderes Gerät gerade dieselbe Datei geschrieben hat */
const STALE_RETRIES = 5;

/**
 * Ergebnis von `transact`:
 * - `saved`: auf dem Server gespeichert
 * - `local`: nur auf diesem Gerät (ohne Server oder ohne Verbindung); der Abgleich folgt später
 * - `rejected`: nicht möglich, z. B. weil die Zeit inzwischen vergeben ist
 */
export type TransactResult = 'saved' | 'local' | 'rejected';
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
  private readonly plans = inject(PlanPublisher);
  private readonly configStore = inject(ConfigStore);
  /** Prüfsumme des zuletzt gesendeten Abo-Kalenders, damit er nur bei Änderungen erneut geht */
  private readonly publishedFeed = storedSignal<string>('feedback.publishedFeed', () => '');
  /** Wie `publishedFeed`, für die Kalender der Kolleg:innen (Lehrer-ID → Prüfsumme) */
  private readonly publishedColleagueFeeds = storedSignal<Record<string, string>>('feedback.publishedColleagueFeeds', () => ({}), (data) =>
    data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, string>) : {},
  );

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
  /** Berichtszeiträume auf dem Server, in denen der angemeldete Lehrer nicht eingetragen ist; mehr erfährt er nicht. */
  readonly foreignPeriods = signal(0);
  /** Solange die Schüler-Planung läuft: öfter abgleichen */
  readonly fastPolling = signal(false);
  /** Hinweis, wenn auf diesem Gerät noch die frühere Ordner-Synchronisation eingerichtet war */
  readonly legacyNotice = signal(LEGACY_KEYS.some((key) => localStorage.getItem(storageKey(key)) !== null));

  private folder: SyncFolder | null = null;
  /** Zuletzt gelesene Inhalte; eine Datei wird nur neu gelesen, wenn sich ihre Version geändert hat. */
  private readonly cache = new Map<string, { version: string; content: string }>();
  /** Inhalte beim letzten Abgleich: Grundlage, um Zeitraum-Dateien je Eintrag zusammenzuführen (nur im Speicher) */
  private base = new Map<string, string>();
  private lastPoll = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor() {
    LEGACY_KEYS.forEach((key) => localStorage.removeItem(storageKey(key)));
    effect(() => {
      this.backup.files();
      if (untracked(this.status) === 'ok') this.scheduleSync();
    });
    const syncIfVisible = () => {
      // Nach einem Fehler (z. B. kurz offline) von selbst erneut versuchen, damit Tablets ihre Eintragungen nachreichen.
      if (document.visibilityState !== 'visible' || !['ok', 'error'].includes(this.status())) return;
      this.lastPoll = Date.now();
      this.run(() => this.sync());
    };
    document.addEventListener('visibilitychange', syncIfVisible);
    window.addEventListener('focus', syncIfVisible);
    setInterval(() => {
      const interval = this.fastPolling() ? FAST_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
      if (Date.now() - this.lastPoll >= interval - 500) syncIfVisible();
    }, FAST_POLL_INTERVAL_MS);
    // Im Demomodus gelangen die Beispieldaten nie auf den Server; eine Anmeldung aus älteren Versionen verfällt.
    if (demoMode) {
      this.login.set(null);
      return;
    }
    this.run(() => this.restore());
  }

  /**
   * Verbindet mit dem Server. `load` übernimmt dessen Daten und ersetzt die auf diesem Gerät, z. B. auf einem neuen
   * Gerät oder für einen neuen Lehrer; sonst wird abgeglichen (liegen auf beiden Seiten Daten, wird gefragt).
   */
  connect(login: ServerLogin, mode: 'sync' | 'load' = 'sync'): Promise<void> {
    if (demoMode) return Promise.reject(new Error('Im Demomodus ist keine Verbindung zum Server möglich.'));
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

  /**
   * Für Eintragungen an mehreren Geräten gleichzeitig (Schüler-Planung): holt erst den neuesten Stand vom Server,
   * führt dann `change` aus und schreibt sofort. Hat ein anderes Gerät dazwischen dieselbe Datei geschrieben, lehnt
   * der Server ab; dann wird `change` zurückgenommen und mit dem neuen Stand wiederholt. `change` prüft selbst, ob
   * die Änderung noch geht, und liefert ihre Rücknahme oder `false`.
   */
  transact(change: () => (() => void) | false): Promise<TransactResult> {
    let result: TransactResult = 'local';
    const attempt = async () => {
      if (this.folder && this.status() !== 'off') {
        for (let i = 0; i < STALE_RETRIES; i++) {
          try {
            await this.syncOnce();
          } catch (e) {
            if (e instanceof StaleError) continue;
            this.fail(e);
            break;
          }
          if (this.status() !== 'ok') break;
          const undo = change();
          if (!undo) {
            result = 'rejected';
            return;
          }
          try {
            await this.writeLocal();
            result = 'saved';
            return;
          } catch (e) {
            undo();
            if (e instanceof StaleError) continue;
            this.fail(e);
            break;
          }
        }
      }
      // Ohne Server oder ohne Verbindung gilt die Änderung erst einmal nur hier.
      result = change() ? 'local' : 'rejected';
    };
    return this.run(attempt).then(() => result);
  }

  /** Übernimmt alle Daten vom Server; die Daten auf diesem Gerät werden ersetzt. */
  loadFromServer(): Promise<void> {
    return this.run(async () => {
      const remote = await this.readServer();
      this.serverEmpty.set(remote.size === 0);
      // Ohne Daten auf dem Server bleiben die dieses Geräts; sie werden hochgeladen.
      if (remote.size > 0) this.backup.importFiles(remote);
      await this.applyMerges();
      await this.writeLocal();
    });
  }

  /** Schreibt alle Daten dieses Geräts auf den Server (soweit dieser Lehrer sie ändern darf). */
  overwriteServer(): Promise<void> {
    return this.run(async () => {
      await this.readServer();
      await this.writeLocal(true);
    });
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
    // Hat ein anderes Gerät gerade dieselbe Datei geschrieben, einfach mit dessen Stand neu abgleichen.
    for (let i = 1; ; i++) {
      try {
        return await this.syncOnce(keep);
      } catch (e) {
        if (!(e instanceof StaleError) || i >= STALE_RETRIES) throw e;
      }
    }
  }

  private async syncOnce(keep?: 'server' | 'local'): Promise<void> {
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
    const merged = this.mergePeriodFiles(plan.conflicts, local, remote);
    const conflicts = plan.conflicts.filter((name) => !merged.has(name));
    if (conflicts.length > 0 && !keep) {
      this.conflicts.set(conflicts);
      this.status.set('conflict');
      return;
    }
    const pull = [...plan.pull, ...merged.keys(), ...(keep === 'server' ? conflicts : [])];
    if (pull.length > 0) this.pull(local, new Map([...remote, ...merged]), pull);
    // Erst nach dem Übernehmen: Wer zusammengeführt hat, hat die betroffenen Dateien meist schon geschrieben. Davor
    // wäre die Zusammenführung hier eine eigene Änderung an denselben Dateien und damit ein Konflikt.
    await this.applyMerges();
    // Mit Server ändert jede Lehrkraft nur eigene feste Inhalte; ältere geänderte gemeinsame Texte werden einmal
    // zu eigenen Varianten aller Lehrkräfte.
    if (!this.configStore.config().sharedContentsMigrated) this.configStore.migrateSharedContents();
    await this.writeLocal();
  }

  /**
   * Zeitraum-Dateien, die hier und auf dem Server geändert wurden, je Eintrag zusammenführen: Tragen sich an zwei
   * Tablets Personen bei derselben Lehrkraft ein, bleiben beide Termine erhalten statt eines Konflikts.
   */
  private mergePeriodFiles(conflicts: string[], local: SyncFiles, remote: SyncFiles): Map<string, string> {
    const merged = new Map<string, string>();
    for (const name of conflicts.filter(isPeriodFile)) {
      const content = mergePeriodFile(this.base.get(name), local.get(name), remote.get(name));
      if (content !== null) merged.set(name, content);
    }
    return merged;
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
   * nicht mehr gibt. Danach ist dieser Stand die Grundlage für den nächsten Abgleich. Geschrieben wird nur, wenn
   * die Datei auf dem Server noch die zuletzt gelesene Version hat (sonst `StaleError`), außer bei `force`.
   */
  private async writeLocal(force = false): Promise<void> {
    const folder = this.folder!;
    const local = this.backup.files();
    for (const [name, content] of local) {
      const known = this.cache.get(name);
      if (known?.content === content) continue;
      const version = await folder.write(name, content, force ? undefined : (known?.version ?? '0'));
      if (version) {
        this.cache.set(name, { version, content });
      } else {
        this.cache.delete(name);
      }
    }
    for (const name of [...this.cache.keys()]) {
      if (local.has(name)) continue;
      await folder.remove(name);
      this.cache.delete(name);
    }
    this.known.set(checksums(local));
    this.base = new Map(local);
    this.conflicts.set([]);
    this.lastSync.set(new Date());
    this.status.set('ok');
    this.error.set(null);
    await this.publishFeed();
    this.plans.schedule(this.login());
    await this.countForeignPeriods();
  }

  /** Ältere Server kennen die Zahl nicht; dann bleibt sie 0. */
  private async countForeignPeriods(): Promise<void> {
    const login = this.login();
    if (!login) return;
    try {
      this.foreignPeriods.set((await serverApi.me(login)).foreignPeriods ?? 0);
    } catch {
      // Beim nächsten Abgleich erneut
    }
  }

  /**
   * Schickt den Kalender für das Abo, wenn er sich seit dem letzten Mal geändert hat (`force`: auf jeden Fall). Der
   * Server erzeugt ihn nicht selbst. Damit er nicht erst aktuell wird, wenn die Lehrkraft ihre App öffnet, schickt
   * jedes Gerät auch die Kalender der Kolleg:innen aus denselben Berichtszeiträumen mit. Fehler stören den Abgleich
   * nicht, z. B. bei einem älteren Server ohne Abo.
   */
  async publishFeed(force = false): Promise<void> {
    const login = this.login();
    const calendar = login && this.feed.render(login.teacherId);
    if (!login || !calendar) return;
    const fingerprint = checksum(`${login.url}|${login.teacherId}|${withoutStamps(calendar)}`);
    if (force || fingerprint !== this.publishedFeed()) {
      try {
        await serverApi.putFeed(login, calendar);
        this.publishedFeed.set(fingerprint);
      } catch (e) {
        console.warn('Kalender für das Abo nicht gesendet', e);
      }
    }
    await this.publishColleagueFeeds(login);
  }

  /**
   * Kalender der Kolleg:innen. Lehnt der Server einen ab (diese App sieht nicht alle Zeiträume der Lehrkraft, kein
   * Konto, älterer Server), gilt er bis zur nächsten Änderung als erledigt; dann schickt ihn deren eigene App.
   */
  private async publishColleagueFeeds(login: ServerLogin): Promise<void> {
    for (const teacherId of this.colleaguesOf(login.teacherId)) {
      const calendar = this.feed.render(teacherId);
      if (!calendar) continue;
      const fingerprint = checksum(`${login.url}|${teacherId}|${withoutStamps(calendar)}`);
      if (fingerprint === this.publishedColleagueFeeds()[teacherId]) continue;
      try {
        await serverApi.putTeacherFeed(login, teacherId, calendar);
      } catch (e) {
        if (!(e instanceof ServerError && [403, 404, 405, 409].includes(e.status))) {
          console.warn('Kalender einer Kollegin oder eines Kollegen nicht gesendet', e);
          continue;
        }
      }
      this.publishedColleagueFeeds.update((map) => ({ ...map, [teacherId]: fingerprint }));
    }
  }

  /** Lehrkräfte, mit denen man einen Berichtszeitraum teilt, der für das Abo noch zählt */
  private colleaguesOf(teacherId: string): string[] {
    const cutoff = addDays(today(), -FEED_DAYS_BACK);
    const periods = this.configStore
      .config()
      .reportPeriods.filter((p) => !p.placeholder && p.to >= cutoff && p.teacherIds.includes(teacherId));
    return [...new Set(periods.flatMap((p) => p.teacherIds))].filter((id) => id !== teacherId);
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
    if (e instanceof StaleError) {
      // Kein Fehler: Ein anderes Gerät war schneller; der nächste Abgleich übernimmt dessen Stand.
      this.scheduleSync();
      return;
    }
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
