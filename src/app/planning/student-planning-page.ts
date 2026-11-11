import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { formatShortDate, Student, Teacher } from '../model';
import { ServerSync } from '../sync/server-sync';
import { planningLabels, shortName } from './planning-labels';
import { PlanningSlot, StudentPlanning } from './student-planning';

/** Ohne Berührung geht die Ansicht nach dieser Zeit zurück zur Namensliste, falls jemand „Fertig“ vergisst. */
const IDLE_MS = 90_000;

interface PlanningDay {
  date: string;
  label: string;
  slots: PlanningSlot[];
}

/**
 * Die Ansicht am Tablet: Name antippen, Zeiten antippen, „Fertig“. Wer seinen Lehrer selbst wählt, tippt vorher
 * auf ihn. Mehr gibt es nicht; die übrige App ist ausgeblendet, bis die Lehrkraft die Planung beendet.
 */
@Component({
  selector: 'app-student-planning-page',
  templateUrl: './student-planning-page.html',
  styleUrl: './student-planning-page.scss',
  host: { '(pointerdown)': 'touched()', '(keydown)': 'touched()' },
})
export class StudentPlanningPage {
  protected readonly planning = inject(StudentPlanning);
  private readonly sync = inject(ServerSync);
  /** Mit Server, aber gerade ohne Abgleich: Eintragungen bleiben vorerst auf diesem Tablet. */
  protected readonly offline = computed(() => ['reconnect', 'initial', 'conflict', 'error'].includes(this.sync.status()));
  /** Während eine Zeit eingetragen wird (mit Server: abgleichen und speichern) */
  protected readonly busy = signal(false);
  /** z. B. „Diese Zeit wurde gerade an einem anderen Tablet vergeben.“ */
  protected readonly notice = signal<string | null>(null);
  protected readonly session = this.planning.session;
  protected readonly teachers = this.planning.teachers;
  protected readonly teacherNames = computed(() => this.teachers().map((t) => t.name).join(', '));
  protected readonly linkedNames = computed(() => this.planning.linkedTeachers().map((t) => t.name).join(', '));

  protected readonly studentId = signal<string | null>(null);
  protected readonly student = computed(() => this.planning.students().find((s) => s.id === this.studentId()) ?? null);
  /** Wer seinen Lehrer noch wählt: der Lehrer, dessen Zeiten gerade zu sehen sind */
  protected readonly browsingTeacherId = signal<string | null>(null);
  /** Muss die Person erst ihren Lehrer wählen? */
  protected readonly choosing = computed(() => {
    const student = this.student();
    return !!student && this.planning.needsTeacher(student);
  });
  /** Lehrer, dessen Zeiten die Person sieht: ihr eigener oder der gerade angesehene; `null`: erst wählen */
  protected readonly teacher = computed<Teacher | null>(() => {
    const student = this.student();
    if (!student) return null;
    if (!this.choosing()) return this.planning.teacherOf(student);
    const teachers = this.teachers();
    // Bei nur einer Lehrkraft gibt es nichts zu wählen.
    return teachers.length === 1 ? teachers[0] : (teachers.find((t) => t.id === this.browsingTeacherId()) ?? null);
  });
  /** Kurz nach „Fertig“ auf der Namensliste, z. B. „Gespeichert, Anna!“ */
  protected readonly thanks = signal<string | null>(null);
  protected readonly formatShortDate = formatShortDate;

  protected readonly days = computed<PlanningDay[]>(() => {
    const student = this.student();
    const teacher = this.teacher();
    if (!student || !teacher) return [];
    const byDate = new Map<string, PlanningSlot[]>();
    for (const slot of this.planning.slotsFor(student, teacher)) {
      byDate.set(slot.date, [...(byDate.get(slot.date) ?? []), slot]);
    }
    return [...byDate].map(([date, slots]) => ({ date, label: dayLabel(date), slots }));
  });
  /** Erklärt das ⚠ nur, wenn es vorkommt */
  protected readonly hasGroupClashes = computed(() => this.days().some((day) => day.slots.some((slot) => slot.groupClash)));
  protected readonly remaining = computed(() => {
    const student = this.student();
    return student ? this.planning.remaining(student) : 0;
  });
  protected readonly chosen = computed(() => {
    const student = this.student();
    return student ? this.planning.count(student) : 0;
  });

  private idleTimer?: ReturnType<typeof setTimeout>;
  private thanksTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    // Vergebene Zeiten anderer Tablets sollen schnell verschwinden.
    this.sync.fastPolling.set(true);
    inject(DestroyRef).onDestroy(() => {
      this.sync.fastPolling.set(false);
      clearTimeout(this.idleTimer);
      clearTimeout(this.thanksTimer);
    });
  }

  protected choose(student: Student): void {
    this.thanks.set(null);
    this.notice.set(null);
    this.browsingTeacherId.set(null);
    this.studentId.set(student.id);
    window.scrollTo({ top: 0 });
  }

  /** Erst ansehen; fest wird der Lehrer mit dem ersten Termin. */
  protected chooseTeacher(teacher: Teacher | null): void {
    this.browsingTeacherId.set(teacher?.id ?? null);
    window.scrollTo({ top: 0 });
  }

  /** Antippen wählt eine freie Zeit oder gibt eine eigene wieder frei. */
  protected async toggle(slot: PlanningSlot): Promise<void> {
    const student = this.student();
    const teacher = this.teacher();
    if (!student || !teacher || this.busy()) return;
    this.notice.set(null);
    if (slot.own) {
      if (slot.appointmentId) this.planning.unbook(slot.appointmentId);
      return;
    }
    this.busy.set(true);
    try {
      const result = await this.planning.book(student, teacher, slot);
      if (result === 'rejected') this.notice.set('Diese Zeit wurde gerade vergeben. Bitte wähle eine andere.');
    } finally {
      this.busy.set(false);
    }
  }

  protected done(): void {
    const student = this.student();
    this.notice.set(null);
    this.studentId.set(null);
    this.browsingTeacherId.set(null);
    window.scrollTo({ top: 0 });
    if (!student) return;
    this.thanks.set(`Gespeichert, ${firstName(student.name)}!`);
    clearTimeout(this.thanksTimer);
    this.thanksTimer = setTimeout(() => this.thanks.set(null), 4000);
  }

  /** Mit PIN nur, wer sie kennt; ohne nach Rückfrage */
  protected stop(): void {
    const pin = this.session()?.pin ?? '';
    if (pin) {
      const entered = prompt('PIN zum Beenden der Planung:');
      if (entered === null) return;
      if (entered.trim() !== pin) {
        alert('Die PIN stimmt nicht.');
        return;
      }
    } else if (!confirm('Planung beenden und zur App zurückkehren?')) {
      return;
    }
    this.planning.stop();
  }

  protected touched(): void {
    clearTimeout(this.idleTimer);
    if (this.studentId()) this.idleTimer = setTimeout(() => this.done(), IDLE_MS);
  }

  /** Kurzname in der Namensliste, je Person eindeutig (siehe `planningLabels`) */
  protected readonly shortNames = computed(() => planningLabels(this.planning.students(), shortName));
  /** Voller Name über den Zeiten, bei Gleichnamigen mit „sen.“/„jun.“ */
  protected readonly fullNames = computed(() => planningLabels(this.planning.students(), (s) => s.name.trim()));

  protected countText(student: Student): string {
    const max = this.session()?.maxPerStudent ?? 0;
    const count = this.planning.count(student);
    return count >= max ? 'fertig ✓' : `${count} von ${max}`;
  }

  protected isDone(student: Student): boolean {
    return this.planning.remaining(student) === 0;
  }
}

/** „Montag, 9. November“ */
function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0];
}
