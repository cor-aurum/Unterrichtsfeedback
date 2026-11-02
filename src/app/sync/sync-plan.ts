import { GENERAL_FILE } from './sync-files';

/** Prüfsumme je Dateiname; eine fehlende Datei hat keinen Eintrag. */
export type Checksums = Record<string, string>;

/** Was ein Abgleich tun muss */
export interface SyncPlan {
  /** Nur im Ordner geändert, hinzugekommen oder gelöscht: auf dieses Gerät übernehmen */
  pull: string[];
  /** Auf beiden Seiten unterschiedlich geändert: Nutzer entscheidet */
  conflicts: string[];
}

/**
 * Dreiwege-Abgleich je Datei zwischen dem Stand beim letzten Abgleich (`base`), diesem Gerät (`local`) und dem
 * Ordner (`remote`). Lokale Änderungen schreibt der Abgleich danach ohnehin, sie stehen deshalb nicht im Plan.
 * Weil jeder Lehrer eine eigene Datei hat, stören sich Änderungen an verschiedenen Lehrern nicht.
 */
export function planSync(base: Checksums, local: Checksums, remote: Checksums): SyncPlan {
  const names = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  const plan: SyncPlan = { pull: [], conflicts: [] };
  for (const name of names) {
    const [b, l, r] = [base[name], local[name], remote[name]];
    if (l === r || r === b) continue;
    // Ohne allgemeine Konfiguration lassen sich die Daten nicht zusammensetzen; sie wird neu geschrieben.
    if (name === GENERAL_FILE && r === undefined) continue;
    if (l === b) {
      plan.pull.push(name);
    } else {
      plan.conflicts.push(name);
    }
  }
  return plan;
}
