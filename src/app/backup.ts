import { computed, inject, Injectable } from '@angular/core';
import { Appointment, parseAppointments } from './calendar/appointments';
import { CalendarStore } from './calendar/calendar.store';
import { ConfigStore, parseConfig } from './config.store';
import { FeedbackConfig, Student, today } from './model';
import { saveFile } from './save-file';
import { parseStudents, StudentsStore } from './students.store';
import { AppData, fromSyncFiles, isSyncFile, SyncFiles, toSyncFiles } from './sync/sync-files';

/** Frühere Sicherung als eine JSON-Datei; wird weiterhin gelesen. */
interface LegacyBackup {
  version: 1;
  config: FeedbackConfig;
  students: Student[];
  appointments: Appointment[];
}

/**
 * Sicherung aller erfassten Daten als ZIP mit einer allgemeinen Konfiguration und einer Datei je Lehrer
 * (siehe `sync-files.ts`). Dieselben Dateien schreibt auch die Ordner-Synchronisation.
 */
@Injectable({ providedIn: 'root' })
export class BackupService {
  private readonly configStore = inject(ConfigStore);
  private readonly studentsStore = inject(StudentsStore);
  private readonly calendarStore = inject(CalendarStore);

  readonly data = computed<AppData>(() => ({
    config: this.configStore.config(),
    students: this.studentsStore.students(),
    appointments: this.calendarStore.appointments(),
  }));
  readonly files = computed(() => toSyncFiles(this.data()));

  async exportToFile(): Promise<void> {
    const { zipSync, strToU8 } = await import('fflate');
    const entries = Object.fromEntries([...this.files()].map(([name, content]) => [name, strToU8(content)]));
    const zip = zipSync(entries, { level: 6 });
    await saveFile(`unterricht-feedback-sicherung_${today()}.zip`, new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' }));
  }

  /**
   * Ersetzt Konfiguration, Personen und Termine durch den Inhalt einer ZIP-Sicherung oder einer älteren
   * JSON-Sicherung. Wirft einen Fehler, wenn die Datei kein gültiges Format hat; dann bleibt alles unverändert.
   */
  async importFile(file: File): Promise<void> {
    if (file.name.toLowerCase().endsWith('.zip')) {
      this.importFiles(await unzip(file));
    } else {
      this.importLegacyJson(await file.text());
    }
  }

  importFiles(files: SyncFiles): void {
    this.apply(fromSyncFiles(files));
  }

  private importLegacyJson(json: string): void {
    const backup = JSON.parse(json) as Partial<LegacyBackup>;
    if (!backup || typeof backup !== 'object' || !('students' in backup)) {
      throw new Error('Die Datei ist keine Datensicherung. Eine Konfiguration bitte unter „Konfiguration“ importieren.');
    }
    this.apply({
      config: parseConfig(backup.config),
      students: parseStudents(backup.students),
      // Ältere Sicherungen ohne Termine lassen die vorhandenen Termine stehen.
      appointments: 'appointments' in backup ? parseAppointments(backup.appointments) : this.calendarStore.appointments(),
    });
  }

  /** Übernimmt Änderungen aus der Synchronisation; die gerade gewählte Person und Stunde bleiben ausgewählt. */
  applySynced(data: AppData): void {
    this.configStore.config.set(data.config);
    this.studentsStore.students.set(data.students);
    this.calendarStore.appointments.set(data.appointments);
  }

  private apply(data: AppData): void {
    this.applySynced(data);
    this.studentsStore.selectStudent(null);
  }
}

async function unzip(file: File): Promise<SyncFiles> {
  const { unzipSync, strFromU8 } = await import('fflate');
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  return new Map(
    Object.entries(entries)
      // Ordner im ZIP sind egal, z. B. wenn es von Hand neu gepackt wurde.
      .map(([path, content]) => [path.split('/').at(-1)!, content] as const)
      .filter(([name]) => isSyncFile(name))
      .map(([name, content]) => [name, strFromU8(content)]),
  );
}
