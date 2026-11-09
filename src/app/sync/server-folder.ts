import { registerPlugin } from '@capacitor/core';
import { isNativeApp } from '../save-file';
import { FolderEntry, SyncFolder } from './sync-folder';

/** Anmeldung am Server; das Token ersetzt das Passwort, bis man sich abmeldet. */
export interface ServerLogin {
  url: string;
  username: string;
  teacherId: string;
  token: string;
}

/** Fehler mit einem Text vom Server oder einer verständlichen Beschreibung */
export class ServerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Die Datei wurde seit dem letzten Lesen auf einem anderen Gerät geändert; erst neu abgleichen. */
export class StaleError extends ServerError {
  constructor(readonly file: string) {
    super(`„${file}“ wurde inzwischen auf einem anderen Gerät geändert.`, 412);
  }
}

/** Inhalt eines Einladungs- oder Reset-Codes („UF1.…“) */
export interface PackedCode {
  server: string;
  kind: 'invite' | 'reset';
  code: string;
}

export function unpackCode(text: string): PackedCode | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('UF1.')) return null;
  try {
    const base64 = trimmed.slice(4).replace(/-/g, '+').replace(/_/g, '/');
    const json = new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
    const data = JSON.parse(json) as { s?: string; k?: string; c?: string };
    if (!data.s || !data.c || (data.k !== 'invite' && data.k !== 'reset')) return null;
    return { server: data.s, kind: data.k, code: data.c };
  } catch {
    return null;
  }
}

/** Adresse ohne Schrägstrich am Ende; ohne Schema gilt https. */
export function normalizeServerUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** Eigenes Plugin, siehe `android/app/src/main/java/.../WebDavHttpPlugin.java`: HTTP ohne CORS-Sperre */
interface NativeHttpPlugin {
  request(options: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; body: string }>;
}

const NativeHttp = registerPlugin<NativeHttpPlugin>('WebDavHttp');

/**
 * Anfrage an den Server. In der Android-App läuft sie über Android, damit der Server keine Zugriffe von der App
 * erlauben muss; im Browser über `fetch` (der Server erlaubt das per CORS).
 */
async function request(
  url: string,
  method: string,
  path: string,
  options: { token?: string; body?: string; contentType?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': options.contentType ?? 'application/json; charset=utf-8',
    ...options.headers,
  };
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
  const target = `${url}${path}`;
  try {
    if (isNativeApp) {
      const { status, body } = await NativeHttp.request({ method, url: target, headers, body: options.body });
      return new Response([204, 205, 304].includes(status) ? null : body, { status });
    }
    return await fetch(target, { method, headers, body: options.body, cache: 'no-store' });
  } catch {
    throw new ServerError('Der Server ist nicht erreichbar. Ist die Adresse richtig und das Gerät online?', 0);
  }
}

/** Wirft bei einer Fehlerantwort den Text des Servers. */
async function checked(response: Response): Promise<Response> {
  if (response.ok) return response;
  let message = `Der Server antwortet mit Fehler ${response.status}.`;
  try {
    const data = (await response.clone().json()) as { error?: string };
    if (data.error) message = data.error;
  } catch {
    // Kein JSON, z. B. eine Fehlerseite des Proxys
  }
  throw new ServerError(message, response.status);
}

async function json<T>(response: Promise<Response>): Promise<T> {
  return (await checked(await response)).json() as Promise<T>;
}

type SessionAnswer = { token: string; username: string; teacherId: string };

function toLogin(url: string, answer: SessionAnswer): ServerLogin {
  return { url, username: answer.username, teacherId: answer.teacherId, token: answer.token };
}

/** Anmelden, Einladungen und Zusammenführungen; der Abgleich der Daten läuft über `ServerFolder`. */
export const serverApi = {
  async login(url: string, username: string, password: string): Promise<ServerLogin> {
    const base = normalizeServerUrl(url);
    const body = JSON.stringify({ username: username.trim(), password });
    return toLogin(base, await json<SessionAnswer>(request(base, 'POST', '/api/login', { body })));
  },

  /** `teacherId`: der eigene Lehrer der App; gilt nur bei Einladungen, die an keinen Lehrer gebunden sind. */
  async redeem(code: PackedCode, username: string, password: string, teacherId: string): Promise<ServerLogin> {
    const base = normalizeServerUrl(code.server);
    const body = JSON.stringify({ code: code.code, username: username.trim(), password, teacherId });
    return toLogin(base, await json<SessionAnswer>(request(base, 'POST', '/api/redeem', { body })));
  },

  async reset(code: PackedCode, password: string): Promise<ServerLogin> {
    const base = normalizeServerUrl(code.server);
    const body = JSON.stringify({ code: code.code, password });
    return toLogin(base, await json<SessionAnswer>(request(base, 'POST', '/api/reset', { body })));
  },

  /** Abmelden ist ein Versuch; offline bleibt das Token auf dem Server, bis es verfällt. */
  async logout(login: ServerLogin): Promise<void> {
    await request(login.url, 'POST', '/api/logout', { token: login.token }).catch(() => undefined);
  },

  invite(login: ServerLogin, teacherId: string): Promise<{ code: string; expiresAt: string }> {
    return json(request(login.url, 'POST', '/api/invites', { token: login.token, body: JSON.stringify({ teacherId }) }));
  },

  accounts(login: ServerLogin): Promise<{ teacherId: string; username: string }[]> {
    return json(request(login.url, 'GET', '/api/accounts', { token: login.token }));
  },

  merges(login: ServerLogin): Promise<{ from: string; into: string }[]> {
    return json(request(login.url, 'GET', '/api/merges', { token: login.token }));
  },

  async addMerge(login: ServerLogin, from: string, into: string): Promise<void> {
    const body = JSON.stringify({ from, into });
    await checked(await request(login.url, 'POST', '/api/merges', { token: login.token, body }));
  },

  /** Eigenes Konto; `foreignPeriods`: Berichtszeiträume, in denen der Lehrer nicht eingetragen ist */
  me(login: ServerLogin): Promise<{ username: string; teacherId: string; foreignPeriods?: number; conditionalWrites?: boolean }> {
    return json(request(login.url, 'GET', '/api/me', { token: login.token }));
  },

  /** Kalender-Abo: `url` ist leer, solange keins eingerichtet ist. */
  feed(login: ServerLogin): Promise<FeedState> {
    return json(request(login.url, 'GET', '/api/feed', { token: login.token }));
  },

  async putFeed(login: ServerLogin, calendar: string): Promise<void> {
    const options = { token: login.token, body: calendar, contentType: 'text/calendar; charset=utf-8' };
    await checked(await request(login.url, 'PUT', '/api/feed', options));
  },

  /** Richtet das Abo ein oder ersetzt seine Adresse; die alte gilt danach nicht mehr. */
  newFeedAddress(login: ServerLogin): Promise<FeedState> {
    return json(request(login.url, 'POST', '/api/feed/address', { token: login.token }));
  },

  async endFeed(login: ServerLogin): Promise<void> {
    await checked(await request(login.url, 'DELETE', '/api/feed/address', { token: login.token }));
  },
};

export interface FeedState {
  url: string;
  /** Wann die App den Kalender zuletzt geschickt hat (ISO); leer, wenn noch nie */
  updatedAt?: string;
}

/**
 * Der Server als „Ordner“ für die Synchronisation: Dokumente auflisten, lesen, schreiben, löschen. Was der Lehrer
 * nicht sehen darf, listet der Server gar nicht erst; Schreiben ohne Recht (z. B. Daten eines Zeitraums, aus dem
 * er ausgetragen wurde) überspringt die App.
 */
export class ServerFolder implements SyncFolder {
  /** Kennt der Server If-Match? Einmal gefragt; ältere Server lehnen den Header im Browser ab (CORS). */
  private conditional?: Promise<boolean>;

  constructor(private readonly login: ServerLogin) {}

  get name(): string {
    return new URL(this.login.url).host;
  }

  async hasAccess(): Promise<boolean> {
    const response = await request(this.login.url, 'GET', '/api/me', { token: this.login.token });
    if (response.status === 401) return false;
    await checked(response);
    return true;
  }

  requestAccess(): Promise<boolean> {
    return this.hasAccess();
  }

  list(): Promise<FolderEntry[]> {
    return json(request(this.login.url, 'GET', '/api/docs', { token: this.login.token }));
  }

  async read(name: string): Promise<string> {
    return (await checked(await request(this.login.url, 'GET', `/api/docs/${encodeURIComponent(name)}`, { token: this.login.token }))).text();
  }

  async write(name: string, text: string, expected?: string): Promise<string | undefined> {
    const guarded = expected !== undefined && (await this.supportsIfMatch());
    const response = await request(this.login.url, 'PUT', `/api/docs/${encodeURIComponent(name)}`, {
      token: this.login.token,
      body: text,
      headers: guarded ? { 'If-Match': expected } : undefined,
    });
    if (response.status === 403 && name !== 'konfiguration.json') {
      console.warn(`„${name}“ übersprungen: kein Zugriff auf diesen Berichtszeitraum`);
      return undefined;
    }
    if (response.status === 412) throw new StaleError(name);
    const answer = (await (await checked(response)).json().catch(() => ({}))) as { version?: string };
    return answer.version;
  }

  private supportsIfMatch(): Promise<boolean> {
    this.conditional ??= serverApi.me(this.login).then(
      (me) => me.conditionalWrites === true,
      () => {
        // Beim nächsten Schreiben erneut fragen
        this.conditional = undefined;
        return false;
      },
    );
    return this.conditional;
  }

  async remove(name: string): Promise<void> {
    const response = await request(this.login.url, 'DELETE', `/api/docs/${encodeURIComponent(name)}`, { token: this.login.token });
    if (response.status === 403 || response.status === 404) return;
    await checked(response);
  }
}
