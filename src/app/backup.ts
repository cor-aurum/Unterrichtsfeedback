import { computed, inject, Injectable } from '@angular/core';
import { Appointment, parseAppointments } from './calendar/appointments';
import { CalendarStore } from './calendar/calendar.store';
import { ConfigStore, parseConfig } from './config.store';
import { GroupsStore } from './groups.store';
import { FeedbackConfig, Student, today } from './model';
import { ReportPeriod } from './report-period';
import { safeFileName, saveFile } from './save-file';
import { parseStudents, StudentsStore } from './students.store';
import {
  AppData,
  backupPeriodOf,
  fromSyncFiles,
  isSyncFile,
  SyncFiles,
  toPeriodBackupFiles,
  toSyncFiles,
} from './sync/sync-files';

/** Frühere Sicherung als eine JSON-Datei; wird weiterhin gelesen. */
interface LegacyBackup {
  version: 1;
  config: FeedbackConfig;
  students: Student[];
  appointments: Appointment[];
}

/**
 * Sicherung aller erfassten Daten als ZIP mit einer allgemeinen Konfiguration, einer Datei je Lehrer und einer je
 * Lehrer und Berichtszeitraum (siehe `sync-files.ts`). Dieselben Dateien schreibt auch die Ordner-Synchronisation.
 * Die Sicherung eines Zeitraums enthält Personen, Gruppen und Termine nur aus diesem.
 */
@Injectable({ providedIn: 'root' })
export class BackupService {
  private readonly configStore = inject(ConfigStore);
  private readonly studentsStore = inject(StudentsStore);
  private readonly calendarStore = inject(CalendarStore);
  private readonly groupsStore = inject(GroupsStore);
  private readonly reportPeriod = inject(ReportPeriod);

  readonly data = computed<AppData>(() => ({
    config: this.configStore.config(),
    students: this.studentsStore.allStudents(),
    groups: this.groupsStore.allGroups(),
    appointments: this.calendarStore.appointments(),
    blockers: this.calendarStore.blockers(),
    sharedAppointments: this.calendarStore.sharedAppointments(),
  }));
  readonly files = computed(() => toSyncFiles(this.data()));

  /** Ohne `periodId` alles, sonst nur den Berichtszeitraum, z. B. für einen neuen Lehrer */
  async exportToFile(periodId?: string): Promise<void> {
    const { zipSync, strToU8 } = await import('fflate');
    const files = periodId ? toPeriodBackupFiles(this.data(), periodId) : this.files();
    const entries = Object.fromEntries([...files].map(([name, content]) => [name, strToU8(content)]));
    const zip = zipSync(entries, { level: 6 });
    const period = this.configStore.config().reportPeriods.find((p) => p.id === periodId);
    const label = period ? `_${safeFileName(period.name)}` : '';
    await saveFile(
      `unterricht-feedback-sicherung${label}_${today()}.zip`,
      new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' }),
    );
  }

  /** Berichtszeitraum, wenn die Datei die Sicherung nur eines Zeitraums ist; sonst `null` */
  async periodOf(file: File): Promise<string | null> {
    return file.name.toLowerCase().endsWith('.zip') ? backupPeriodOf(await unzip(file)) : null;
  }

  /**
   * Ersetzt Konfiguration, Personen und Termine durch den Inhalt einer ZIP-Sicherung oder einer älteren
   * JSON-Sicherung. Wirft einen Fehler, wenn die Datei kein gültiges Format hat; dann bleibt alles unverändert.
   * Nach der Sicherung eines Berichtszeitraums ist dieser gewählt.
   */
  async importFile(file: File): Promise<void> {
    if (file.name.toLowerCase().endsWith('.zip')) {
      const files = await unzip(file);
      this.importFiles(files);
      const periodId = backupPeriodOf(files);
      if (periodId) this.reportPeriod.select(periodId);
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
    const config = parseConfig(backup.config);
    this.apply({
      config,
      students: parseStudents(backup.students),
      groups: [],
      // Ältere Sicherungen ohne Termine lassen die vorhandenen Termine stehen.
      appointments:
        'appointments' in backup ? parseAppointments(backup.appointments, config.reportPeriods) : this.calendarStore.appointments(),
      blockers: this.calendarStore.blockers(),
      sharedAppointments: this.calendarStore.sharedAppointments(),
    });
  }

  /** Übernimmt Änderungen aus der Synchronisation; die gerade gewählte Person und Stunde bleiben ausgewählt. */
  applySynced(data: AppData): void {
    this.configStore.config.set(data.config);
    this.studentsStore.allStudents.set(data.students);
    this.groupsStore.allGroups.set(data.groups);
    this.calendarStore.appointments.set(data.appointments);
    this.calendarStore.blockers.set(data.blockers);
    this.calendarStore.sharedAppointments.set(data.sharedAppointments);
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
