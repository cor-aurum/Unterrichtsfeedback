import { Component, computed, inject, output, signal } from '@angular/core';
import { ConfigStore } from '../config.store';
import { GroupsStore } from '../groups.store';
import { ReportPeriod } from '../report-period';
import { defaultInstrument, formatShortDate, Teacher } from '../model';
import { StudentsStore } from '../students.store';
import {
  ColumnMapping,
  columnLabels,
  guessMapping,
  ImportRow,
  ImportTable,
  readTables,
  toImportRows,
} from './student-import';

type Step = 'file' | 'columns' | 'teachers';

/** Wie viele Zeilen die Vorschau bei der Spaltenauswahl zeigt */
const PREVIEW_ROWS = 5;

/**
 * Import von Personen aus einer Excel- oder CSV-Datei in drei Schritten: Datei wählen, Spalten zuordnen,
 * Lehrer je Person festlegen. Nicht vorhandene Instrumente werden angelegt. Personen aus anderen
 * Berichtszeiträumen werden in den gewählten übernommen statt neu angelegt; benannte Gruppen aus der Datei
 * werden im gewählten Zeitraum ohne Mitglieder angelegt, z. B. mit der Liste des vorigen Zeitraums.
 */
@Component({
  selector: 'app-student-import-panel',
  templateUrl: './student-import-panel.html',
  styleUrl: './student-import-panel.scss',
})
export class StudentImportPanel {
  readonly closed = output<string>();

  private readonly configStore = inject(ConfigStore);
  private readonly studentsStore = inject(StudentsStore);
  private readonly groupsStore = inject(GroupsStore);
  private readonly reportPeriod = inject(ReportPeriod);
  /** Lehrer des gewählten Zeitraums; in ihn kommen die importierten Personen. */
  protected readonly teachers = computed(() => {
    const teachers = this.reportPeriod.teachers();
    return teachers.length > 0 ? teachers : this.configStore.config().teachers;
  });
  protected readonly periodName = computed(() => this.reportPeriod.period().name);
  protected readonly formatShortDate = formatShortDate;
  /** Zeilen, deren Geburtsdatum nicht lesbar ist; sie werden ohne Geburtsdatum importiert. */
  protected readonly invalidBirthDates = computed(() => this.rows().filter((row) => row.invalidBirthDate).length);

  protected readonly step = signal<Step>('file');
  protected readonly error = signal<string | null>(null);
  protected readonly fileName = signal('');
  protected readonly tables = signal<ImportTable[]>([]);
  protected readonly tableIndex = signal(0);
  protected readonly table = computed(() => this.tables()[this.tableIndex()] ?? { name: '', rows: [] });
  protected readonly mapping = signal<ColumnMapping>({
    firstName: 0,
    lastName: null,
    instrument: null,
    teacher: null,
    groups: null,
    birthDate: null,
    hasHeader: true,
  });
  protected readonly columns = computed(() => columnLabels(this.table(), this.mapping().hasHeader));

  protected readonly rows = computed(() => {
    const active = new Set(this.studentsStore.students().map((s) => s.id));
    const known = this.studentsStore
      .allStudents()
      .map((s) => ({ id: s.id, name: s.name, birthDate: s.birthDate, active: active.has(s.id) }));
    return toImportRows(this.table(), this.mapping(), known, this.teachers());
  });
  /** Benannte Gruppen aus der Datei, die es im Zeitraum noch nicht gibt */
  protected readonly newGroups = computed(() => {
    const known = new Set(this.groupsStore.groups().map((g) => g.name.trim().toLowerCase()));
    const names = this.rows().flatMap((row) => row.groups).filter((name) => !known.has(name.toLowerCase()));
    return [...new Map(names.map((name) => [name.toLowerCase(), name])).values()];
  });
  protected readonly preview = computed(() => this.rows().slice(0, PREVIEW_ROWS));
  /** Instrumente aus der Datei, die es noch nicht gibt */
  protected readonly newInstruments = computed(() => {
    const known = new Set(this.configStore.config().instruments.map((i) => i.name.trim().toLowerCase()));
    const names = this.rows().map((row) => row.instrument).filter((name) => name && !known.has(name.toLowerCase()));
    return [...new Map(names.map((name) => [name.toLowerCase(), name])).values()];
  });

  /** Lehrer je Zeile (`line`); fehlt der Eintrag, gilt der erste Lehrer. */
  private readonly assigned = signal(new Map<number, string>());
  /** Ob die Zeile importiert wird; Personen, die es schon gibt, zunächst nicht. */
  private readonly included = signal(new Map<number, boolean>());
  protected readonly selectedCount = computed(() => this.rows().filter((row) => this.isIncluded(row)).length);

  protected async loadFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.error.set(null);
    try {
      const tables = await readTables(file);
      if (tables.length === 0) throw new Error('Die Datei enthält keine Daten.');
      this.fileName.set(file.name);
      this.tables.set(tables);
      this.selectTable(0);
      this.step.set('columns');
    } catch (e) {
      this.error.set(`Die Datei konnte nicht gelesen werden: ${e instanceof Error ? e.message : e}`);
    }
  }

  protected selectTable(index: number): void {
    this.tableIndex.set(index);
    this.mapping.set(guessMapping(this.table()));
  }

  protected setColumn(
    key: 'firstName' | 'lastName' | 'instrument' | 'teacher' | 'groups' | 'birthDate',
    event: Event,
  ): void {
    const value = (event.target as HTMLSelectElement).value;
    this.mapping.update((m) => ({ ...m, [key]: value === '' ? null : Number(value) }));
  }

  protected setHasHeader(event: Event): void {
    this.mapping.update((m) => ({ ...m, hasHeader: (event.target as HTMLInputElement).checked }));
  }

  /** Lehrer aus der Datei, sonst bei Personen anderer Zeiträume ihr bisheriger */
  protected toTeachers(): void {
    const students = new Map(this.studentsStore.allStudents().map((s) => [s.id, s]));
    const assigned = this.rows().map((row) => {
      const former = row.formerId ? students.get(row.formerId) : undefined;
      return [row.line, row.teacherId ?? (former ? this.studentsStore.teacherOf(former).id : null)] as const;
    });
    this.assigned.set(new Map(assigned.filter((entry): entry is [number, string] => entry[1] !== null)));
    this.included.set(new Map(this.rows().map((row) => [row.line, !row.existing])));
    this.step.set('teachers');
  }

  protected teacherOf(row: ImportRow): string {
    return this.assigned().get(row.line) ?? this.teachers()[0].id;
  }

  /** Ein Häkchen bei einem anderen Lehrer ersetzt den Standard; ohne Häkchen gilt wieder der erste Lehrer. */
  protected toggleTeacher(row: ImportRow, teacher: Teacher, checked: boolean): void {
    const first = this.teachers()[0].id;
    this.assigned.update((map) => new Map(map).set(row.line, checked ? teacher.id : first));
  }

  /** Alle ausgewählten Zeilen diesem Lehrer zuordnen */
  protected assignAll(teacher: Teacher): void {
    this.assigned.set(new Map(this.rows().map((row) => [row.line, teacher.id])));
  }

  protected isIncluded(row: ImportRow): boolean {
    return this.included().get(row.line) ?? !row.existing;
  }

  protected setIncluded(row: ImportRow, value: boolean): void {
    this.included.update((map) => new Map(map).set(row.line, value));
  }

  protected setAllIncluded(value: boolean): void {
    this.included.set(new Map(this.rows().map((row) => [row.line, value])));
  }

  protected import(): void {
    const rows = this.rows().filter((row) => this.isIncluded(row));
    const [former, fresh] = [rows.filter((row) => row.formerId), rows.filter((row) => !row.formerId)];
    const instrumentsBefore = this.configStore.config().instruments.length;
    const instrumentIds = this.configStore.ensureInstruments(fresh.map((row) => row.instrument));
    const fallback = defaultInstrument(this.configStore.config()).id;
    this.studentsStore.addStudents(
      fresh.map((row) => ({
        name: row.name,
        birthDate: row.birthDate,
        instrumentId: (row.instrument && instrumentIds.get(row.instrument.toLowerCase())) || fallback,
        teacherId: this.teacherOf(row),
      })),
    );
    this.studentsStore.addToPeriod(former.map((row) => ({ studentId: row.formerId!, teacherId: this.teacherOf(row) })));
    // Übernommene Personen ohne Geburtsdatum bekommen das aus der Datei.
    const students = new Map(this.studentsStore.allStudents().map((s) => [s.id, s]));
    for (const row of former.filter((r) => r.birthDate && !students.get(r.formerId!)?.birthDate)) {
      this.studentsStore.setBirthDate(row.formerId!, row.birthDate!);
    }
    const groups = this.groupsStore.addNamed(
      this.rows().flatMap((row) => row.groups.map((name) => ({ name, teacherId: this.teacherOf(row) }))),
    );
    const created = this.configStore.config().instruments.length - instrumentsBefore;
    const parts = [
      fresh.length > 0 ? `${count(fresh.length, 'Person', 'Personen')} importiert` : '',
      former.length > 0 ? `${count(former.length, 'Person', 'Personen')} aus anderen Zeiträumen übernommen` : '',
      created > 0 ? `${count(created, 'Instrument', 'Instrumente')} neu angelegt` : '',
      groups > 0 ? `${count(groups, 'Gruppe', 'Gruppen')} ohne Mitglieder angelegt` : '',
    ];
    this.closed.emit(`${parts.filter(Boolean).join(', ') || 'Nichts importiert'}.`);
  }
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
