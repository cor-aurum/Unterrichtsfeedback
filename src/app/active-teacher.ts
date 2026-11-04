import { computed, inject, Injectable } from '@angular/core';
import { ConfigStore } from './config.store';
import { Student, Teacher } from './model';
import { storedSignal } from './stored-signal';
import { StudentsStore } from './students.store';

/**
 * Lehrer, der gerade mit der App arbeitet. Er gilt nur auf diesem Gerät und steuert, welchen Kalender,
 * welche Termine unter „Heute geplant“ und welchen Lehrer neue Personen bekommen.
 */
@Injectable({ providedIn: 'root' })
export class ActiveTeacher {
  private readonly config = inject(ConfigStore).config;
  private readonly studentsStore = inject(StudentsStore);
  private readonly selectedId = storedSignal<string | null>('feedback.activeTeacher', () => null);

  /** Fehlt der gewählte Lehrer (noch keiner gewählt oder gelöscht), gilt der erste. */
  readonly teacher = computed<Teacher>(
    () => this.config().teachers.find((t) => t.id === this.selectedId()) ?? this.config().teachers[0],
  );

  select(teacherId: string): void {
    this.selectedId.set(teacherId);
  }

  teaches(student: Student): boolean {
    return this.studentsStore.teacherOf(student).id === this.teacher().id;
  }
}
