import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { ConfigStore } from '../config.store';
import { PdfFile } from '../pdf-export';
import { isNativeApp, openFile, saveFile } from '../save-file';
import { ServerLogin, serverApi, SharedFileEntry, SharedFilesState } from '../sync/server-folder';
import { ServerSync } from '../sync/server-sync';
import { storedSignal } from '../stored-signal';

/** So oft fragt die App nach neuen Dateien, solange sie angemeldet und sichtbar ist */
const POLL_MS = 3 * 60 * 1000;

/** Wohin eine Datei geht: an einzelne Lehrkräfte oder an alle Lehrkräfte eines Berichtszeitraums */
export type ShareTarget = { to: string[] } | { period: string };

/**
 * Fertige PDFs (Feedback- und Gruppen-PDFs) einer anderen Lehrkraft bereitstellen, damit sie sie druckt oder
 * versendet, ohne selbst Zugriff auf die Daten zu brauchen. Die Dateien liegen 30 Tage auf dem Server; wer sie
 * bereitgestellt hat, sieht, wer sie schon geöffnet hat. Nur mit Server.
 */
@Injectable({ providedIn: 'root' })
export class SharedFiles {
  private readonly sync = inject(ServerSync);
  private readonly config = inject(ConfigStore).config;
  readonly state = signal<SharedFilesState>({ received: [], sent: [] });
  readonly error = signal<string | null>(null);
  /** Noch nicht geöffnete Dateien für mich; die Navigation zeigt ihre Zahl. */
  readonly unopened = computed(() => this.state().received.filter((file) => !file.openedAt).length);
  /** Dateien, auf die die Meldung oben schon hingewiesen hat (je Gerät), damit sie nur einmal erscheint */
  private readonly announced = storedSignal<string[]>('feedback.announcedSharedFiles', () => [], (data) =>
    Array.isArray(data) ? data.filter((id): id is string => typeof id === 'string') : [],
  );
  /** Neue, ungeöffnete Dateien für die Meldung oben in der App, die neueste zuerst */
  readonly announcements = computed(() => {
    const seen = new Set(this.announced());
    return this.state().received.filter((file) => !file.openedAt && !seen.has(file.id));
  });

  constructor() {
    effect(() => {
      const login = this.sync.login();
      if (login) untracked(() => void this.load());
      else this.state.set({ received: [], sent: [] });
    });
    setInterval(() => {
      if (document.visibilityState === 'visible') void this.load();
    }, POLL_MS);
    window.addEventListener('focus', () => void this.load());
  }

  async load(): Promise<void> {
    const login = this.sync.login();
    if (!login) return;
    try {
      const state = await serverApi.sharedFiles(login);
      this.state.set(state);
      this.error.set(null);
      // Vergessen, was es nicht mehr gibt, damit die Liste nicht wächst
      const current = new Set(state.received.map((file) => file.id));
      if (this.announced().some((id) => !current.has(id))) this.announced.update((ids) => ids.filter((id) => current.has(id)));
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    }
  }

  /** Die Meldung oben ausblenden; die Dateien bleiben unter „Export & Sicherung“ als neu markiert. */
  dismissAnnouncements(): void {
    const ids = this.announcements().map((file) => file.id);
    this.announced.update((seen) => [...new Set([...seen, ...ids])]);
  }

  /** Stellt das PDF bereit; liefert die Lehrkräfte, die es bekommen. */
  async share(file: PdfFile, target: ShareTarget): Promise<string[]> {
    const recipients = await serverApi.shareFile(this.login(), file.name, await toBase64(file.content), target);
    await this.load();
    return recipients;
  }

  /**
   * Öffnet die Datei zum Ansehen und Drucken: im Browser in einem neuen Tab (das Fenster geht sofort auf, damit der
   * Browser es nicht als Pop-up blockiert), in der Android-App mit einem PDF-Viewer.
   */
  async open(file: SharedFileEntry): Promise<void> {
    const tab = isNativeApp ? null : window.open('', '_blank');
    try {
      const content = await this.content(file);
      if (tab) tab.location.href = URL.createObjectURL(content);
      else await openFile(file.name, content);
    } catch (e) {
      tab?.close();
      throw e;
    }
  }

  /** Speichert die Datei bzw. öffnet „Teilen“, um sie z. B. per Mail zu versenden. */
  async save(file: SharedFileEntry): Promise<void> {
    await saveFile(file.name, await this.content(file));
  }

  async remove(file: SharedFileEntry): Promise<void> {
    await serverApi.deleteSharedFile(this.login(), file.id);
    await this.load();
  }

  /** Name einer Lehrkraft aus den Daten der App, sonst ihr Benutzername bzw. „unbekannt“ */
  teacherName(teacherId: string | undefined, usernames: Map<string, string> = new Map()): string {
    const teacher = this.config().teachers.find((t) => t.id === teacherId);
    return teacher?.name ?? usernames.get(teacherId ?? '') ?? 'eine Lehrkraft';
  }

  private async content(file: SharedFileEntry): Promise<Blob> {
    const base64 = await serverApi.sharedFileContent(this.login(), file.id);
    // Danach steht „geöffnet“ beim Absender; die eigene Liste zeigt die Datei nicht mehr als neu.
    void this.load();
    return fromBase64(base64);
  }

  private login(): ServerLogin {
    const login = this.sync.login();
    if (!login) throw new Error('Dafür musst du am Server angemeldet sein.');
    return login;
  }
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('Die Datei ließ sich nicht lesen.'));
    reader.readAsDataURL(blob);
  });
}

async function fromBase64(base64: string): Promise<Blob> {
  const response = await fetch(`data:application/pdf;base64,${base64.trim()}`);
  return new Blob([await response.arrayBuffer()], { type: 'application/pdf' });
}
