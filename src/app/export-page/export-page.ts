import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ActiveTeacher } from '../active-teacher';
import { BackupService } from '../backup';
import { Connected, ServerLoginPanel } from '../sync/server-login-panel';
import { ServerSync } from '../sync/server-sync';
import { GENERAL_FILE, SHARED_FILE } from '../sync/sync-files';
import { ConfigStore } from '../config.store';
import { PdfExport } from '../pdf-export';
import { labelOf, ReportPeriod } from '../report-period';
import { isNativeApp } from '../save-file';
import { StudentLabelPipe } from '../student-label.pipe';
import { StudentsStore } from '../students.store';
import { GroupsStore } from '../groups.store';
import { Group, groupLabel, Student } from '../model';

type Scope = 'all' | 'single';

@Component({
  selector: 'app-export-page',
  imports: [RouterLink, StudentLabelPipe, ServerLoginPanel],
  templateUrl: './export-page.html',
  styleUrl: './export-page.scss',
})
export class ExportPage {
  private readonly config = inject(ConfigStore).config;
  private readonly pdf = inject(PdfExport);
  protected readonly store = inject(StudentsStore);
  protected readonly nativeApp = isNativeApp;
  protected readonly backup = inject(BackupService);
  protected readonly sync = inject(ServerSync);
  protected readonly activeTeacher = inject(ActiveTeacher);
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
    if (!file) return;
    try {
      // Die Sicherung eines Zeitraums ersetzt ebenfalls alles; darauf eigens hinweisen.
      const periodId = await this.backup.periodOf(file);
      const text = periodId
        ? 'Die Datei enthält nur einen Berichtszeitraum. Alle Daten auf diesem Gerät werden durch sie ersetzt, auch ' +
          'die Personen und Stunden anderer Zeiträume. Fortfahren?'
        : 'Alle Personen, Stunden und die Konfiguration auf diesem Gerät werden ersetzt. Fortfahren?';
      if (!confirm(text)) return;
      await this.backup.importFile(file);
      this.studentId.set(null);
      this.message.set({ text: `Daten aus „${file.name}“ importiert.`, error: false });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.message.set({ text: `Import fehlgeschlagen: ${reason}`, error: true });
    }
  }

  protected readonly serverName = computed(() => {
    const login = this.sync.login();
    return login ? new URL(login.url).host : '';
  });
  protected readonly loginError = signal<string | null>(null);

  /** Eingeloggt: abgleichen; liegen auf beiden Seiten Daten, fragt die App, welche gelten. */
  protected connected({ login }: Connected): void {
    this.sync.connect(login);
  }

  protected async reconnect(event: Event): Promise<void> {
    event.preventDefault();
    const password = String(new FormData(event.target as HTMLFormElement).get('password') ?? '');
    this.loginError.set(null);
    try {
      await this.sync.reconnect(password);
    } catch (e) {
      this.loginError.set(e instanceof Error ? e.message : String(e));
    }
  }

  protected async loadFromServer(): Promise<void> {
    if (confirm('Alle Personen, Stunden und die Konfiguration auf diesem Gerät werden durch die Daten vom Server ersetzt. Fortfahren?')) {
      await this.sync.loadFromServer();
    }
  }

  protected async overwriteServer(): Promise<void> {
    if (confirm('Die Daten auf dem Server werden durch die Daten auf diesem Gerät ersetzt, soweit du sie ändern darfst. Fortfahren?')) {
      await this.sync.overwriteServer();
    }
  }

  protected resolveConflicts(keep: 'server' | 'local'): void {
    const text =
      keep === 'server'
        ? 'Die hier gemachten Änderungen an diesen Daten gehen verloren. Fortfahren?'
        : 'Die Änderungen des anderen Geräts an diesen Daten gehen verloren. Fortfahren?';
    if (confirm(text)) this.sync.resolveConflicts(keep);
  }

  /** Verständlicher Name einer Datei auf dem Server, z. B. „Anna Schmidt, 1. Halbjahr 2026/27“ */
  protected fileLabel(name: string): string {
    if (name === GENERAL_FILE) return 'Allgemeine Konfiguration';
    if (name === SHARED_FILE) return 'Allgemeine Termine';
    const config = this.config();
    const teacherName = (id: string) => config.teachers.find((t) => t.id === id)?.name ?? 'unbekannte Lehrkraft';
    const teacher = /^lehrer-(.+)\.json$/.exec(name);
    if (teacher) return `Lehrer ${teacherName(teacher[1])}`;
    const period = /^zeitraum_([^_]*)_(.+)\.json$/.exec(name);
    if (period) {
      const periodName = config.reportPeriods.find((p) => p.id === period[1])?.name ?? 'ohne Berichtszeitraum';
      return `${teacherName(period[2])}, ${periodName}`;
    }
    return name;
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

  protected disconnectServer(): void {
    if (confirm('Vom Server abmelden? Die Daten bleiben auf dem Server und auf diesem Gerät, werden aber nicht mehr abgeglichen.')) {
      this.sync.disconnect();
    }
  }


  protected exportPdf(action: 'open' | 'share'): void {
    const students = this.studentsToExport();
    const fileName = this.scope() === 'all' ? 'Feedback_alle' : `Feedback_${students[0].name}`;
    this.pdf.export(this.config(), students, fileName, action);
  }
}
