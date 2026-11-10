import { DestroyRef, effect, inject, Injectable } from '@angular/core';
import { addDays, minutesOf, startMinutes, timeOf } from '../calendar/appointments';
import { CalendarStore } from '../calendar/calendar.store';
import { CalendarEvent, toICalendar } from '../calendar/ical';
import { ConfigStore } from '../config.store';
import { GroupsStore } from '../groups.store';
import {
  FeedbackConfig,
  formatLongDate,
  formatShortDate,
  Group,
  isActiveIn,
  locationIn,
  ReportPeriodEntry,
  Student,
  Teacher,
  today,
} from '../model';
import { PersonalPlan, personalPlanPdfs, ScheduleDay } from '../pdf-export';
import { planningLabels, shortName } from '../planning/planning-labels';
import { demoMode, storedSignal } from '../stored-signal';
import { planServerId, realServerLogin } from './plan-access';
import { appointmentTeacher, isOpenSingle, isSpontaneous } from './plan-slots';
import { PlanRequests } from './plan-requests';
import { StudentsStore } from '../students.store';
import { checksum } from '../sync/checksum';
import { ServerError, ServerLogin, serverApi } from '../sync/server-folder';

/** So lange nach dem Ende des Zeitraums gilt der Download-Link noch (wie auf dem Server). */
export const PLAN_DAYS_AFTER_PERIOD = 14;
/** Wartezeit nach einer Änderung, damit z. B. beim Eintragen am Tablet nicht jede Buchung alle PDFs neu erzeugt */
const PUBLISH_DELAY_MS = 15_000;
/** Im Demomodus: so oft nach angenommenen Anfragen sehen (sonst nach jedem Abgleich) */
const DEMO_POLL_MS = 20_000;
/** Vorschlag an Kalender-Apps, die den Plan abonniert haben */
const REFRESH_HOURS = 1;

/** Ergebnis beim Hochladen: `noLink`, wenn es für den Zeitraum (noch) keinen Download-Link gibt */
export type PublishResult = 'published' | 'unchanged' | 'noLink';

interface PlanEvent extends CalendarEvent {
  date: string;
  time: string;
  title: string;
  startMinutes: number;
  durationMinutes: number;
  /** Termin und Lehrkraft, für Tausch und Dazukommen auf der Download-Seite; fehlen bei allgemeinen Terminen */
  slot?: string;
  teacher?: string;
  swap?: boolean;
  join?: boolean;
}

/** Plan einer Person, noch ohne PDF und Kalenderdatei */
interface PersonDraft {
  id: string;
  label: string;
  events: PlanEvent[];
}

interface PlansDraft {
  title: string;
  dates: string;
  color: string;
  people: PersonDraft[];
}

/**
 * Pläne für den Download-Link eines Berichtszeitraums: je Person ihre Einzel- und Gruppentermine und die allgemeinen
 * Termine für alle Lehrer:innen als Liste, PDF und Kalenderdatei, unter dem Kurznamen wie beim Eintragen. Die App
 * erzeugt sie und schickt sie dem Server, sobald sich etwas geändert hat; der Server zeigt sie unter dem Link nur an.
 */
@Injectable({ providedIn: 'root' })
export class PlanPublisher {
  private readonly config = inject(ConfigStore).config;
  private readonly studentsStore = inject(StudentsStore);
  private readonly groupsStore = inject(GroupsStore);
  private readonly calendar = inject(CalendarStore);
  private readonly requests = inject(PlanRequests);
  /** Was zuletzt je Zeitraum geschickt (oder mangels Link nicht gebraucht) wurde, als Prüfsumme */
  private readonly published = storedSignal<Record<string, string>>('feedback.publishedPlans', () => ({}), (data) =>
    data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, string>) : {},
  );
  private timer?: ReturnType<typeof setTimeout>;
  private running: Promise<void> | null = null;

  constructor() {
    if (demoMode) this.publishInDemo();
  }

  /**
   * Im Demomodus läuft kein Abgleich, der die Pläne anstößt. Mit echter Anmeldung gehen sie nach Änderungen an den
   * Demo-Link, und angenommene Anfragen werden regelmäßig übernommen.
   */
  private publishInDemo(): void {
    const login = realServerLogin();
    if (!login) return;
    effect(() => {
      // Abhängigkeiten: alles, was in den Plänen steht
      this.calendar.appointments();
      this.calendar.sharedAppointments();
      this.groupsStore.allGroups();
      this.studentsStore.allStudents();
      this.config();
      this.schedule(login);
    });
    const poll = setInterval(() => this.schedule(login), DEMO_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(poll));
  }

  /**
   * Nach jedem Abgleich: Haben sich die Pläne eines laufenden Zeitraums geändert, gehen sie kurz darauf an den Server.
   * Läuft nicht im Abgleich selbst, denn viele PDFs dauern auf einem Tablet einige Sekunden.
   */
  schedule(login: ServerLogin | null): void {
    // Ein wartender Durchlauf bleibt: Bei häufigen Abgleichen käme er sonst nie an die Reihe.
    if (!login || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.publishAll(login);
    }, PUBLISH_DELAY_MS);
  }

  private async publishAll(login: ServerLogin): Promise<void> {
    if (this.running) {
      // Läuft noch: danach erneut prüfen
      this.schedule(login);
      return;
    }
    this.running = (async () => {
      for (const period of this.periodsOf(login)) {
        // Erst Tausch und Dazukommen übernehmen, dann gehen die geänderten Pläne gleich mit.
        try {
          await this.requests.apply(login, period);
        } catch (e) {
          console.warn(`Anfragen für ${period.name} nicht übernommen`, e);
        }
        try {
          await this.publish(login, period);
        } catch (e) {
          console.warn(`Pläne für ${period.name} nicht gesendet`, e);
        }
      }
    })();
    await this.running;
    this.running = null;
  }

  /** Eigene Zeiträume, deren Link noch gelten kann; im Demomodus der Demolehrgang */
  private periodsOf(login: ServerLogin): ReportPeriodEntry[] {
    const day = today();
    return this.config().reportPeriods.filter(
      (p) =>
        !p.placeholder &&
        (demoMode || p.teacherIds.includes(login.teacherId)) &&
        addDays(p.to, PLAN_DAYS_AFTER_PERIOD) >= day,
    );
  }

  /** Schickt die Pläne des Zeitraums, wenn sie sich seit dem letzten Mal geändert haben (`force`: auf jeden Fall). */
  async publish(login: ServerLogin, period: ReportPeriodEntry, force = false): Promise<PublishResult> {
    const draft = this.draft(period);
    const fingerprint = checksum(`${login.url}|${JSON.stringify(draft)}`);
    if (!force && this.published()[period.id] === fingerprint) return 'unchanged';
    let result: PublishResult = 'published';
    try {
      await serverApi.putPlan(login, planServerId(period, login), await this.render(draft, period));
    } catch (e) {
      if (!(e instanceof ServerError && e.status === 404)) throw e;
      result = 'noLink';
    }
    this.published.update((map) => ({ ...map, [period.id]: fingerprint }));
    return result;
  }

  private draft(period: ReportPeriodEntry): PlansDraft {
    const config = this.config();
    const students = this.studentsStore.allStudents().filter((s) => isActiveIn(s, period.id));
    const labels = planningLabels(students, shortName);
    const groups = this.groupsStore.allGroups().filter((g) => g.periodId === period.id);
    const shared = this.sharedEvents(period);
    const people = students
      .map((student) => ({
        id: student.id,
        label: labels.get(student.id) ?? student.name,
        events: [...this.lessonEvents(student, groups, labels, period, config), ...shared].sort(byTime),
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'de'));
    return {
      title: period.name,
      dates: `${formatShortDate(period.from)} – ${formatShortDate(period.to)}`,
      color: config.themeColor,
      people,
    };
  }

  /**
   * Einzel- und Gruppentermine der Person im Zeitraum. Einzelne künftige Einzeltermine lassen sich auf der
   * Download-Seite tauschen; zu ihnen und zu spontanen Gruppen kann man dort dazukommen.
   */
  private lessonEvents(
    student: Student,
    groups: Group[],
    labels: Map<string, string>,
    period: ReportPeriodEntry,
    config: FeedbackConfig,
  ): PlanEvent[] {
    const own = new Map(groups.filter((g) => g.memberIds.includes(student.id)).map((g) => [g.id, g]));
    return this.calendar
      .occurrences(period.from, period.to, (a) => a.studentId === student.id || (!!a.groupId && own.has(a.groupId)))
      .map(({ date, appointment }) => {
        const group = appointment.groupId ? own.get(appointment.groupId) : undefined;
        const teacher = appointmentTeacher(appointment.teacherId, group, student, config, period.id);
        const event = planEvent(
          appointment.id,
          date,
          startMinutes(appointment),
          appointment.durationMinutes,
          lessonTitle(student, group, labels, teacher),
          locationIn(teacher, period.id),
        );
        const single = isOpenSingle(appointment);
        const swap = single && appointment.studentId === student.id;
        const join = swap || (single && !!group && isSpontaneous(group));
        return { ...event, slot: appointment.id, teacher: teacher.id, swap, join };
      });
  }

  /**
   * Allgemeine Termine für alle Lehrer:innen des Zeitraums, z. B. Mahlzeiten; sie stehen in jedem Plan. Termine nur
   * einzelner Lehrkräfte (z. B. Konferenzen) bleiben draußen.
   */
  private sharedEvents(period: ReportPeriodEntry): PlanEvent[] {
    return this.calendar
      .sharedOccurrences(period.from, period.to)
      .filter(({ appointment }) => appointment.allTeachers && appointment.teacherIds.length > 0)
      .map(({ date, appointment }) =>
        planEvent(appointment.id, date, minutesOf(appointment.start), appointment.durationMinutes, appointment.title, appointment.location),
      );
  }

  /** Fertige Pläne für den Server: Termine je Tag, PDF (Base64) und Kalenderdatei je Person */
  private async render(draft: PlansDraft, period: ReportPeriodEntry): Promise<string> {
    const range = { from: period.from, to: period.to, label: `${draft.title} · ${draft.dates}` };
    const plans: PersonalPlan[] = draft.people.map((person) => ({ title: person.label, days: scheduleDays(person.events) }));
    const pdfs = await personalPlanPdfs(this.config(), plans, range);
    const people = await Promise.all(
      draft.people.map(async (person, index) => ({
        id: person.id,
        label: person.label,
        days: scheduleDays(person.events).map((day) => ({
          day: day.date,
          date: formatLongDate(day.date),
          entries: person.events
            .filter((e) => e.date === day.date)
            .map((e) => ({
              time: e.time,
              title: e.title,
              location: e.location ?? '',
              slot: e.slot,
              teacher: e.teacher,
              swap: e.swap,
              join: e.join,
            })),
        })),
        ics: toICalendar(`${draft.title}: ${person.label}`, person.events, new Date(), { refreshHours: REFRESH_HOURS }),
        pdf: await toBase64(pdfs[index]),
      })),
    );
    return JSON.stringify({ title: draft.title, dates: draft.dates, color: draft.color, people });
  }
}

/** „Unterricht bei …“; Gruppen ohne Namen nennen die anderen Mitglieder, z. B. „Unterricht mit Ben L. bei …“ */
function lessonTitle(student: Student, group: Group | undefined, labels: Map<string, string>, teacher: Teacher): string {
  if (!group) return `Unterricht bei ${teacher.name}`;
  if (group.name.trim()) return `Gruppe ${group.name.trim()} bei ${teacher.name}`;
  const others = group.memberIds.filter((id) => id !== student.id).map((id) => labels.get(id)).filter(Boolean);
  return others.length ? `Unterricht mit ${others.join(', ')} bei ${teacher.name}` : `Gruppenunterricht bei ${teacher.name}`;
}

/** Termin für Plan und Kalender; bis Mitternacht endet er um 24:00, nicht um 0:00 desselben Tages. */
function planEvent(id: string, date: string, begin: number, duration: number, title: string, location: string): PlanEvent {
  const end = Math.min(begin + duration, 24 * 60);
  const endTime = end === 24 * 60 ? '24:00' : timeOf(end);
  return {
    uid: `plan-${id}-${date}@unterrichtsfeedback`,
    date,
    start: `${date}T${timeOf(begin)}`,
    end: `${date}T${endTime}`,
    time: `${timeOf(begin)}–${endTime}`,
    title,
    summary: title,
    location: location.trim() || undefined,
    startMinutes: begin,
    durationMinutes: end - begin,
  };
}

function byTime(a: PlanEvent, b: PlanEvent): number {
  return a.date.localeCompare(b.date) || a.startMinutes - b.startMinutes;
}

/** Termine nach Tagen, wie die Terminliste im PDF sie braucht */
function scheduleDays(events: PlanEvent[]): ScheduleDay[] {
  const days: ScheduleDay[] = [];
  for (const event of events) {
    let day = days.at(-1);
    if (day?.date !== event.date) days.push((day = { date: event.date, entries: [] }));
    day.entries.push({
      time: event.time,
      name: event.location ? `${event.title} · ${event.location}` : event.title,
      startMinutes: event.startMinutes,
      durationMinutes: event.durationMinutes,
    });
  }
  return days;
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
