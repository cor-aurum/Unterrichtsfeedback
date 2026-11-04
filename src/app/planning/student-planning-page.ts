import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { formatShortDate, Student } from '../model';
import { PlanningSlot, StudentPlanning } from './student-planning';

/** Ohne Berührung geht die Ansicht nach dieser Zeit zurück zur Namensliste, falls jemand „Fertig“ vergisst. */
const IDLE_MS = 90_000;

interface PlanningDay {
  date: string;
  label: string;
  slots: PlanningSlot[];
}

/**
 * Die Ansicht am Tablet: Name antippen, Zeiten antippen, „Fertig“. Mehr gibt es nicht; die übrige App ist
 * ausgeblendet, bis die Lehrkraft die Planung beendet.
 */
@Component({
  selector: 'app-student-planning-page',
  templateUrl: './student-planning-page.html',
  styleUrl: './student-planning-page.scss',
  host: { '(pointerdown)': 'touched()', '(keydown)': 'touched()' },
})
export class StudentPlanningPage {
  protected readonly planning = inject(StudentPlanning);
  protected readonly session = this.planning.session;
  protected readonly teacher = this.planning.teacher;

  protected readonly studentId = signal<string | null>(null);
  protected readonly student = computed(() => this.planning.students().find((s) => s.id === this.studentId()) ?? null);
  /** Kurz nach „Fertig“ auf der Namensliste, z. B. „Gespeichert, Anna!“ */
  protected readonly thanks = signal<string | null>(null);
  protected readonly formatShortDate = formatShortDate;

  protected readonly days = computed<PlanningDay[]>(() => {
    const student = this.student();
    if (!student) return [];
    const byDate = new Map<string, PlanningSlot[]>();
    for (const slot of this.planning.slotsFor(student)) byDate.set(slot.date, [...(byDate.get(slot.date) ?? []), slot]);
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
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.idleTimer);
      clearTimeout(this.thanksTimer);
    });
  }

  protected choose(student: Student): void {
    this.thanks.set(null);
    this.studentId.set(student.id);
    window.scrollTo({ top: 0 });
  }

  /** Antippen wählt eine freie Zeit oder gibt eine eigene wieder frei. */
  protected toggle(slot: PlanningSlot): void {
    const student = this.student();
    if (!student) return;
    if (slot.own) {
      if (slot.appointmentId) this.planning.unbook(slot.appointmentId);
      return;
    }
    this.planning.book(student, slot);
  }

  protected done(): void {
    const student = this.student();
    this.studentId.set(null);
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
    if (this.studentId()) this.idleTimer = setTimeout(() => this.studentId.set(null), IDLE_MS);
  }

  protected shortName(student: Student): string {
    const [first, ...rest] = student.name.trim().split(/\s+/);
    return rest.length ? `${first} ${rest.at(-1)![0]}.` : first;
  }

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
