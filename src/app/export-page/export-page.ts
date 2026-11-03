import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BackupService } from '../backup';
import { FolderSync } from '../sync/folder-sync';
import { WebDavSettings } from '../sync/sync-folder';
import { GENERAL_FILE, GROUPS_FILE, SHARED_FILE } from '../sync/sync-files';
import { ConfigStore } from '../config.store';
import { PdfExport } from '../pdf-export';
import { labelOf, ReportPeriod } from '../report-period';
import { isNativeApp, safeFileName } from '../save-file';
import { StudentsStore } from '../students.store';
import { GroupsStore } from '../groups.store';
import { Group, groupLabel, Student } from '../model';

type Scope = 'all' | 'single';

const EMPTY_WEBDAV: WebDavSettings = { url: '', user: '', password: '', folder: 'Unterrichtsfeedback' };

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
  protected readonly sync = inject(FolderSync);
  protected readonly webDavFormOpen = signal(false);
  protected readonly webDavError = signal<string | null>(null);
  protected readonly connecting = signal(false);
  protected readonly webDav = signal<WebDavSettings>(EMPTY_WEBDAV);
  protected readonly message = signal<{ text: string; error: boolean } | null>(null);
  protected readonly reportPeriod = inject(ReportPeriod);
  protected readonly labelOf = labelOf;
  private readonly groupsStore = inject(GroupsStore);

  protected readonly scope = signal<Scope>('all');
  protected readonly studentId = signal<string | null>(this.store.selectedStudentId());

  /** Personen mit mindestens einer Stunde im Berichtszeitraum, jeweils nur mit diesen Stunden */
  protected readonly studentsInPeriod = computed(() =>
    this.store
      .sortedStudents()
      .map((student) => ({ ...student, lessons: this.reportPeriod.lessonsOf(student) }))
      .filter((student) => student.lessons.length > 0),
  );
  protected readonly studentsToExport = computed(() =>
    this.scope() === 'all'
      ? this.studentsInPeriod()
      : this.studentsInPeriod().filter((s) => s.id === this.studentId()),
  );
  protected readonly lessonCount = computed(() =>
    this.studentsToExport().reduce((sum, student) => sum + student.lessons.length, 0),
  );

  // ---------- Gruppen-PDF ----------

  protected readonly groupScope = signal<Scope>('all');
  protected readonly groupId = signal<string | null>(null);
  protected readonly groups = computed(() =>
    [...this.groupsStore.groups()].sort((a, b) => this.groupLabel(a).localeCompare(this.groupLabel(b), 'de')),
  );
  /** Gruppen mit mindestens einer Gruppenstunde im Berichtszeitraum, jeweils nur mit diesen Stunden */
  protected readonly groupsInPeriod = computed(() =>
    this.groups()
      .map((group) => ({ ...group, lessons: this.reportPeriod.lessonsOf(group) }))
      .filter((group) => group.lessons.length > 0),
  );
  protected readonly groupsToExport = computed(() =>
    this.groupScope() === 'all' ? this.groupsInPeriod() : this.groupsInPeriod().filter((g) => g.id === this.groupId()),
  );
  protected readonly groupLessonCount = computed(() =>
    this.groupsToExport().reduce((sum, group) => sum + group.lessons.length, 0),
  );

  protected groupLabel(group: Group): string {
    return groupLabel(group, this.store.students());
  }

  protected groupLessonsInPeriod(group: Group): number {
    return this.reportPeriod.lessonsOf(group).length;
  }

  protected setGroupScope(event: Event): void {
    this.groupScope.set((event.target as HTMLInputElement).value as Scope);
  }

  protected selectGroup(event: Event): void {
    this.groupId.set((event.target as HTMLSelectElement).value);
    this.groupScope.set('single');
  }

  protected exportGroupPdf(action: 'open' | 'share'): void {
    const groups = this.groupsToExport();
    const fileName = this.groupScope() === 'all' ? 'Feedback_Gruppen' : `Feedback_Gruppe_${this.groupLabel(groups[0])}`;
    this.pdf.exportGroups(this.config(), groups, this.store.students(), fileName, action);
  }

  protected setScope(event: Event): void {
    this.scope.set((event.target as HTMLInputElement).value as Scope);
  }

  protected lessonsInPeriod(student: Student): number {
    return this.reportPeriod.lessonsOf(student).length;
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
      await this.backup.importFile(file);
      this.studentId.set(null);
      this.message.set({ text: `Daten aus „${file.name}“ importiert.`, error: false });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.message.set({ text: `Import fehlgeschlagen: ${reason}`, error: true });
    }
  }

  protected async loadFromFolder(): Promise<void> {
    if (confirm('Alle Personen, Stunden und die Konfiguration auf diesem Gerät werden durch den Ordnerinhalt ersetzt. Fortfahren?')) {
      await this.sync.loadFromFolder();
    }
  }

  protected async overwriteFolder(): Promise<void> {
    if (confirm('Die Dateien im Ordner werden durch die Daten auf diesem Gerät ersetzt. Fortfahren?')) {
      await this.sync.overwriteFolder();
    }
  }

  protected openWebDavForm(): void {
    this.webDav.set(this.sync.webDavSettings() ?? EMPTY_WEBDAV);
    this.webDavError.set(null);
    this.webDavFormOpen.set(true);
  }

  protected async connectWebDav(event: Event): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    const value = (key: string) => String(form.get(key) ?? '').trim();
    const settings = { url: value('url'), user: value('user'), password: value('password'), folder: value('folder') };
    this.webDav.set(settings);
    this.connecting.set(true);
    this.webDavError.set(null);
    try {
      await this.sync.connectWebDav(settings);
      this.webDavFormOpen.set(false);
    } catch (e) {
      this.webDavError.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.connecting.set(false);
    }
  }

  protected resolveConflicts(keep: 'folder' | 'local'): void {
    const text =
      keep === 'folder'
        ? 'Die hier gemachten Änderungen an diesen Daten gehen verloren. Fortfahren?'
        : 'Die Änderungen des anderen Geräts an diesen Daten gehen verloren. Fortfahren?';
    if (confirm(text)) this.sync.resolveConflicts(keep);
  }

  /** Verständlicher Name einer Sync-Datei */
  protected fileLabel(name: string): string {
    if (name === GENERAL_FILE) return 'Allgemeine Konfiguration';
    if (name === GROUPS_FILE) return 'Gruppen';
    if (name === SHARED_FILE) return 'Allgemeine Termine';
    const teacher = this.config().teachers.find((t) => name === `lehrer-${safeFileName(t.name)}.json`);
    return teacher ? `Lehrer ${teacher.name}` : name;
  }

  /**
   * Löscht alle Daten dieses Geräts nach zweifacher Bestätigung. Eine laufende Synchronisation wird vorher beendet,
   * damit der Ordner nicht mit der leeren Vorlage überschrieben wird. Danach startet die App neu.
   */
  protected async resetAll(): Promise<void> {
    const answer = prompt(
      'Wirklich ALLE Daten auf diesem Gerät löschen? Personen, Stunden, Gruppen, Termine, Blocker und die ' +
        'Konfiguration gehen verloren und lassen sich nur aus einer Datensicherung wiederherstellen.\n\n' +
        'Zum Bestätigen ZURÜCKSETZEN eingeben:',
    );
    if (answer === null) return;
    if (answer.trim().toUpperCase() !== 'ZURÜCKSETZEN') {
      this.message.set({ text: 'Nicht zurückgesetzt: Die Eingabe stimmte nicht.', error: true });
      return;
    }
    await this.sync.disconnect();
    for (const key of Object.keys(localStorage).filter((k) => k.startsWith('feedback.'))) {
      localStorage.removeItem(key);
    }
    location.hash = '#/stunden';
    location.reload();
  }

  protected disconnectFolder(): void {
    if (confirm('Ordner-Synchronisation beenden? Die Dateien im Ordner bleiben erhalten.')) this.sync.disconnect();
  }

  protected exportPdf(action: 'open' | 'share'): void {
    const students = this.studentsToExport();
    const fileName = this.scope() === 'all' ? 'Feedback_alle' : `Feedback_${students[0].name}`;
    this.pdf.export(this.config(), students, fileName, action);
  }
}
