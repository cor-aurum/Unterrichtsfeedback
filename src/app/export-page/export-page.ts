import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BackupService } from '../backup';
import { ConfigStore } from '../config.store';
import { PdfExport } from '../pdf-export';
import { isNativeApp } from '../save-file';
import { StudentsStore } from '../students.store';

type Scope = 'all' | 'single';

@Component({
  selector: 'app-export-page',
  imports: [RouterLink],
  templateUrl: './export-page.html',
  styleUrl: './export-page.scss',
})
export class ExportPage {
  private readonly config = inject(ConfigStore).config;
  private readonly pdf = inject(PdfExport);
  protected readonly store = inject(StudentsStore);
  protected readonly nativeApp = isNativeApp;
  protected readonly backup = inject(BackupService);
  protected readonly message = signal<{ text: string; error: boolean } | null>(null);

  protected readonly scope = signal<Scope>('all');
  protected readonly studentId = signal<string | null>(this.store.selectedStudentId());

  protected readonly studentsToExport = computed(() =>
    this.scope() === 'all'
      ? this.store.sortedStudents()
      : this.store.sortedStudents().filter((s) => s.id === this.studentId()),
  );
  protected readonly lessonCount = computed(() =>
    this.studentsToExport().reduce((sum, student) => sum + student.lessons.length, 0),
  );

  protected setScope(event: Event): void {
    this.scope.set((event.target as HTMLInputElement).value as Scope);
  }

  protected selectStudent(event: Event): void {
    this.studentId.set((event.target as HTMLSelectElement).value);
    this.scope.set('single');
  }

  protected async importBackup(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file || !confirm('Alle Personen, Stunden und die Konfiguration in diesem Browser werden ersetzt. Fortfahren?')) {
      return;
    }
    try {
      this.backup.importFromJson(await file.text());
      this.studentId.set(null);
      this.message.set({ text: `Daten aus „${file.name}“ importiert.`, error: false });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.message.set({ text: `Import fehlgeschlagen: ${reason}`, error: true });
    }
  }

  protected exportPdf(action: 'open' | 'share'): void {
    const students = this.studentsToExport();
    const fileName = this.scope() === 'all' ? 'Feedback_alle' : `Feedback_${students[0].name}`;
    this.pdf.export(this.config(), students, fileName, action);
  }
}
