import { Appointment, parseAppointments } from '../calendar/appointments';
import { parseConfig } from '../config.store';
import { BlockVariant, FeedbackConfig, Student, Teacher, teacherOf } from '../model';
import { safeFileName } from '../save-file';
import { parseStudents } from '../students.store';

/** Alles, was die App speichert und sichert */
export interface AppData {
  config: FeedbackConfig;
  students: Student[];
  appointments: Appointment[];
}

/** Dateiname → JSON-Inhalt */
export type SyncFiles = Map<string, string>;

/** Gemeinsame Konfiguration: Überschrift, Farbe, Abschnitte, Instrumente, feste Inhalte … */
export const GENERAL_FILE = 'konfiguration.json';
const TEACHER_FILE = /^lehrer-.+\.json$/;

interface GeneralFile {
  format: 'unterricht-feedback/konfiguration';
  version: 1;
  /** Ohne Lehrer und ohne Varianten, die nur für einen Lehrer gelten */
  config: FeedbackConfig;
}

/**
 * Alles, was zu einem Lehrer gehört. Fehlt die Datei, funktionieren die anderen Lehrer weiter; mit ihr fehlen
 * nur dieser Lehrer, seine Textvarianten, seine Personen und seine Termine.
 */
interface TeacherFile {
  format: 'unterricht-feedback/lehrer';
  version: 1;
  /** Stelle des Lehrers in der Liste */
  position: number;
  teacher: Teacher;
  variants: TeacherVariant[];
  students: Student[];
  appointments: Appointment[];
}

/** Variante eines festen Blocks; `index` ist ihre Stelle unter den Varianten, weil die erste passende gilt. */
interface TeacherVariant {
  blockId: string;
  index: number;
  variant: BlockVariant;
}

export function isSyncFile(name: string): boolean {
  return name === GENERAL_FILE || TEACHER_FILE.test(name);
}

export function isTeacherFile(name: string): boolean {
  return TEACHER_FILE.test(name);
}

export function toSyncFiles(data: AppData): SyncFiles {
  const { config } = data;
  const files: SyncFiles = new Map();
  files.set(GENERAL_FILE, json(generalFile(config)));
  const fileNames = teacherFileNames(config.teachers);
  config.teachers.forEach((teacher, position) =>
    files.set(fileNames.get(teacher.id)!, json(teacherFile(data, teacher, position))),
  );
  return files;
}

/**
 * Setzt die Daten aus der allgemeinen Datei und beliebig vielen Lehrerdateien wieder zusammen.
 * Wirft einen Fehler, wenn die allgemeine Datei fehlt oder eine Datei kein gültiges Format hat.
 */
export function fromSyncFiles(files: SyncFiles): AppData {
  const generalJson = files.get(GENERAL_FILE);
  if (!generalJson) throw new Error(`Die Datei „${GENERAL_FILE}“ fehlt.`);
  const general = JSON.parse(generalJson) as Partial<GeneralFile>;
  if (general?.format !== 'unterricht-feedback/konfiguration') {
    throw new Error(`„${GENERAL_FILE}“ ist keine Konfiguration dieser App.`);
  }
  const teacherFiles = [...files]
    .filter(([name]) => isTeacherFile(name))
    .map(([name, content]) => parseTeacherFile(name, content))
    .sort((a, b) => a.position - b.position);

  const config = parseConfig({
    ...general.config,
    teachers: teacherFiles.map((file) => file.teacher),
    blocks: withTeacherVariants(general.config!.blocks ?? [], teacherFiles),
  });
  return {
    config,
    students: parseStudents(teacherFiles.flatMap((file) => file.students)),
    appointments: parseAppointments(teacherFiles.flatMap((file) => file.appointments)),
  };
}

function generalFile(config: FeedbackConfig): GeneralFile {
  const blocks = config.blocks.map((block) => ({
    ...block,
    variants: block.variants.filter((variant) => !ownerOf(variant, config.teachers)),
  }));
  return { format: 'unterricht-feedback/konfiguration', version: 1, config: { ...config, teachers: [], blocks } };
}

function teacherFile(data: AppData, teacher: Teacher, position: number): TeacherFile {
  const { config } = data;
  const students = data.students
    .filter((student) => teacherOf(student, config).id === teacher.id)
    // Personen ohne gültigen Lehrer gehören zum ersten; in der Datei steht er ausdrücklich.
    .map((student) => ({ ...student, teacherId: teacher.id }));
  const studentIds = new Set(students.map((student) => student.id));
  const knownStudentIds = new Set(data.students.map((student) => student.id));
  const appointments = data.appointments.filter(
    (appointment) =>
      studentIds.has(appointment.studentId) || (position === 0 && !knownStudentIds.has(appointment.studentId)),
  );
  const variants = config.blocks.flatMap((block) =>
    block.variants
      .map((variant, index) => ({ blockId: block.id, index, variant }))
      .filter(({ variant }) => ownerOf(variant, config.teachers)?.id === teacher.id),
  );
  return { format: 'unterricht-feedback/lehrer', version: 1, position, teacher, variants, students, appointments };
}

/** Eine Variante gehört einem Lehrer, wenn sie nur für ihn gilt. */
function ownerOf(variant: BlockVariant, teachers: Teacher[]): Teacher | undefined {
  return variant.teacherIds.length === 1 ? teachers.find((t) => t.id === variant.teacherIds[0]) : undefined;
}

/** Lesbare, eindeutige Dateinamen; bei gleichen Namen hilft der Anfang der ID. */
function teacherFileNames(teachers: Teacher[]): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const teacher of teachers) {
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
    students: Array.isArray(file.students) ? file.students : [],
    appointments: Array.isArray(file.appointments) ? file.appointments : [],
  };
}

/** Fügt die Varianten der Lehrer wieder an ihrer früheren Stelle ein; Varianten zu fehlenden Blöcken entfallen. */
function withTeacherVariants(blocks: FeedbackConfig['blocks'], teacherFiles: TeacherFile[]): FeedbackConfig['blocks'] {
  const variants = teacherFiles.flatMap((file) => file.variants).sort((a, b) => a.index - b.index);
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
