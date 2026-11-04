import { computed, inject, Injectable } from '@angular/core';
import { ConfigStore } from './config.store';
import { Student, Teacher } from './model';
import { storedSignal } from './stored-signal';
import { StudentsStore } from './students.store';
import { ServerSync } from './sync/server-sync';

/**
 * Lehrer, der gerade mit der App arbeitet. Er gilt nur auf diesem Gerät und steuert, welchen Kalender,
 * welche Termine unter „Heute geplant“ und welchen Lehrer neue Personen bekommen. Mit Server ist es immer der
 * angemeldete Lehrer; wählen kann man ihn nur ohne.
 */
@Injectable({ providedIn: 'root' })
export class ActiveTeacher {
  private readonly config = inject(ConfigStore).config;
  private readonly studentsStore = inject(StudentsStore);
  private readonly selectedId = storedSignal<string | null>('feedback.activeTeacher', () => null);
  private readonly login = inject(ServerSync).login;

  /** Mit Server angemeldet: Der Lehrer steht fest. */
  readonly fixed = computed(() => !!this.login());

  /**
   * Fehlt der gewählte Lehrer (noch keiner gewählt oder gelöscht), gilt der erste – auch mit Server, solange der
   * angemeldete noch nicht in der Konfiguration steht.
   */
  readonly teacher = computed<Teacher>(() => {
    const id = this.login()?.teacherId ?? this.selectedId();
    return this.config().teachers.find((t) => t.id === id) ?? this.config().teachers[0];
  });

  /** Mit Server ohne Wirkung; nach dem Abmelden gilt wieder die eigene Wahl. */
  select(teacherId: string): void {
    this.selectedId.set(teacherId);
  }

  teaches(student: Student): boolean {
    return this.studentsStore.teacherOf(student).id === this.teacher().id;
  }
}
