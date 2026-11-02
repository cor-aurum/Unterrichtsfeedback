import { computed, Injectable } from '@angular/core';
import { formatDate, Lesson, Student, today } from './model';
import { storedSignal } from './stored-signal';

/** Zeitraum als ISO-Daten, jeweils einschließlich */
export interface Period {
  from: string;
  to: string;
}

/**
 * Berichtszeitraum, z. B. ein Schulhalbjahr. Er bestimmt, welche Personen und Stunden im PDF stehen und
 * welche Stunden für den allgemeinen Teil zählen. Er gilt nur auf diesem Gerät.
 */
@Injectable({ providedIn: 'root' })
export class ReportPeriod {
  readonly period = storedSignal<Period>('feedback.reportPeriod', currentSchoolHalfYear, parsePeriod);
  readonly label = computed(() => `${formatDate(this.period().from)} – ${formatDate(this.period().to)}`);

  set(period: Period): void {
    this.period.set(period);
  }

  contains(date: string): boolean {
    const { from, to } = this.period();
    return date >= from && date <= to;
  }

  lessonsOf(student: Student): Lesson[] {
    return student.lessons.filter((lesson) => this.contains(lesson.date));
  }
}

/** Schulhalbjahr, in dem heute liegt: 1. August bis 31. Januar oder 1. Februar bis 31. Juli */
function currentSchoolHalfYear(): Period {
  const date = today();
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  if (month >= 8) return { from: `${year}-08-01`, to: `${year + 1}-01-31` };
  if (month === 1) return { from: `${year - 1}-08-01`, to: `${year}-01-31` };
  return { from: `${year}-02-01`, to: `${year}-07-31` };
}

function parsePeriod(data: unknown): Period {
  const period = data as Partial<Period>;
  const valid = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  return valid(period?.from) && valid(period?.to) && period.from! <= period.to!
    ? { from: period.from!, to: period.to! }
    : currentSchoolHalfYear();
}
