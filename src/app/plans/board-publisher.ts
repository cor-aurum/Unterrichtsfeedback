import { inject, Injectable } from '@angular/core';
import { daysBetween, endTime, minutesOf, Occurrence, startMinutes } from '../calendar/appointments';
import { CalendarStore } from '../calendar/calendar.store';
import { withLanes } from '../calendar/lanes';
import { SharedOccurrence, sharedSpanMinutes, sharedTimeText } from '../calendar/shared-appointments';
import { ConfigStore } from '../config.store';
import { GroupsStore } from '../groups.store';
import { formatLongDate, formatShortDate, Group, isActiveIn, periodTeachers, ReportPeriodEntry, Teacher, today } from '../model';
import { planningLabels, shortName } from '../planning/planning-labels';
import { storedSignal } from '../stored-signal';
import { StudentsStore } from '../students.store';
import { checksum } from '../sync/checksum';
import { ServerError, ServerLogin, serverApi } from '../sync/server-folder';
import { planServerId } from './plan-access';

/** Spalte der allgemeinen Termine für alle Lehrkräfte */
const ALL_COLUMN = 'all';
/** IDs, die der Server als Spalte annimmt */
const COLUMN_ID = /^[A-Za-z0-9-]{1,64}$/;

export type BoardPublishResult = 'published' | 'unchanged' | 'noLink';

/** Termine eines Zeitraums für den Aushang, wie der Server sie liest (siehe server/internal/api/boards.go) */
interface BoardDraft {
  title: string;
  dates: string;
  color: string;
  from: string;
  to: string;
  columns: { id: string; name: string }[];
  days: { day: string; date: string; entries: BoardEntry[] }[];
}

interface BoardEntry {
  column: string;
  start: number;
  end: number;
  time: string;
  title: string;
  kind: 'single' | 'group' | 'shared';
  location?: string;
  teacher?: string;
  members?: string[];
  lane: number;
  lanes: number;
}

type Item = Omit<BoardEntry, 'lane' | 'lanes'> & { date: string; startMinutes: number; durationMinutes: number };

/**
 * Aushang eines Berichtszeitraums für ein zentrales Tablet: alle Einzel-, Gruppen- und allgemeinen Termine von heute
 * bis zum Ende des Zeitraums, je Lehrkraft eine Spalte. Personen stehen nur mit ihrem Kurznamen darin („Anna B.“),
 * Gruppenmitglieder ebenso; Stunden, Texte und alles andere bleiben in der App. Die App schickt den Aushang wie die
 * Pläne nach Änderungen an den Server (siehe `PlanPublisher`), der ihn unter dem Aushang-Link nur anzeigt.
 */
@Injectable({ providedIn: 'root' })
export class BoardPublisher {
  private readonly config = inject(ConfigStore).config;
  private readonly studentsStore = inject(StudentsStore);
  private readonly groupsStore = inject(GroupsStore);
  private readonly calendar = inject(CalendarStore);
  /** Was zuletzt je Zeitraum geschickt (oder mangels Link nicht gebraucht) wurde, als Prüfsumme */
  private readonly published = storedSignal<Record<string, string>>('feedback.publishedBoards', () => ({}), (data) =>
    data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, string>) : {},
  );

  /** Schickt den Aushang, wenn er sich seit dem letzten Mal geändert hat (`force`: auf jeden Fall). */
  async publish(login: ServerLogin, period: ReportPeriodEntry, force = false): Promise<BoardPublishResult> {
    const draft = JSON.stringify(this.draft(period));
    const fingerprint = checksum(`${login.url}|${draft}`);
    if (!force && this.published()[period.id] === fingerprint) return 'unchanged';
    let result: BoardPublishResult = 'published';
    try {
      await serverApi.putBoard(login, planServerId(period, login), draft);
    } catch (e) {
      if (!(e instanceof ServerError && e.status === 404)) throw e;
      result = 'noLink';
    }
    this.published.update((map) => ({ ...map, [period.id]: fingerprint }));
    return result;
  }

  private draft(period: ReportPeriodEntry): BoardDraft {
    const config = this.config();
    // Von heute (frühestens vom Beginn des Zeitraums) bis zu seinem Ende; Vergangenes braucht der Aushang nicht.
    const start = period.from > today() ? period.from : today();
    const from = start > period.to ? period.to : start;
    const columns = new Map<string, string>();
    const items = [...this.sharedItems(period, from, columns), ...this.lessonItems(period, from, columns)];
    const order = [ALL_COLUMN, ...periodTeachers(config, period).map((t) => t.id)];
    const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
    return {
      title: period.name,
      dates: `${formatShortDate(period.from)} – ${formatShortDate(period.to)}`,
      color: config.themeColor,
      from,
      to: period.to,
      columns: [...columns]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name, 'de')),
      days: daysBetween(from, period.to)
        .map((date) => ({ day: date, date: formatLongDate(date), entries: this.entriesOn(items, date) }))
        .filter((day) => day.entries.length > 0),
    };
  }

  /** Einträge eines Tages, je Spalte nebeneinander verteilt, wo sie sich überschneiden */
  private entriesOn(items: Item[], date: string): BoardEntry[] {
    const ofDay = items.filter((item) => item.date === date);
    const columns = [...new Set(ofDay.map((item) => item.column))];
    return columns.flatMap((column) =>
      withLanes(ofDay.filter((item) => item.column === column)).map(
        ({ date: _d, startMinutes: _s, durationMinutes: _m, ...entry }) => entry,
      ),
    );
  }

  /** Allgemeine Termine: für alle Lehrkräfte in einer eigenen Spalte, sonst in der Spalte jeder beteiligten */
  private sharedItems(period: ReportPeriodEntry, from: string, columns: Map<string, string>): Item[] {
    return this.calendar.sharedOccurrences(from, period.to).flatMap((occurrence) => {
      const { appointment } = occurrence;
      if (appointment.allTeachers) {
        columns.set(ALL_COLUMN, 'Für alle');
        return [this.sharedItem(occurrence, ALL_COLUMN)];
      }
      return this.teachersById(appointment.teacherIds)
        .filter((teacher) => this.addColumn(columns, teacher))
        .map((teacher) => this.sharedItem(occurrence, teacher.id));
    });
  }

  private sharedItem({ date, appointment }: SharedOccurrence, column: string): Item {
    const start = minutesOf(appointment.start);
    const duration = sharedSpanMinutes(appointment);
    return {
      date,
      column,
      start,
      end: Math.min(start + duration, 24 * 60),
      startMinutes: start,
      durationMinutes: duration,
      time: sharedTimeText(appointment),
      title: appointment.title.trim() || 'Termin',
      kind: 'shared',
      ...(appointment.location.trim() ? { location: appointment.location.trim() } : {}),
    };
  }

  /** Einzel- und Gruppentermine des Zeitraums, in der Spalte der Lehrkraft, in deren Kalender sie stehen */
  private lessonItems(period: ReportPeriodEntry, from: string, columns: Map<string, string>): Item[] {
    const students = this.studentsStore.allStudents().filter((s) => isActiveIn(s, period.id));
    const labels = planningLabels(students, shortName);
    const groups = new Map(this.groupsStore.allGroups().filter((g) => g.periodId === period.id).map((g) => [g.id, g]));
    return this.calendar
      .occurrences(from, period.to, (a) => (!!a.studentId || !!a.groupId) && this.groupsStore.appointmentPeriodId(a) === period.id)
      .flatMap((occurrence) => {
        const { appointment, date } = occurrence;
        const teacher = this.groupsStore.calendarTeacherOf(appointment);
        const group = appointment.groupId ? groups.get(appointment.groupId) : undefined;
        const title = group ? groupTitle(group) : labels.get(appointment.studentId ?? '');
        if (!title || !this.addColumn(columns, teacher)) return [];
        const location = this.groupsStore.appointmentLocation(appointment, date);
        return [{
          ...timeOf(occurrence),
          date,
          column: teacher.id,
          title,
          kind: group ? ('group' as const) : ('single' as const),
          teacher: teacher.name,
          ...(location ? { location } : {}),
          ...(group ? { members: memberLabels(group, labels) } : {}),
        }];
      });
  }

  private teachersById(ids: string[]): Teacher[] {
    return this.config().teachers.filter((teacher) => ids.includes(teacher.id));
  }

  /** Legt die Spalte der Lehrkraft an; `false`, wenn ihre ID keine Spalte sein kann */
  private addColumn(columns: Map<string, string>, teacher: Teacher): boolean {
    if (!COLUMN_ID.test(teacher.id)) return false;
    columns.set(teacher.id, teacher.name);
    return true;
  }
}

function timeOf({ appointment }: Occurrence): Pick<Item, 'start' | 'end' | 'startMinutes' | 'durationMinutes' | 'time'> {
  const start = startMinutes(appointment);
  const end = Math.min(start + appointment.durationMinutes, 24 * 60);
  return { start, end, startMinutes: start, durationMinutes: end - start, time: `${appointment.start}–${endTime(appointment)}` };
}

/** Benannte Gruppen mit Namen, sonst „Gruppe (3)“: Die Namen der Mitglieder stehen erst nach Antippen da. */
function groupTitle(group: Group): string {
  return group.name.trim() || `Gruppe (${group.memberIds.length})`;
}

function memberLabels(group: Group, labels: Map<string, string>): string[] {
  return group.memberIds
    .map((id) => labels.get(id))
    .filter((label): label is string => !!label)
    .sort((a, b) => a.localeCompare(b, 'de'));
}
