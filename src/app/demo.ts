import { addDays, Appointment, daysFrom } from './calendar/appointments';
import { SharedAppointment } from './calendar/shared-appointments';
import { defaultConfig } from './config.store';
import { autoGroupId, autoGroupMembers, autoGroupName } from './groups/auto-groups';
import { FeedbackConfig, Group, Instrument, ReportPeriodEntry, Student, Teacher, TeachingWindow, today } from './model';
import { DEMO_FLAG, DEMO_PREFIX } from './stored-signal';
import { deleteDemoPlanLink } from './plans/plan-access';

/** Wer die Demo startet, ist darin selbst eine der Lehrkräfte. */
export interface DemoSelf {
  name: string;
  instrument: string;
}

export const DEMO_PERIOD_ID = 'demo-lehrgang';
const PERIOD_ID = DEMO_PERIOD_ID;
/** Daten mit Terminen und Stunden; sie wandern mit, wenn der Lehrgang früher beginnt. */
const DATED_KEYS = ['feedback.students', 'feedback.groups', 'feedback.appointments', 'feedback.blockers', 'feedback.sharedAppointments'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Unterrichtszeiten des Lehrgangs: vormittags, nachmittags und abends nach dem Abendessen */
const WINDOWS = [
  ['08:30', '12:30'],
  ['14:00', '18:00'],
  ['19:00', '21:00'],
];
/** Mahlzeiten als allgemeine Termine für alle Lehrkräfte, jeden Tag */
const MEALS: [string, string, number][] = [
  ['Frühstück', '07:30', 60],
  ['Mittagessen', '12:30', 60],
  ['Abendessen', '18:00', 60],
];
/** Gruppenunterricht jeder Lehrkraft mit allen ihren Personen, jeden Tag direkt nach dem Frühstück */
const GROUP_LESSON: [string, number] = ['08:30', 60];
const OTHER_TEACHERS: [string, string][] = [
  ['Clara Brandt', 'Klavier'],
  ['Jonas Feld', 'Gitarre'],
  ['Miriam Ostrowski', 'Querflöte'],
  ['Paul Lindner', 'Cello'],
];
const FIRST_NAMES = [
  'Anna', 'Ben', 'Clara', 'David', 'Ella', 'Finn', 'Greta', 'Hannes', 'Ida', 'Jakob',
  'Klara', 'Leon', 'Mia', 'Noah', 'Olivia', 'Paul', 'Quentin', 'Romy', 'Samuel', 'Tilda',
];
const LAST_NAMES = ['Becker', 'Hartmann', 'Keller', 'Lorenz', 'Möller', 'Neumann', 'Schubert', 'Vogel'];

/**
 * Startet den Demomodus mit frischen Beispieldaten: ein einwöchiger Lehrgang ab heute in einer Woche, fünf
 * Lehrkräfte (darunter man selbst), 40 Personen ohne Einzeltermine bei zwei von ihnen, die Mahlzeiten als allgemeine
 * Termine und je Lehrkraft ihre automatische Gruppe mit einem täglichen Termin nach dem Frühstück. Die echten Daten bleiben unberührt; die App lädt neu.
 */
export async function startDemo(self: DemoSelf): Promise<void> {
  // Ein Demo-Link von einer früheren Demo, die nicht über „Demo beenden“ verlassen wurde
  await deleteDemoPlanLink();
  clearDemoData();
  for (const [key, value] of Object.entries(demoData(self))) {
    localStorage.setItem(DEMO_PREFIX + key, JSON.stringify(value));
  }
  localStorage.setItem(DEMO_FLAG, '1');
  location.hash = '#/kalender';
  location.reload();
}

/**
 * Lässt den Demolehrgang heute beginnen. Alles, was schon geplant ist – Termine, Blocker, allgemeine Termine,
 * Stunden –, wandert um dieselbe Zahl Tage mit; Geburtsdaten bleiben. Die App lädt neu.
 */
export function startDemoPeriodToday(): void {
  const configKey = DEMO_PREFIX + 'feedback.config';
  const config = JSON.parse(localStorage.getItem(configKey) ?? 'null') as FeedbackConfig | null;
  const period = config?.reportPeriods.find((p) => p.id === PERIOD_ID);
  if (!config || !period) return;
  const offset = daysFrom(period.from, today());
  if (offset === 0) return;
  period.from = addDays(period.from, offset);
  period.to = addDays(period.to, offset);
  localStorage.setItem(configKey, JSON.stringify(config));
  for (const key of DATED_KEYS.map((k) => DEMO_PREFIX + k)) {
    const stored = localStorage.getItem(key);
    if (stored !== null) localStorage.setItem(key, JSON.stringify(shiftDates(JSON.parse(stored), offset)));
  }
  location.reload();
}

/** Verschiebt jedes Datum (JJJJ-MM-TT) um `days` Tage, außer Geburtsdaten */
function shiftDates(value: unknown, days: number): unknown {
  if (typeof value === 'string') return ISO_DATE.test(value) ? addDays(value, days) : value;
  if (Array.isArray(value)) return value.map((item) => shiftDates(item, days));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, key === 'birthDate' ? item : shiftDates(item, days)]),
    );
  }
  return value;
}

/** Beendet den Demomodus; alles, was darin geändert wurde, ist danach weg. */
export async function endDemo(): Promise<void> {
  await deleteDemoPlanLink();
  clearDemoData();
  localStorage.removeItem(DEMO_FLAG);
  location.hash = '#/hilfe';
  location.reload();
}

function clearDemoData(): void {
  for (const key of Object.keys(localStorage).filter((k) => k.startsWith(DEMO_PREFIX))) {
    localStorage.removeItem(key);
  }
}

/** Die gespeicherten Werte der Demo, je Schlüssel wie in `storedSignal` */
function demoData(self: DemoSelf): Record<string, unknown> {
  const config = defaultConfig();
  const from = addDays(today(), 7);
  const instruments = instrumentsFor([self.instrument, ...OTHER_TEACHERS.map(([, instrument]) => instrument)]);
  const instrumentId = (name: string) => instruments.find((i) => i.name === name)!.id;
  const teacher = (id: string, name: string, instrument: string): Teacher => ({
    id,
    name,
    instrumentId: instrumentId(instrument),
    location: '',
    teachingWindows: config.teachers[0].teachingWindows,
    periodWindows: {},
    periodLocations: {},
  });
  const me = teacher('demo-ich', self.name, self.instrument);
  const teachers = [me, ...OTHER_TEACHERS.map(([name, instrument], i) => teacher(`demo-lehrkraft-${i + 1}`, name, instrument))];
  const period: ReportPeriodEntry = {
    id: PERIOD_ID,
    name: 'Demolehrgang',
    from,
    to: addDays(from, 6),
    teacherIds: teachers.map((t) => t.id),
    sharedWindows: [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) =>
      WINDOWS.map(([start, end]): TeachingWindow => ({ id: `demo-zeit-${weekday}-${start}`, weekday, from: start, to: end })),
    ),
  };
  const demoConfig: FeedbackConfig = {
    ...config,
    teachers,
    instruments,
    defaultInstrumentId: instrumentId(self.instrument),
    reportPeriods: [period],
  };
  // Die Personen verteilen sich auf die eigene Lehrkraft und die erste andere.
  const students = Array.from({ length: 40 }, (_, i) => demoStudent(i, i % 2 === 0 ? me : teachers[1]));
  const sharedAppointments: SharedAppointment[] = MEALS.map(([title, start, durationMinutes], i) => ({
    id: `demo-mahlzeit-${i + 1}`,
    title,
    date: from,
    start,
    durationMinutes,
    repeat: { everyDays: 1, count: 7 },
    location: 'Speisesaal',
    teacherIds: [],
    allTeachers: true,
    blocksPlanning: true,
  }));
  // Die automatischen Gruppen der Lehrkräfte (die App führt sie ohnehin nach) mit ihrem täglichen Termin
  const groups: Group[] = teachers.map((t) => ({
    id: autoGroupId(PERIOD_ID, t.id),
    name: autoGroupName(t.name),
    memberIds: autoGroupMembers(students, demoConfig, PERIOD_ID, t.id),
    teacherId: t.id,
    periodId: PERIOD_ID,
    lessons: [],
    generalTexts: {},
    auto: true,
  }));
  const [groupStart, groupMinutes] = GROUP_LESSON;
  const appointments: Appointment[] = groups.map((group, i) => ({
    id: `demo-gruppentermin-${i + 1}`,
    groupId: group.id,
    date: from,
    start: groupStart,
    durationMinutes: groupMinutes,
    repeat: { everyDays: 1, count: 7 },
  }));
  return {
    'feedback.config': demoConfig,
    'feedback.setupPending': false,
    'feedback.students': students,
    'feedback.groups': groups,
    'feedback.appointments': appointments,
    'feedback.blockers': [],
    'feedback.sharedAppointments': sharedAppointments,
    'feedback.activeTeacher': me.id,
    'feedback.reportPeriodId': PERIOD_ID,
  };
}

function instrumentsFor(names: string[]): Instrument[] {
  return [...new Set(names)].map((name, i) => ({ id: `demo-instrument-${i + 1}`, name }));
}

/** Namen, Geburtsdaten (8 bis 17 Jahre) und Instrumente reihum, damit jede Demo gleich aussieht */
function demoStudent(index: number, teacher: Teacher): Student {
  const year = new Date().getFullYear() - 8 - (index % 10);
  const month = String((index % 12) + 1).padStart(2, '0');
  const day = String(((index * 7) % 28) + 1).padStart(2, '0');
  return {
    id: `demo-person-${index + 1}`,
    name: `${FIRST_NAMES[index % FIRST_NAMES.length]} ${LAST_NAMES[(index * 3) % LAST_NAMES.length]}`,
    birthDate: `${year}-${month}-${day}`,
    instrumentId: teacher.instrumentId,
    periods: { [PERIOD_ID]: teacher.id },
    generalTexts: {},
    lessons: [],
  };
}
