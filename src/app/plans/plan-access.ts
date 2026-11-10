import { ReportPeriodEntry } from '../model';
import { demoMode } from '../stored-signal';
import { ServerLogin, serverApi } from '../sync/server-folder';

/** Schlüssel der echten Anmeldung, außerhalb der Demodaten (siehe `ServerSync.login`) */
const LOGIN_KEY = 'feedback.server';
/** Wie auf dem Server: Demo-Link des Kontos */
const DEMO_PLAN_PREFIX = 'demo-konto-';

/**
 * Anmeldung für den Download-Link. Im Demomodus gleicht die App nichts mit dem Server ab; den Link zum Ausprobieren
 * gibt es trotzdem, mit der echten Anmeldung, aber unter einem eigenen Demo-Link des Kontos statt des Zeitraums.
 */
export function realServerLogin(): ServerLogin | null {
  try {
    const login = JSON.parse(localStorage.getItem(LOGIN_KEY) ?? 'null') as ServerLogin | null;
    return login?.url && login.token && login.teacherId ? login : null;
  } catch {
    return null;
  }
}

/** Unter dieser ID kennt der Server den Link des Zeitraums; im Demomodus der Demo-Link des Kontos. */
export function planServerId(period: ReportPeriodEntry, login: ServerLogin): string {
  return demoMode ? DEMO_PLAN_PREFIX + login.teacherId : period.id;
}

/** Löscht den Demo-Link beim Starten oder Verlassen der Demo; ohne Verbindung verfällt er nach drei Tagen. */
export async function deleteDemoPlanLink(): Promise<void> {
  const login = realServerLogin();
  if (!login) return;
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3000));
  await Promise.race([serverApi.deletePlan(login, DEMO_PLAN_PREFIX + login.teacherId).catch(() => undefined), timeout]);
}
