import { inject, Injectable } from '@angular/core';
import { ConfigStore, parseConfig } from './config.store';
import { FeedbackConfig, Student, today } from './model';
import { saveFile } from './save-file';
import { parseStudents, StudentsStore } from './students.store';

/**
 * Sicherung aller erfassten Daten. Die Konfiguration gehört dazu, weil die angehakten Einträge
 * einer Stunde auf die Textbausteine der Konfiguration verweisen.
 */
interface Backup {
  version: 1;
  config: FeedbackConfig;
  students: Student[];
}

@Injectable({ providedIn: 'root' })
export class BackupService {
  private readonly configStore = inject(ConfigStore);
  private readonly studentsStore = inject(StudentsStore);

  exportToFile(): Promise<void> {
    const backup: Backup = {
      version: 1,
      config: this.configStore.config(),
      students: this.studentsStore.students(),
    };
    const json = JSON.stringify(backup, null, 2);
    return saveFile(`unterricht-feedback-sicherung_${today()}.json`, new Blob([json], { type: 'application/json' }));
  }

  /**
   * Ersetzt Konfiguration und Personen durch den Inhalt der Sicherung.
   * Wirft einen Fehler, wenn die Datei kein gültiges Format hat; dann bleibt alles unverändert.
   */
  importFromJson(json: string): void {
    const backup = JSON.parse(json) as Partial<Backup>;
    if (!backup || typeof backup !== 'object' || !('students' in backup)) {
      throw new Error('Die Datei ist keine Datensicherung. Eine Konfiguration bitte unter „Konfiguration“ importieren.');
    }
    const config = parseConfig(backup.config);
    const students = parseStudents(backup.students);
    this.configStore.config.set(config);
    this.studentsStore.students.set(students);
    this.studentsStore.selectStudent(null);
  }
}
