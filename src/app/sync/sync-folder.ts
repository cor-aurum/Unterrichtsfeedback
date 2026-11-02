import { registerPlugin } from '@capacitor/core';

/** Ein Ordner, in den die Ordner-Synchronisation ihre Dateien schreibt */
export interface SyncFolder {
  readonly name: string;
  /** Nein, wenn der Zugriff erneut erlaubt werden muss */
  hasAccess(): Promise<boolean>;
  /** Erlaubt den Zugriff erneut; im Browser nur direkt nach einem Klick möglich */
  requestAccess(): Promise<boolean>;
  list(): Promise<string[]>;
  read(name: string): Promise<string>;
  write(name: string, text: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/** Was von einem gewählten Ordner gespeichert wird, um ihn nach einem Neustart wiederzufinden */
export type StoredFolder =
  | { kind: 'browser'; name: string }
  | { kind: 'android'; name: string; uri: string }
  | { kind: 'webdav'; name: string; settings: WebDavSettings };

// ---------- Browser: File System Access API (Chrome, Edge) ----------

/** Teile der File System Access API, die TypeScript noch nicht kennt */
interface DirectoryHandle extends FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
}

type DirectoryPicker = (options: { id: string; mode: 'readwrite' }) => Promise<DirectoryHandle>;

export const browserFoldersSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export async function pickBrowserFolder(): Promise<SyncFolder> {
  const picker = (window as unknown as { showDirectoryPicker: DirectoryPicker }).showDirectoryPicker;
  const handle = await picker({ id: 'unterricht-feedback', mode: 'readwrite' });
  await saveHandle(handle);
  return new BrowserFolder(handle);
}

export async function restoreBrowserFolder(): Promise<SyncFolder | null> {
  const handle = await loadHandle();
  return handle ? new BrowserFolder(handle) : null;
}

class BrowserFolder implements SyncFolder {
  constructor(private readonly handle: DirectoryHandle) {}

  get name(): string {
    return this.handle.name;
  }

  async hasAccess(): Promise<boolean> {
    return (await this.handle.queryPermission({ mode: 'readwrite' })) === 'granted';
  }

  async requestAccess(): Promise<boolean> {
    return (await this.handle.requestPermission({ mode: 'readwrite' })) === 'granted';
  }

  async list(): Promise<string[]> {
    const names: string[] = [];
    for await (const [name, entry] of this.handle.entries()) {
      if (entry.kind === 'file') names.push(name);
    }
    return names;
  }

  async read(name: string): Promise<string> {
    const file = await (await this.handle.getFileHandle(name)).getFile();
    return file.text();
  }

  async write(name: string, text: string): Promise<void> {
    const writable = await (await this.handle.getFileHandle(name, { create: true })).createWritable();
    await writable.write(text);
    await writable.close();
  }

  async remove(name: string): Promise<void> {
    await this.handle.removeEntry(name);
  }
}

/** Ordner-Handles lassen sich nur in IndexedDB speichern, nicht im Local Storage. */
const DB_NAME = 'unterricht-feedback';
const STORE = 'handles';
const KEY = 'syncFolder';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function inStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = action(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).finally(() => db.close()) as Promise<T>;
}

function saveHandle(handle: DirectoryHandle): Promise<IDBValidKey> {
  return inStore('readwrite', (store) => store.put(handle, KEY));
}

function loadHandle(): Promise<DirectoryHandle | undefined> {
  return inStore('readonly', (store) => store.get(KEY));
}

export function forgetBrowserFolder(): Promise<undefined> {
  return inStore('readwrite', (store) => store.delete(KEY));
}

// ---------- Android: Storage Access Framework (z. B. ein Ordner der Nextcloud-App) ----------

/** Eigenes Plugin, siehe `android/app/src/main/java/.../FolderAccessPlugin.java` */
interface FolderAccessPlugin {
  pickFolder(): Promise<{ uri: string; name: string }>;
  hasAccess(options: { uri: string }): Promise<{ granted: boolean }>;
  list(options: { uri: string }): Promise<{ names: string[] }>;
  read(options: { uri: string; name: string }): Promise<{ text: string }>;
  write(options: { uri: string; name: string; text: string }): Promise<void>;
  remove(options: { uri: string; name: string }): Promise<void>;
}

const FolderAccess = registerPlugin<FolderAccessPlugin>('FolderAccess');

export async function pickAndroidFolder(): Promise<{ folder: SyncFolder; stored: StoredFolder }> {
  const { uri, name } = await FolderAccess.pickFolder();
  return { folder: new AndroidFolder(uri, name), stored: { kind: 'android', uri, name } };
}

export function restoreAndroidFolder(stored: { uri: string; name: string }): SyncFolder {
  return new AndroidFolder(stored.uri, stored.name);
}

class AndroidFolder implements SyncFolder {
  constructor(
    private readonly uri: string,
    readonly name: string,
  ) {}

  async hasAccess(): Promise<boolean> {
    return (await FolderAccess.hasAccess({ uri: this.uri })).granted;
  }

  /** Eine verlorene Freigabe lässt sich nur durch erneute Auswahl des Ordners zurückholen. */
  async requestAccess(): Promise<boolean> {
    return this.hasAccess();
  }

  async list(): Promise<string[]> {
    return (await FolderAccess.list({ uri: this.uri })).names;
  }

  async read(name: string): Promise<string> {
    return (await FolderAccess.read({ uri: this.uri, name })).text;
  }

  write(name: string, text: string): Promise<void> {
    return FolderAccess.write({ uri: this.uri, name, text });
  }

  remove(name: string): Promise<void> {
    return FolderAccess.remove({ uri: this.uri, name });
  }
}

// ---------- WebDAV, z. B. Nextcloud (alle Browser und die App) ----------

/** Vom Nutzer eingetragene Zugangsdaten; das App-Passwort liegt im Speicher dieses Browsers bzw. der App. */
export interface WebDavSettings {
  /** Adresse der Nextcloud (z. B. https://cloud.example.de) oder eine vollständige WebDAV-Adresse */
  url: string;
  user: string;
  password: string;
  /** Ordner unterhalb der Adresse, z. B. „Unterrichtsfeedback“ */
  folder: string;
}

/** Fehler mit einem für Nutzer verständlichen Text */
export class WebDavError extends Error {}

export class WebDavFolder implements SyncFolder {
  private readonly baseUrl: string;

  constructor(private readonly settings: WebDavSettings) {
    this.baseUrl = folderUrl(settings);
  }

  get name(): string {
    return `${this.settings.folder || '/'} auf ${new URL(this.settings.url).host}`;
  }

  async hasAccess(): Promise<boolean> {
    const response = await this.request('PROPFIND', '', { Depth: '0' });
    return response.ok;
  }

  requestAccess(): Promise<boolean> {
    return this.hasAccess();
  }

  /** Prüft die Zugangsdaten und legt den Ordner an, falls es ihn noch nicht gibt. */
  async prepare(): Promise<void> {
    const response = await this.request('PROPFIND', '', { Depth: '0' });
    if (response.status === 404) {
      await this.createFolders();
    } else {
      this.check(response, 'Der Ordner');
    }
  }

  async list(): Promise<string[]> {
    const response = this.check(await this.request('PROPFIND', '', { Depth: '1' }, PROPFIND_BODY), 'Der Ordner');
    const xml = new DOMParser().parseFromString(await response.text(), 'application/xml');
    return [...xml.getElementsByTagNameNS('DAV:', 'response')]
      .filter((entry) => entry.getElementsByTagNameNS('DAV:', 'collection').length === 0)
      .map((entry) => entry.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent ?? '')
      .map((href) => decodeURIComponent(href.replace(/\/$/, '').split('/').at(-1) ?? ''))
      .filter((name) => name);
  }

  async read(name: string): Promise<string> {
    return (await this.check(await this.request('GET', name), `„${name}“`)).text();
  }

  async write(name: string, text: string): Promise<void> {
    this.check(await this.request('PUT', name, { 'Content-Type': 'application/json; charset=utf-8' }, text), `„${name}“`);
  }

  async remove(name: string): Promise<void> {
    const response = await this.request('DELETE', name);
    if (response.status !== 404) this.check(response, `„${name}“`);
  }

  /** Legt den Ordner Stufe für Stufe an (MKCOL kann nur eine Ebene). */
  private async createFolders(): Promise<void> {
    const root = rootUrl(this.settings);
    let url = root;
    for (const segment of folderSegments(this.settings.folder)) {
      url += `/${encodeURIComponent(segment)}`;
      const response = await this.fetch('MKCOL', url);
      // 405: Ordner gibt es schon
      if (!response.ok && response.status !== 405) this.check(response, 'Der Ordner');
    }
  }

  private request(method: string, name: string, headers: Record<string, string> = {}, body?: string): Promise<Response> {
    const url = name ? `${this.baseUrl}/${encodeURIComponent(name)}` : `${this.baseUrl}/`;
    return this.fetch(method, url, headers, body);
  }

  private async fetch(method: string, url: string, headers: Record<string, string> = {}, body?: string): Promise<Response> {
    try {
      return await fetch(url, {
        method,
        body,
        cache: 'no-store',
        headers: { ...headers, Authorization: `Basic ${base64(`${this.settings.user}:${this.settings.password}`)}` },
      });
    } catch {
      throw new WebDavError(
        'Der Server ist nicht erreichbar oder lässt Zugriffe von dieser Seite nicht zu. Ist die Adresse richtig ' +
          'und in der Nextcloud die App „WebAppPassword“ für diese Seite eingerichtet?',
      );
    }
  }

  private check(response: Response, what: string): Response {
    if (response.ok) return response;
    if (response.status === 401) throw new WebDavError('Benutzername oder App-Passwort ist falsch.');
    if (response.status === 403) throw new WebDavError(`${what}: Zugriff verweigert.`);
    if (response.status === 404) throw new WebDavError(`${what} wurde auf dem Server nicht gefunden.`);
    throw new WebDavError(`${what}: Der Server antwortet mit Fehler ${response.status}.`);
  }
}

const PROPFIND_BODY =
  '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';

/**
 * WebDAV-Wurzel: Eine Nextcloud-Adresse ohne „/remote.php/“ bekommt den Pfad zu den Dateien des Nutzers;
 * jede andere Adresse gilt schon als WebDAV-Adresse.
 */
function rootUrl(settings: WebDavSettings): string {
  const url = settings.url.trim().replace(/\/+$/, '');
  return url.includes('/remote.php/') ? url : `${url}/remote.php/dav/files/${encodeURIComponent(settings.user)}`;
}

function folderUrl(settings: WebDavSettings): string {
  return [rootUrl(settings), ...folderSegments(settings.folder).map(encodeURIComponent)].join('/');
}

function folderSegments(folder: string): string[] {
  return folder.split('/').map((segment) => segment.trim()).filter((segment) => segment);
}

/** Base64 für Basic-Auth; auch mit Umlauten im Passwort */
function base64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}
