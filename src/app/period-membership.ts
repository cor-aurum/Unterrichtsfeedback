import { Appointment, lastDate, ownerOf } from './calendar/appointments';
import { containsDate, Group, Period, ReportPeriodEntry, Student } from './model';

type MembershipData = { students: Student[]; groups: Group[]; appointments: Appointment[] };

/**
 * Ältere Daten kennen noch keine Berichtszeiträume je Person und Gruppe. Eine Person gehört zu jedem schon
 * begonnenen Zeitraum, in dem sie Stunden oder Termine hat, eine Gruppe zum letzten solchen; ohne beides zum
 * Zeitraum von heute (sonst dem zuletzt begonnenen). Künftige Zeiträume bekommen niemanden automatisch: In sie
 * nimmt man Personen ausdrücklich auf, auch wenn eine Terminserie hineinreicht. Der Lehrer der Person bleibt in
 * allen ihren Zeiträumen der bisherige. `null`, wenn es nichts umzustellen gibt.
 */
export function withPeriodMembership(
  data: MembershipData,
  periods: ReportPeriodEntry[],
  today: string,
): { students: Student[]; groups: Group[] } | null {
  const legacyStudents = data.students.some((student) => student.legacyTeacherId !== undefined);
  const knownPeriods = new Set(periods.map((period) => period.id));
  const legacyGroups = data.groups.some((group) => !knownPeriods.has(group.periodId));
  if (!legacyStudents && !legacyGroups) return null;

  const started = startedPeriods(periods, today);
  const fallback = started.find((period) => containsDate(period, today)) ?? started.at(-1) ?? byStart(periods)[0];
  const periodsOf = (owner: Student | Group) => {
    const used = usedPeriods(owner, data.appointments, started);
    return used.length > 0 ? used : [fallback];
  };

  const students = data.students.map((student) => {
    if (student.legacyTeacherId === undefined) return student;
    const { legacyTeacherId, ...rest } = student;
    return { ...rest, periods: Object.fromEntries(periodsOf(student).map((period) => [period.id, legacyTeacherId])) };
  });
  const groups = data.groups.map((group) =>
    knownPeriods.has(group.periodId) ? group : { ...group, periodId: periodsOf(group).at(-1)!.id },
  );
  return { students, groups };
}

/** Begonnene Zeiträume, in denen Person oder Gruppe Stunden oder Termine hat, nach Beginn */
function usedPeriods(owner: Student | Group, appointments: Appointment[], started: ReportPeriodEntry[]): ReportPeriodEntry[] {
  const dates = owner.lessons.map((lesson) => lesson.date);
  const own = appointments.filter((appointment) => ownerOf(appointment) === owner.id);
  return started.filter(
    (period) => dates.some((date) => containsDate(period, date)) || own.some((a) => overlaps(a, period)),
  );
}

function startedPeriods(periods: ReportPeriodEntry[], today: string): ReportPeriodEntry[] {
  return byStart(periods).filter((period) => period.from <= today);
}

function byStart(periods: ReportPeriodEntry[]): ReportPeriodEntry[] {
  return [...periods].sort((a, b) => a.from.localeCompare(b.from));
}

function overlaps(appointment: Appointment, period: Period): boolean {
  return appointment.date <= period.to && lastDate(appointment) >= period.from;
}
