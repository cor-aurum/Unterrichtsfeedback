import { newId } from '../model';
import { timeOf } from './appointments';

/**
 * Zeit, in der ein Lehrer nicht unterrichtet, obwohl sie in seinen Unterrichtszeiten liegt, z. B. eine
 * Fortbildung. Kann mehrere Tage umfassen. Zeitpunkte als „YYYY-MM-DDTHH:MM“; so lassen sie sich als Text
 * vergleichen.
 */
export interface Blocker {
  id: string;
  teacherId: string;
  /** Darf leer sein, z. B. „Fortbildung“ */
  title: string;
  from: string;
  to: string;
}

/** Überschneidet der Blocker den Zeitraum von `start` bis `start + duration` Minuten am Tag `date`? */
export function blocks(blocker: Blocker, date: string, start: number, duration: number): boolean {
  const slotStart = `${date}T${timeOf(start)}`;
  const slotEnd = start + duration >= 24 * 60 ? `${date}T24:00` : `${date}T${timeOf(start + duration)}`;
  return slotStart < blocker.to && blocker.from < slotEnd;
}

/** Teil des Blockers an einem Tag, z. B. `{ start: '14:00', end: '24:00' }`; `null`, wenn er den Tag nicht berührt. */
export function blockerOnDay(blocker: Blocker, date: string): { start: string; end: string } | null {
  const dayStart = `${date}T00:00`;
  const dayEnd = `${date}T24:00`;
  if (blocker.to <= dayStart || blocker.from >= dayEnd) return null;
  return {
    start: blocker.from > dayStart ? blocker.from.slice(11) : '00:00',
    end: blocker.to < dayEnd ? blocker.to.slice(11) : '24:00',
  };
}

/** z. B. „ganztägig“ oder „14:00–18:00“ */
export function blockerTimeText({ start, end }: { start: string; end: string }): string {
  return start === '00:00' && end === '24:00' ? 'ganztägig' : `${start}–${end === '24:00' ? '24:00' : end}`;
}

export function parseBlockers(data: unknown): Blocker[] {
  if (!Array.isArray(data)) return [];
  const dateTime = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value);
  return data
    .filter((b: Partial<Blocker>) => typeof b?.teacherId === 'string' && dateTime(b.from) && dateTime(b.to) && b.from! < b.to!)
    .map((b: Blocker) => ({
      id: typeof b.id === 'string' ? b.id : newId(),
      teacherId: b.teacherId,
      title: typeof b.title === 'string' ? b.title : '',
      from: b.from,
      to: b.to,
    }));
}
