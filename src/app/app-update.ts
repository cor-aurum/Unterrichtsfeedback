import { computed, Injectable } from '@angular/core';
import { isNativeApp } from './save-file';
import { storedSignal } from './stored-signal';

/** Beim Bauen der Android-App eingesetzt (`ng build --define`, siehe .github/workflows/android.yml) */
declare const APP_VERSION: string | undefined;

/** Version dieser App, z. B. „2.1.0“; leer in der Entwicklung und auf der Webseite */
export const appVersion = typeof APP_VERSION === 'string' ? APP_VERSION : '';

const LATEST_RELEASE = 'https://api.github.com/repos/cor-aurum/Unterrichtsfeedback/releases/latest';
/** GitHub erlaubt ohne Anmeldung 60 Abfragen je Stunde; einmal am Tag reicht. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface Release {
  version: string;
  /** Seite des Releases mit den Änderungen und der APK */
  url: string;
}

/**
 * Hinweis auf eine neuere Android-App. Die App fragt höchstens einmal am Tag bei GitHub nach dem neuesten Release;
 * ein ausgeblendeter Hinweis kommt erst bei der nächsten Version wieder. Die Webseite ist ohnehin immer aktuell,
 * Testversionen (z. B. „0.0.0-test.12“) fragen nicht.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdate {
  private readonly lastCheck = storedSignal<number>('feedback.updateCheck', () => 0);
  private readonly latest = storedSignal<Release | null>('feedback.updateLatest', () => null, parseRelease);
  private readonly dismissed = storedSignal<string>('feedback.updateDismissed', () => '');

  readonly offer = computed<Release | null>(() => {
    const latest = this.latest();
    const newer = !!appVersion && !!latest && isNewer(latest.version, appVersion);
    return newer && latest!.version !== this.dismissed() ? latest : null;
  });

  constructor() {
    if (isNativeApp && /^\d+\.\d+\.\d+$/.test(appVersion)) void this.check();
  }

  dismiss(): void {
    const offer = this.offer();
    if (offer) this.dismissed.set(offer.version);
  }

  private async check(): Promise<void> {
    if (Date.now() - this.lastCheck() < CHECK_INTERVAL_MS) return;
    try {
      const response = await fetch(LATEST_RELEASE, { headers: { Accept: 'application/vnd.github+json' } });
      if (!response.ok) return;
      const release = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
      this.lastCheck.set(Date.now());
      this.latest.set(parseRelease({ version: String(release.tag_name ?? '').replace(/^v/, ''), url: release.html_url }));
    } catch {
      // Offline: Beim nächsten Start wird erneut gefragt.
    }
  }
}

/** Vergleicht „2.10.0“ und „2.9.1“ Zahl für Zahl. */
export function isNewer(candidate: string, current: string): boolean {
  const parts = (version: string) => version.split('.').map((part) => parseInt(part, 10) || 0);
  const [a, b] = [parts(candidate), parts(current)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

function parseRelease(data: unknown): Release | null {
  const release = data as Partial<Release> | null;
  const valid =
    typeof release?.version === 'string' &&
    /^\d+\.\d+\.\d+$/.test(release.version) &&
    typeof release.url === 'string' &&
    release.url.startsWith('https://github.com/');
  return valid ? { version: release!.version!, url: release!.url! } : null;
}
