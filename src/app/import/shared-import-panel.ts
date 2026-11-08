import { Component, computed, inject, output, signal } from '@angular/core';
import { CalendarStore } from '../calendar/calendar.store';
import { ConfigStore } from '../config.store';
import { formatDate } from '../model';
import {
  countOtherKinds,
  earliestDate,
  guessSharedMapping,
  SharedColumnMapping,
  SharedImportRow,
  toSharedRows,
} from './shared-import';
import { columnLabels, ImportTable, readTables } from './student-import';

type Step = 'file' | 'columns';
type ColumnKey = Exclude<keyof SharedColumnMapping, 'hasHeader'>;

/** Spalten in der Reihenfolge der Auswahl; nur Bezeichnung und Datum sind Pflicht. */
const COLUMNS: { key: ColumnKey; label: string; optional: string | null }[] = [
  { key: 'title', label: 'Bezeichnung', optional: null },
  { key: 'date', label: 'Datum', optional: null },
  { key: 'start', label: 'Beginn', optional: '– keine Spalte (Uhrzeit steht im Datum) –' },
  { key: 'end', label: 'Ende', optional: '– keine Spalte –' },
  {
    key: 'duration',
    label: 'Dauer (Minuten)',
    optional: '– keine Spalte (ohne Ende: 60 Minuten) –',
  },
  { key: 'location', label: 'Ort', optional: '– keine Spalte –' },
  {
    key: 'teachers',
    label: 'Lehrkräfte',
    optional: '– keine Spalte (aktive Lehrkräfte des Berichtszeitraums) –',
  },
  { key: 'kind', label: 'Art', optional: '– keine Spalte (alles allgemeine Termine) –' },
];

/**
 * Import allgemeiner Termine aus einer Excel- oder CSV-Datei: Datei wählen, Spalten zuordnen, Vorschau prüfen.
 * Zeilen mit Problemen und schon vorhandene Termine werden nicht übernommen.
 */
@Component({
  selector: 'app-shared-import-panel',
  templateUrl: './shared-import-panel.html',
  styleUrl: './student-import-panel.scss',
})
export class SharedImportPanel {
  readonly closed = output<string>();

  private readonly config = inject(ConfigStore).config;
  private readonly calendar = inject(CalendarStore);
  protected readonly columnFields = COLUMNS;
  protected readonly formatDate = formatDate;

  protected readonly step = signal<Step>('file');
  protected readonly error = signal<string | null>(null);
  protected readonly fileName = signal('');
  protected readonly tables = signal<ImportTable[]>([]);
  protected readonly tableIndex = signal(0);
  protected readonly table = computed(
    () => this.tables()[this.tableIndex()] ?? { name: '', rows: [] },
  );
  protected readonly mapping = signal<SharedColumnMapping>(
    guessSharedMapping({ name: '', rows: [] }),
  );
  protected readonly columns = computed(() => columnLabels(this.table(), this.mapping().hasHeader));

  /** Leer: Termine an den Tagen aus der Datei; sonst liegt der früheste Termin an diesem Tag. */
  protected readonly startDate = signal('');

  protected readonly rows = computed(() =>
    toSharedRows(
      this.table(),
      this.mapping(),
      this.config(),
      this.calendar.sharedAppointments(),
      this.startDate() || null,
    ),
  );
  protected readonly earliestFileDate = computed(() =>
    earliestDate(this.rows().map((row) => row.fileDate)),
  );
  /** Einzelunterricht, Gruppen und Blocker aus dem Tabellen-Export des Kalenders */
  protected readonly otherKinds = computed(() => countOtherKinds(this.table(), this.mapping()));
  protected readonly importable = computed(() =>
    this.rows().filter((row) => !row.problem && !row.existing),
  );

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
      this.error.set(
        `Die Datei konnte nicht gelesen werden: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  protected selectTable(index: number): void {
    this.tableIndex.set(index);
    this.mapping.set(guessSharedMapping(this.table()));
  }

  protected setColumn(key: ColumnKey, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.mapping.update((m) => ({ ...m, [key]: value === '' ? null : Number(value) }));
  }

  protected setStartDate(event: Event): void {
    this.startDate.set((event.target as HTMLInputElement).value);
  }

  protected setHasHeader(event: Event): void {
    this.mapping.update((m) => ({ ...m, hasHeader: (event.target as HTMLInputElement).checked }));
  }

  protected teacherNames(row: SharedImportRow): string {
    if (row.appointment.allTeachers) return 'alle';
    const teachers = this.config().teachers;
    const names = row.appointment.teacherIds.map(
      (id) => teachers.find((t) => t.id === id)?.name ?? '',
    );
    return names.length === teachers.length && teachers.length > 1 ? 'alle' : names.join(', ');
  }

  protected status(row: SharedImportRow): string {
    if (row.problem) return row.problem;
    if (row.existing) return 'schon vorhanden';
    return row.unknownTeachers.length > 0 ? `unbekannt: ${row.unknownTeachers.join(', ')}` : '';
  }

  protected import(): void {
    const rows = this.importable();
    rows.forEach((row) => this.calendar.addShared(row.appointment));
    const skipped = this.rows().length - rows.length;
    const count = rows.length === 1 ? '1 allgemeiner Termin' : `${rows.length} allgemeine Termine`;
    this.closed.emit(
      `${count} importiert${skipped > 0 ? `, ${skipped} Zeile(n) übersprungen` : ''}.`,
    );
  }
}
