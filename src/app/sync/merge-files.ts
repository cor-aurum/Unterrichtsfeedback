/** Listen einer Zeitraum-Datei, deren Einträge eine `id` haben */
const RECORD_LISTS = ['students', 'groups', 'appointments'] as const;

type FileContent = Record<string, unknown>;
type Entry = { id: string };

/**
 * Dreiwege-Zusammenführung einer Zeitraum-Datei je Eintrag (Person, Gruppe, Termin), z. B. wenn sich an zwei
 * Tablets gleichzeitig Personen bei derselben Lehrkraft eintragen. Was nur eine Seite geändert, hinzugefügt oder
 * entfernt hat, gilt; `null`, wenn derselbe Eintrag auf beiden Seiten unterschiedlich geändert wurde – dann
 * entscheidet wie bisher die Lehrkraft. Ohne bekannten Stand des letzten Abgleichs (`base`) bleiben Einträge beider
 * Seiten erhalten.
 */
export function mergePeriodFile(base: string | undefined, local: string | undefined, remote: string | undefined): string | null {
  const [b, l, r] = [parse(base), parse(local), parse(remote)];
  if (!b || !l || !r) return null;
  const merged: FileContent = { ...r, ...l };
  for (const key of new Set([...Object.keys(l), ...Object.keys(r)])) {
    if (isRecordList(key)) continue;
    // Kopfdaten wie Zeitraum und Lehrkraft; fehlt die Datei auf einer Seite, gelten die der anderen.
    if (local !== undefined && remote !== undefined && JSON.stringify(l[key]) !== JSON.stringify(r[key])) return null;
  }
  for (const key of RECORD_LISTS) {
    const list = mergeList(entries(b[key]), entries(l[key]), entries(r[key]));
    if (!list) return null;
    merged[key] = list;
  }
  return JSON.stringify(merged, null, 2);
}

function mergeList(base: Entry[], local: Entry[], remote: Entry[]): Entry[] | null {
  const [b, l, r] = [byId(base), byId(local), byId(remote)];
  const ids = [...new Set([...remote.map((e) => e.id), ...local.map((e) => e.id), ...base.map((e) => e.id)])];
  const result: Entry[] = [];
  for (const id of ids) {
    const [bv, lv, rv] = [b.get(id), l.get(id), r.get(id)];
    const chosen = lv === rv ? lv : lv === bv ? rv : rv === bv ? lv : null;
    if (chosen === null) return null;
    if (chosen !== undefined) result.push(JSON.parse(chosen) as Entry);
  }
  return result;
}

/** Eintrag je ID als Text, damit gleiche Inhalte gleich sind */
function byId(list: Entry[]): Map<string, string> {
  return new Map(list.map((entry) => [entry.id, JSON.stringify(entry)]));
}

function entries(value: unknown): Entry[] {
  return Array.isArray(value) ? value.filter((e): e is Entry => !!e && typeof (e as Entry).id === 'string') : [];
}

function isRecordList(key: string): boolean {
  return (RECORD_LISTS as readonly string[]).includes(key);
}

/** Eine fehlende Datei ist leer; ungültiger Inhalt lässt sich nicht zusammenführen. */
function parse(content: string | undefined): FileContent | null {
  if (content === undefined) return {};
  try {
    const value = JSON.parse(content) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as FileContent) : null;
  } catch {
    return null;
  }
}
