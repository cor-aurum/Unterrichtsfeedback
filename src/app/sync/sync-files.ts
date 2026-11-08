import { Appointment, lastDate, ownerOf as appointmentOwner, parseAppointments } from '../calendar/appointments';
import { Blocker, parseBlockers } from '../calendar/blockers';
import { parseSharedAppointments, SharedAppointment } from '../calendar/shared-appointments';
import { parseConfig } from '../config.store';
import { parseGroups } from '../groups.store';
import {
  BlockVariant,
  containsDate,
  FeedbackConfig,
  FixedBlock,
  Group,
  groupTeacherOf,
  ReportPeriodEntry,
  Section,
  Student,
  Teacher,
  TeachingWindow,
  teacherOf,
} from '../model';
import { safeFileName } from '../save-file';
import { parseStudents } from '../students.store';

/** Alles, was die App speichert und sichert */
export interface AppData {
  config: FeedbackConfig;
  students: Student[];
  groups: Group[];
  appointments: Appointment[];
  blockers: Blocker[];
  sharedAppointments: SharedAppointment[];
}

/** Dateiname → JSON-Inhalt */
export type SyncFiles = Map<string, string>;

/** Gemeinsame Konfiguration: Überschrift, Farbe, Abschnitte, Instrumente, feste Inhalte … */
export const GENERAL_FILE = 'konfiguration.json';
/** Gruppen in älteren Sicherungen; heute stehen sie in der Datei ihres Zeitraums und Lehrers. */
export const GROUPS_FILE = 'gruppen.json';
/** Termine für mehrere Lehrer außerhalb der Berichtszeiträume; die in einem Zeitraum stehen in dessen Datei. */
export const SHARED_FILE = 'allgemeine-termine.json';
// Nur Zeichen, die `safeFileName` erzeugt; so zählen Konfliktkopien der Nextcloud wie
// „lehrer-Anna (conflicted copy 2026-…).json“ nicht als Lehrerdatei.
const TEACHER_FILE = /^lehrer-[\p{L}\p{N}_-]+\.json$/u;
// „zeitraum-<Name>-<Lehrer>.json“ in Sicherungen, „zeitraum_<Zeitraum-ID>_<Lehrer-ID>.json“ auf dem Server
const PERIOD_FILE = /^zeitraum[-_][\p{L}\p{N}_-]*\.json$/u;
// „berichtszeitraum-<Name>.json“ in Sicherungen, „berichtszeitraum_<Zeitraum-ID>.json“ auf dem Server
const REPORT_FILE = /^berichtszeitraum[-_][\p{L}\p{N}_-]*\.json$/u;

/**
 * Wie die Dateien heißen: in Sicherungen lesbar nach Lehrer und Zeitraum, auf dem Server nach den IDs. Der Server
 * liest daraus, zu welchem Zeitraum eine Datei gehört, und Umbenennen ändert dort keinen Dateinamen.
 */
export type FileNaming = 'readable' | 'ids';

interface GeneralFile {
  format: 'unterricht-feedback/konfiguration';
  version: 1;
  /**
   * Ohne Lehrer, ohne Varianten, die nur für einen Lehrer gelten, und ohne Berichtszeiträume (eigene Dateien).
   * Ältere Dateien enthalten die Berichtszeiträume noch.
   */
  config: Omit<FeedbackConfig, 'reportPeriods'> & { reportPeriods?: ReportPeriodEntry[] };
  /** Nur in der Sicherung eines Berichtszeitraums: dessen ID */
  period?: string;
}

/**
 * Was zu einem Lehrer gehört, unabhängig vom Zeitraum. Fehlt die Datei, funktionieren die anderen Lehrer weiter.
 * Ältere Dateien (ohne Zeiträume je Person) enthalten auch die Personen und Termine des Lehrers.
 */
/** Eigener Abschnitt oder fester Inhalt eines Lehrers mit seiner Stelle in der Liste aller */
type OwnEntry =
  | { list: 'sections' | 'groupSections'; index: number; entry: Section }
  | { list: 'blocks' | 'groupBlocks'; index: number; entry: FixedBlock };

const OWN_LISTS = ['sections', 'groupSections', 'blocks', 'groupBlocks'] as const;

interface TeacherFile {
  format: 'unterricht-feedback/lehrer';
  version: 1;
  /** Stelle des Lehrers in der Liste */
  position: number;
  teacher: Teacher;
  variants: TeacherVariant[];
  /** Eigene Abschnitte und feste Inhalte des Lehrers; fehlt in älteren Dateien */
  own?: OwnEntry[];
  /** Fehlt in älteren Dateien */
  blockers: Blocker[];
  /** Nur in älteren Dateien */
  students?: unknown[];
  /** Nur in älteren Dateien */
  appointments?: Appointment[];
}

/**
 * Personen, Gruppen und Termine eines Lehrers in einem Berichtszeitraum. Eine Person in mehreren Zeiträumen steht
 * in mehreren Dateien, jeweils mit den Stunden dieses Zeitraums. Weil jede Datei nur einem Lehrer gehört, stören
 * sich mehrere Lehrer bei der Synchronisation nicht.
 */
interface PeriodFile {
  format: 'unterricht-feedback/zeitraum';
  version: 1;
  /** Leer für Personen und Gruppen ohne bekannten Zeitraum */
  periodId: string;
  teacherId: string;
  /** Zeitraum und Lehrer der Personen ergeben sich aus der Datei. */
  students: Omit<Student, 'periods' | 'legacyTeacherId'>[];
  groups: Group[];
  appointments: Appointment[];
}

/**
 * Ein Berichtszeitraum mit allem, was nur seine Lehrer sehen sollen: Name, Daten, Lehrer, gemeinsame
 * Unterrichtszeiten, die Unterrichtszeiten und Orte der Lehrer in diesem Zeitraum und seine allgemeinen Termine.
 * Auf dem Server lesen sie nur die eingetragenen Lehrer; die anderen erfahren nur, dass es ihn gibt.
 */
interface ReportFile {
  format: 'unterricht-feedback/berichtszeitraum';
  version: 1;
  period: ReportPeriodEntry;
  /** Lehrer-ID → Unterrichtszeiten und Ort in diesem Zeitraum (nur, wenn sie eigene haben) */
  teachers: Record<string, { windows?: TeachingWindow[]; location?: string }>;
  sharedAppointments: SharedAppointment[];
}

interface GroupsFile {
  format: 'unterricht-feedback/gruppen';
  version: 1;
  groups: Group[];
}

interface SharedFile {
  format: 'unterricht-feedback/allgemeine-termine';
  version: 1;
  appointments: SharedAppointment[];
}

/** Variante eines festen Blocks; `index` ist ihre Stelle unter den Varianten, weil die erste passende gilt. */
interface TeacherVariant {
  /** Fehlt in älteren Dateien: `blocks` */
  list?: 'blocks' | 'groupBlocks';
  blockId: string;
  index: number;
  variant: BlockVariant;
}

export function isSyncFile(name: string): boolean {
  return (
    name === GENERAL_FILE ||
    name === GROUPS_FILE ||
    name === SHARED_FILE ||
    TEACHER_FILE.test(name) ||
    PERIOD_FILE.test(name) ||
    REPORT_FILE.test(name)
  );
}

export function isTeacherFile(name: string): boolean {
  return TEACHER_FILE.test(name);
}

export function toSyncFiles(data: AppData, naming: FileNaming = 'readable'): SyncFiles {
  const { config } = data;
  const files: SyncFiles = new Map();
  files.set(GENERAL_FILE, json(generalFile(config)));
  // Vorläufige Zeiträume (siehe `ReportPeriodEntry.placeholder`) gehen nicht auf den Server.
  const periods = config.reportPeriods.filter((period) => !(naming === 'ids' && period.placeholder));
  const sharedByPeriod = groupSharedByPeriod(data.sharedAppointments, periods);
  files.set(SHARED_FILE, json(sharedFile(sharedByPeriod.get('') ?? [])));
  const reportNames = reportFileNames(periods, naming);
  for (const period of periods) {
    files.set(reportNames.get(period.id)!, json(reportFile(config, period, sharedByPeriod.get(period.id) ?? [])));
  }
  const fileNames = teacherFileNames(config.teachers, naming);
  config.teachers.forEach((teacher, position) =>
    files.set(fileNames.get(teacher.id)!, json(teacherFile(data, teacher, position))),
  );
  for (const { name, file } of periodFiles(data, naming)) files.set(name, json(file));
  return files;
}

/**
 * Allgemeine Termine je Berichtszeitraum (Schlüssel: ID; leer: in keinem): der Zeitraum, in dem der (erste) Tag liegt,
 * bei mehreren der, dessen Lehrer beteiligt sind. So regelt es auch der Server beim Umstellen älterer Daten.
 */
function groupSharedByPeriod(appointments: SharedAppointment[], periods: ReportPeriodEntry[]): Map<string, SharedAppointment[]> {
  const result = new Map<string, SharedAppointment[]>();
  for (const appointment of appointments) {
    const containing = periods.filter((period) => containsDate(period, appointment.date));
    const period =
      containing.find((p) => p.teacherIds.some((id) => appointment.teacherIds.includes(id))) ?? containing[0];
    const key = period?.id ?? '';
    result.set(key, [...(result.get(key) ?? []), appointment]);
  }
  return result;
}

function reportFile(config: FeedbackConfig, period: ReportPeriodEntry, shared: SharedAppointment[]): ReportFile {
  const teachers: ReportFile['teachers'] = {};
  for (const teacher of config.teachers) {
    const windows = teacher.periodWindows[period.id];
    const hasLocation = Object.hasOwn(teacher.periodLocations, period.id);
    if (!windows && !hasLocation) continue;
    teachers[teacher.id] = {
      ...(windows ? { windows } : {}),
      ...(hasLocation ? { location: teacher.periodLocations[period.id] } : {}),
    };
  }
  const { placeholder: _p, ...entry } = period;
  return { format: 'unterricht-feedback/berichtszeitraum', version: 1, period: entry, teachers, sharedAppointments: shared };
}

/** Lesbar nach dem Namen des Zeitraums, auf dem Server „berichtszeitraum_<ID>.json“ */
function reportFileNames(periods: ReportPeriodEntry[], naming: FileNaming): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const period of periods) {
    if (naming === 'ids') {
      names.set(period.id, `berichtszeitraum_${period.id}.json`);
      continue;
    }
    let name = `berichtszeitraum-${safeFileName(period.name)}.json`;
    if (used.has(name)) name = `berichtszeitraum-${safeFileName(period.name)}-${period.id.slice(0, 8)}.json`;
    used.add(name);
    names.set(period.id, name);
  }
  return names;
}

/**
 * Sicherung eines Berichtszeitraums, z. B. für einen Lehrer, der neu dazukommt: Konfiguration und Lehrer wie in der
 * vollen Sicherung, Personen, Gruppen, Termine und allgemeine Termine nur aus diesem Zeitraum.
 */
export function toPeriodBackupFiles(data: AppData, periodId: string): SyncFiles {
  const period = data.config.reportPeriods.find((p) => p.id === periodId);
  if (!period) throw new Error('Diesen Berichtszeitraum gibt es nicht.');
  const files = toSyncFiles(data);
  const general: GeneralFile = { ...generalFile(data.config), period: periodId };
  files.set(GENERAL_FILE, json(general));
  const shared = data.sharedAppointments.filter((a) => a.date <= period.to && lastDate(a) >= period.from);
  files.set(SHARED_FILE, json(sharedFile(shared.filter((a) => !containsDate(period, a.date)))));
  const otherPeriods = new Set(periodFiles(data).filter((entry) => entry.file.periodId !== periodId).map((e) => e.name));
  for (const name of otherPeriods) files.delete(name);
  const reportNames = reportFileNames(data.config.reportPeriods, 'readable');
  for (const other of data.config.reportPeriods) {
    if (other.id !== periodId) files.delete(reportNames.get(other.id)!);
  }
  return files;
}

/** Zeitraum einer Sicherung, die nur einen Berichtszeitraum enthält; sonst `null` */
export function backupPeriodOf(files: SyncFiles): string | null {
  const content = files.get(GENERAL_FILE);
  const general = content ? (JSON.parse(content) as Partial<GeneralFile>) : null;
  return typeof general?.period === 'string' ? general.period : null;
}

/**
 * Setzt die Daten aus der allgemeinen Datei und beliebig vielen Lehrerdateien wieder zusammen.
 * Wirft einen Fehler, wenn die allgemeine Datei fehlt oder eine Datei kein gültiges Format hat.
 */
export function fromSyncFiles(files: SyncFiles): AppData {
  const generalJson = files.get(GENERAL_FILE);
  if (!generalJson) {
    throw new Error(
      `Die Datei „${GENERAL_FILE}“ fehlt. Ist der Ordner vollständig? Bei einem Ordner der Nextcloud-App hilft es, ` +
        'ihn dort einmal zu öffnen, damit die App ihn aktualisiert, oder die Synchronisation direkt per WebDAV.',
    );
  }
  const general = JSON.parse(generalJson) as Partial<GeneralFile>;
  if (general?.format !== 'unterricht-feedback/konfiguration') {
    throw new Error(`„${GENERAL_FILE}“ ist keine Konfiguration dieser App.`);
  }
  const teacherFiles = [...files]
    .filter(([name]) => isTeacherFile(name))
    .map(([name, content]) => parseTeacherFile(name, content))
    .sort((a, b) => a.position - b.position);
  const reportFiles = [...files].filter(([name]) => REPORT_FILE.test(name)).map(([name, content]) => parseReportFile(name, content));

  const config = parseConfig(
    withOwnEntries(
      {
        ...general.config,
        // Ältere Dateien haben die Zeiträume noch in der Konfiguration.
        reportPeriods: reportFiles.length > 0 ? reportFiles.map((file) => file.period) : general.config!.reportPeriods,
        teachers: teacherFiles.map((file) => withReportData(file.teacher, reportFiles)),
        blocks: withTeacherVariants(general.config!.blocks ?? [], teacherFiles, 'blocks'),
        ...(general.config!.groupBlocks
          ? { groupBlocks: withTeacherVariants(general.config!.groupBlocks, teacherFiles, 'groupBlocks') }
          : {}),
      },
      teacherFiles,
    ),
  );
  const periodFiles = [...files]
    .filter(([name]) => PERIOD_FILE.test(name))
    .map(([name, content]) => parsePeriodFile(name, content));
  return {
    config,
    students: parseStudents([
      ...mergedStudents(periodFiles, config.reportPeriods),
      // Ältere Lehrerdateien: Die Zeiträume ergänzt `withPeriodMembership`.
      ...teacherFiles.flatMap((file) => file.students ?? []),
    ]),
    groups: [...parseGroups(periodFiles.flatMap((file) => file.groups)), ...parseGroupsFile(files.get(GROUPS_FILE))],
    appointments: parseAppointments(
      [...periodFiles, ...teacherFiles].flatMap((file) => file.appointments ?? []),
      config.reportPeriods,
    ),
    blockers: parseBlockers(teacherFiles.flatMap((file) => file.blockers)),
    sharedAppointments: [
      ...parseSharedFile(files.get(SHARED_FILE), config),
      ...parseSharedAppointments(reportFiles.flatMap((file) => file.sharedAppointments), config.reportPeriods),
    ],
  };
}

/** Unterrichtszeiten und Orte des Lehrers aus den Zeitraumdateien; ältere Lehrerdateien enthalten sie selbst. */
function withReportData(teacher: Teacher, reportFiles: ReportFile[]): Teacher {
  const periodWindows = { ...(teacher.periodWindows ?? {}) };
  const periodLocations = { ...(teacher.periodLocations ?? {}) };
  for (const file of reportFiles) {
    const entry = file.teachers[teacher.id];
    if (entry?.windows) periodWindows[file.period.id] = entry.windows;
    if (entry && typeof entry.location === 'string') periodLocations[file.period.id] = entry.location;
  }
  return { ...teacher, periodWindows, periodLocations };
}

function parseReportFile(name: string, content: string): ReportFile {
  const file = JSON.parse(content) as Partial<ReportFile>;
  if (file?.format !== 'unterricht-feedback/berichtszeitraum' || typeof file.period?.id !== 'string') {
    throw new Error(`„${name}“ ist keine Datei eines Berichtszeitraums dieser App.`);
  }
  return {
    format: file.format,
    version: 1,
    period: file.period,
    teachers: file.teachers && typeof file.teachers === 'object' ? file.teachers : {},
    sharedAppointments: Array.isArray(file.sharedAppointments) ? file.sharedAppointments : [],
  };
}

/**
 * Setzt jede Person aus ihren Einträgen in den Zeitraumdateien zusammen: Zeiträume und Stunden aus allen, Name,
 * Instrument und allgemeine Texte aus dem spätesten Zeitraum.
 */
function mergedStudents(files: PeriodFile[], periods: ReportPeriodEntry[]): Student[] {
  const start = (file: PeriodFile) => periods.find((p) => p.id === file.periodId)?.from ?? '';
  const byId = new Map<string, Student>();
  for (const file of [...files].sort((a, b) => start(a).localeCompare(start(b)))) {
    for (const entry of file.students) {
      const known = byId.get(entry.id);
      const lessons = [...(known?.lessons ?? []), ...entry.lessons.filter((l) => !known?.lessons.some((k) => k.id === l.id))];
      const periodsOf = { ...known?.periods, ...(file.periodId ? { [file.periodId]: file.teacherId } : {}) };
      byId.set(entry.id, { ...entry, periods: periodsOf, lessons });
    }
  }
  return [...byId.values()];
}

/** Ältere Sicherungen haben noch keine allgemeinen Termine. */
function parseSharedFile(content: string | undefined, config: FeedbackConfig): SharedAppointment[] {
  if (!content) return [];
  const file = JSON.parse(content) as Partial<SharedFile>;
  if (file?.format !== 'unterricht-feedback/allgemeine-termine') {
    throw new Error(`„${SHARED_FILE}“ ist keine Termindatei dieser App.`);
  }
  return parseSharedAppointments(file.appointments, config.reportPeriods);
}

/** Ältere Sicherungen haben noch keine Gruppen. */
function parseGroupsFile(content: string | undefined): Group[] {
  if (!content) return [];
  const file = JSON.parse(content) as Partial<GroupsFile>;
  if (file?.format !== 'unterricht-feedback/gruppen') throw new Error(`„${GROUPS_FILE}“ ist keine Gruppendatei dieser App.`);
  return parseGroups(file.groups);
}

function sharedFile(appointments: SharedAppointment[]): SharedFile {
  return { format: 'unterricht-feedback/allgemeine-termine', version: 1, appointments };
}

/** Ohne Lehrer, ihre Varianten und ihre eigenen Abschnitte und Inhalte; die stehen in den Lehrerdateien. */
function generalFile(config: FeedbackConfig): GeneralFile {
  const teacherIds = new Set(config.teachers.map((t) => t.id));
  const shared = <T extends { ownerId?: string }>(list: T[]) =>
    list.filter((entry) => !entry.ownerId || !teacherIds.has(entry.ownerId));
  const sharedBlocks = (list: FixedBlock[]) =>
    shared(list).map((block) => ({
      ...block,
      variants: block.variants.filter((variant) => !ownerOf(variant, config.teachers)),
    }));
  const blocks = sharedBlocks(config.blocks);
  const { reportPeriods: _periods, ...rest } = config;
  return {
    format: 'unterricht-feedback/konfiguration',
    version: 1,
    config: {
      ...rest,
      teachers: [],
      blocks,
      sections: shared(config.sections),
      groupSections: shared(config.groupSections),
      groupBlocks: sharedBlocks(config.groupBlocks),
    },
  };
}

function ownEntries(config: FeedbackConfig, teacherId: string): OwnEntry[] {
  return OWN_LISTS.flatMap((list) =>
    (config[list] as (Section | FixedBlock)[])
      .map((entry, index) => ({ list, index, entry }) as OwnEntry)
      .filter(({ entry }) => entry.ownerId === teacherId),
  );
}

/** Fügt die eigenen Abschnitte und Inhalte der Lehrer an ihren Stellen wieder in die Listen ein. */
function withOwnEntries(config: Partial<FeedbackConfig>, teacherFiles: TeacherFile[]): Partial<FeedbackConfig> {
  const entries = teacherFiles.flatMap((file) => file.own ?? []).sort((a, b) => a.index - b.index);
  const result: Partial<FeedbackConfig> = { ...config };
  for (const list of OWN_LISTS) {
    const merged: unknown[] = [...((config[list] as unknown[] | undefined) ?? [])];
    for (const { index, entry } of entries.filter((e) => e.list === list)) {
      merged.splice(Math.min(index, merged.length), 0, entry);
    }
    // Ältere Konfigurationen ohne Gruppen-Listen bekommen beim Einlesen die Vorlage.
    if (config[list] !== undefined || merged.length > 0) Object.assign(result, { [list]: merged });
  }
  return result;
}

function teacherFile(data: AppData, teacher: Teacher, position: number): TeacherFile {
  const { config } = data;
  const variants = (['blocks', 'groupBlocks'] as const).flatMap((list) =>
    config[list].flatMap((block) =>
      block.variants
        .map((variant, index) => ({ ...(list === 'groupBlocks' ? { list } : {}), blockId: block.id, index, variant }))
        .filter(({ variant }) => ownerOf(variant, config.teachers)?.id === teacher.id),
    ),
  );
  // Blocker ohne bekannten Lehrer landen beim ersten, wie Termine ohne bekannte Person.
  const teacherIds = new Set(config.teachers.map((t) => t.id));
  const blockers = data.blockers.filter(
    (blocker) => blocker.teacherId === teacher.id || (position === 0 && !teacherIds.has(blocker.teacherId)),
  );
  const own = ownEntries(config, teacher.id);
  // Unterrichtszeiten und Orte je Zeitraum stehen in den Zeitraumdateien, damit nur dessen Lehrer sie sehen.
  const { periodWindows: _w, periodLocations: _l, ...withoutPeriods } = teacher;
  return {
    format: 'unterricht-feedback/lehrer',
    version: 1,
    position,
    teacher: withoutPeriods as Teacher,
    variants,
    ...(own.length ? { own } : {}),
    blockers,
  };
}

/**
 * Teilt Personen, Gruppen und Termine auf Zeitraum und Lehrer auf. Eine Stunde und ein Termin einer Person stehen
 * in dem ihrer Zeiträume, in dem sie liegen, sonst im spätesten. Personen ohne bekannten Zeitraum und Termine ohne
 * bekannte Person oder Gruppe stehen in einer Datei ohne Zeitraum. Leere Dateien entfallen.
 */
function periodFiles(data: AppData, naming: FileNaming = 'readable'): { name: string; file: PeriodFile }[] {
  const { config } = data;
  const periods = [...config.reportPeriods].sort((a, b) => a.from.localeCompare(b.from));
  const files = new Map<string, PeriodFile>();
  const fileOf = (periodId: string, teacherId: string) => {
    const key = `${periodId}|${teacherId}`;
    if (!files.has(key)) {
      files.set(key, { format: 'unterricht-feedback/zeitraum', version: 1, periodId, teacherId, students: [], groups: [], appointments: [] });
    }
    return files.get(key)!;
  };
  /** Datei zu einem Datum der Person: ihr Zeitraum, in dem es liegt, sonst ihr spätester */
  const studentTargets = new Map<string, (date: string) => PeriodFile>();
  for (const student of data.students) {
    const own = periods.filter((period) => Object.hasOwn(student.periods, period.id));
    const targets = own.map((period) => ({ period, file: fileOf(period.id, teacherOf(student, config, period.id).id) }));
    const fallback = targets.at(-1)?.file ?? fileOf('', teacherOf(student, config, '').id);
    const target = (date: string) => targets.find(({ period }) => containsDate(period, date))?.file ?? fallback;
    studentTargets.set(student.id, target);
    const { periods: _p, legacyTeacherId: _l, lessons, ...rest } = student;
    for (const file of new Set([fallback, ...targets.map((t) => t.file)])) {
      file.students.push({ ...rest, lessons: lessons.filter((lesson) => target(lesson.date) === file) });
    }
  }
  const knownPeriods = new Set(periods.map((period) => period.id));
  const groupFiles = new Map<string, PeriodFile>();
  for (const group of data.groups) {
    const file = fileOf(knownPeriods.has(group.periodId) ? group.periodId : '', groupTeacherOf(group, config).id);
    file.groups.push(group);
    groupFiles.set(group.id, file);
  }
  for (const appointment of data.appointments) {
    const owner = appointmentOwner(appointment);
    const file = groupFiles.get(owner) ?? studentTargets.get(owner)?.(appointment.date) ?? fileOf('', config.teachers[0].id);
    file.appointments.push(appointment);
  }
  const names = periodFileNames([...files.values()], config, naming);
  return [...files.values()]
    .filter((file) => file.students.length + file.groups.length + file.appointments.length > 0)
    .map((file) => ({ name: names.get(file)!, file }));
}

/**
 * z. B. „zeitraum-1-Halbjahr-2026-27-Anna-Schmidt.json“, bei gleichen Namen mit dem Anfang der IDs; auf dem Server
 * „zeitraum_<Zeitraum-ID>_<Lehrer-ID>.json“ (ohne Zeitraum: leer).
 */
function periodFileNames(files: PeriodFile[], config: FeedbackConfig, naming: FileNaming): Map<PeriodFile, string> {
  const names = new Map<PeriodFile, string>();
  const used = new Set<string>();
  for (const file of files) {
    if (naming === 'ids') {
      names.set(file, `zeitraum_${file.periodId}_${file.teacherId}.json`);
      continue;
    }
    const period = config.reportPeriods.find((p) => p.id === file.periodId);
    const teacher = config.teachers.find((t) => t.id === file.teacherId);
    const label = `${period ? safeFileName(period.name) : 'ohne'}-${safeFileName(teacher?.name ?? 'Lehrkraft')}`;
    let name = `zeitraum-${label}.json`;
    if (used.has(name)) name = `zeitraum-${label}-${file.periodId.slice(0, 8)}-${file.teacherId.slice(0, 8)}.json`;
    used.add(name);
    names.set(file, name);
  }
  return names;
}

/** Eine Variante gehört einem Lehrer, wenn sie nur für ihn gilt. */
/** Lehrerdatei einer eigenen Variante */
function ownerOf(variant: BlockVariant, teachers: Teacher[]): Teacher | undefined {
  return variant.ownerId ? teachers.find((t) => t.id === variant.ownerId) : undefined;
}

/** Lesbare, eindeutige Dateinamen, bei gleichen Namen mit dem Anfang der ID; auf dem Server „lehrer-<ID>.json“. */
function teacherFileNames(teachers: Teacher[], naming: FileNaming): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const teacher of teachers) {
    if (naming === 'ids') {
      names.set(teacher.id, `lehrer-${teacher.id}.json`);
      continue;
    }
    let name = `lehrer-${safeFileName(teacher.name)}.json`;
    if (used.has(name)) name = `lehrer-${safeFileName(teacher.name)}-${teacher.id.slice(0, 8)}.json`;
    used.add(name);
    names.set(teacher.id, name);
  }
  return names;
}

function parseTeacherFile(name: string, content: string): TeacherFile {
  const file = JSON.parse(content) as Partial<TeacherFile>;
  if (file?.format !== 'unterricht-feedback/lehrer' || !file.teacher) {
    throw new Error(`„${name}“ ist keine Lehrerdatei dieser App.`);
  }
  return {
    format: file.format,
    version: 1,
    position: Number(file.position) || 0,
    teacher: file.teacher,
    variants: Array.isArray(file.variants) ? file.variants : [],
    own: Array.isArray(file.own) ? file.own.filter((e) => OWN_LISTS.includes(e?.list) && e.entry) : [],
    blockers: Array.isArray(file.blockers) ? file.blockers : [],
    students: Array.isArray(file.students) ? file.students : [],
    appointments: Array.isArray(file.appointments) ? file.appointments : [],
  };
}

function parsePeriodFile(name: string, content: string): PeriodFile {
  const file = JSON.parse(content) as Partial<PeriodFile>;
  if (file?.format !== 'unterricht-feedback/zeitraum' || typeof file.teacherId !== 'string') {
    throw new Error(`„${name}“ ist keine Zeitraumdatei dieser App.`);
  }
  return {
    format: file.format,
    version: 1,
    periodId: typeof file.periodId === 'string' ? file.periodId : '',
    teacherId: file.teacherId,
    students: Array.isArray(file.students) ? file.students : [],
    groups: Array.isArray(file.groups) ? file.groups : [],
    appointments: Array.isArray(file.appointments) ? file.appointments : [],
  };
}

/** Fügt die Varianten der Lehrer wieder an ihrer früheren Stelle ein; Varianten zu fehlenden Blöcken entfallen. */
/** Fügt die Varianten aus den Lehrerdateien an ihren Stellen in die Blöcke ein. */
function withTeacherVariants(
  blocks: FixedBlock[],
  teacherFiles: TeacherFile[],
  list: 'blocks' | 'groupBlocks',
): FixedBlock[] {
  const variants = teacherFiles
    .flatMap((file) => file.variants)
    .filter((v) => (v.list ?? 'blocks') === list)
    .sort((a, b) => a.index - b.index);
  return blocks.map((block) => {
    const merged = [...(block.variants ?? [])];
    for (const { index, variant } of variants.filter((v) => v.blockId === block.id)) {
      merged.splice(Math.min(index, merged.length), 0, variant);
    }
    return { ...block, variants: merged };
  });
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
