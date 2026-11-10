import { isNativeApp } from '../save-file';

/** Was der Browser über das Gerät verrät; als Parameter, damit sich die Erkennung ohne Gerät prüfen lässt. */
export interface BrowserInfo {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  /** Von Home-Bildschirm geöffnet (Safari: `navigator.standalone`, sonst `display-mode: standalone`) */
  standalone: boolean;
}

/**
 * Auf iPhone und iPad löscht Safari die Daten einer Webseite, die sieben Tage nicht benutzt wurde – außer sie wurde
 * zum Home-Bildschirm hinzugefügt und von dort geöffnet. Dann lohnt der Hinweis darauf; in der Android-App und auf
 * anderen Geräten nicht. iPads melden sich seit iPadOS 13 wie ein Mac, verraten sich aber durch Touch.
 */
export function suggestHomeScreen(info: BrowserInfo = currentBrowser()): boolean {
  const apple = /iPhone|iPad|iPod/.test(info.userAgent) || (info.platform === 'MacIntel' && info.maxTouchPoints > 1);
  return apple && !info.standalone;
}

function currentBrowser(): BrowserInfo {
  if (isNativeApp || typeof navigator === 'undefined') {
    return { userAgent: '', platform: '', maxTouchPoints: 0, standalone: true };
  }
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches);
  return { userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints, standalone };
}
