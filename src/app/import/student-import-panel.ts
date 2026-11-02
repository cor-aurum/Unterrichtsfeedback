import { Component, computed, inject, output, signal } from '@angular/core';
import { ConfigStore } from '../config.store';
import { defaultInstrument, Teacher } from '../model';
import { StudentsStore } from '../students.store';
import { ColumnMapping, columnLabels, guessMapping, ImportRow, ImportTable, readTables, toImportRows } from './student-import';

type Step = 'file' | 'columns' | 'teachers';

/** Wie viele Zeilen die Vorschau bei der Spaltenauswahl zeigt */
const PREVIEW_ROWS = 5;

/**
 * Import von Personen aus einer Excel- oder CSV-Datei in drei Schritten: Datei wählen, Spalten zuordnen,
 * Lehrer je Person festlegen. Nicht vorhandene Instrumente werden angelegt.
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
  protected readonly teachers = computed(() => this.configStore.config().teachers);

  protected readonly step = signal<Step>('file');
  protected readonly error = signal<string | null>(null);
  protected readonly fileName = signal('');
  protected readonly tables = signal<ImportTable[]>([]);
  protected readonly tableIndex = signal(0);
  protected readonly table = computed(() => this.tables()[this.tableIndex()] ?? { name: '', rows: [] });
  protected readonly mapping = signal<ColumnMapping>({ firstName: 0, lastName: null, instrument: null, hasHeader: true });
  protected readonly columns = computed(() => columnLabels(this.table(), this.mapping().hasHeader));

  protected readonly rows = computed(() =>
    toImportRows(this.table(), this.mapping(), this.studentsStore.students().map((s) => s.name)),
  );
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

  protected setColumn(key: 'firstName' | 'lastName' | 'instrument', event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.mapping.update((m) => ({ ...m, [key]: value === '' ? null : Number(value) }));
  }

  protected setHasHeader(event: Event): void {
    this.mapping.update((m) => ({ ...m, hasHeader: (event.target as HTMLInputElement).checked }));
  }

  protected toTeachers(): void {
    this.assigned.set(new Map());
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
    const instrumentsBefore = this.configStore.config().instruments.length;
    const instrumentIds = this.configStore.ensureInstruments(rows.map((row) => row.instrument));
    const fallback = defaultInstrument(this.configStore.config()).id;
    this.studentsStore.addStudents(
      rows.map((row) => ({
        name: row.name,
        instrumentId: (row.instrument && instrumentIds.get(row.instrument.toLowerCase())) || fallback,
        teacherId: this.teacherOf(row),
      })),
    );
    const created = this.configStore.config().instruments.length - instrumentsBefore;
    const people = rows.length === 1 ? '1 Person' : `${rows.length} Personen`;
    const instruments = created === 0 ? '' : created === 1 ? ', 1 Instrument neu angelegt' : `, ${created} Instrumente neu angelegt`;
    this.closed.emit(`${people} importiert${instruments}.`);
  }
}
