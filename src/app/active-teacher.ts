import { computed, inject, Injectable } from '@angular/core';
import { ConfigStore } from './config.store';
import { isActiveTeacher, Student, Teacher, today } from './model';
import { storedSignal } from './stored-signal';
import { StudentsStore } from './students.store';
import { ServerSync } from './sync/server-sync';
import { themeFrom } from './theme';

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

  /**
   * Mit Server nur die Lehrkräfte, mit denen der angemeldete Lehrer mindestens einen Berichtszeitraum teilt (und er
   * selbst); ohne Server alle. Die übrigen bleiben in den Daten, erscheinen aber nirgends zur Auswahl.
   */
  readonly visibleTeachers = computed<Teacher[]>(() => {
    const config = this.config();
    const active = config.teachers.filter(isActiveTeacher);
    const me = this.login()?.teacherId;
    if (!me) return active;
    const shared = new Set([me, ...config.reportPeriods.filter((p) => p.teacherIds.includes(me)).flatMap((p) => p.teacherIds)]);
    return active.filter((teacher) => shared.has(teacher.id));
  });

  /**
   * Aktive Lehrkräfte, die in keinem laufenden oder künftigen Berichtszeitraum stehen und die man in einen aufnehmen
   * kann. Mit Server kennt die App nur die eigenen Zeiträume; dort zählen deshalb nur die ohne Zeitraum angelegten
   * (`Teacher.withoutPeriod`) und die sichtbaren, z. B. aus einem gemeinsamen früheren Zeitraum.
   */
  readonly teachersWithoutPeriod = computed<Teacher[]>(() => {
    const config = this.config();
    const current = new Set(config.reportPeriods.filter((p) => p.to >= today()).flatMap((p) => p.teacherIds));
    const visible = new Set(this.visibleTeachers().map((t) => t.id));
    return config.teachers
      .filter(isActiveTeacher)
      .filter((teacher) => !current.has(teacher.id))
      .filter((teacher) => teacher.withoutPeriod || visible.has(teacher.id));
  });

  /** Farbe der aktiven Lehrkraft, sonst die allgemeine */
  readonly color = computed(() => this.teacher().themeColor ?? this.config().themeColor);
  /** Farben für App und PDFs aus der Farbe der aktiven Lehrkraft */
  readonly theme = computed(() => themeFrom(this.color()));

  isVisible(teacherId: string): boolean {
    return this.visibleTeachers().some((teacher) => teacher.id === teacherId);
  }

  /** Mit Server angemeldet: Der Lehrer steht fest. */
  readonly fixed = computed(() => !!this.login());

  /**
   * Fehlt der gewählte Lehrer (noch keiner gewählt oder gelöscht), gilt der erste – auch mit Server, solange der
   * angemeldete noch nicht in der Konfiguration steht.
   */
  readonly teacher = computed<Teacher>(() => {
    const id = this.login()?.teacherId ?? this.selectedId();
    const teachers = this.config().teachers;
    // Ohne Server gilt eine deaktivierte Lehrkraft nicht mehr als gewählt.
    const chosen = teachers.find((t) => t.id === id && (this.login() || isActiveTeacher(t)));
    return chosen ?? teachers.find(isActiveTeacher) ?? teachers[0];
  });

  /** Mit Server ohne Wirkung; nach dem Abmelden gilt wieder die eigene Wahl. */
  select(teacherId: string): void {
    this.selectedId.set(teacherId);
  }

  teaches(student: Student): boolean {
    return this.studentsStore.teacherOf(student).id === this.teacher().id;
  }
}
