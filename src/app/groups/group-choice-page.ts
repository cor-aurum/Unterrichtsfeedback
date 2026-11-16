import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { planningLabels, shortName } from '../planning/planning-labels';
import { Group, Student } from '../model';
import { ServerSync } from '../sync/server-sync';
import { GroupChoice } from './group-choice';

/**
 * Die Gruppenwahl am Tablet: Name antippen, Gruppe antippen, fertig. Wie bei der Schüler-Planung ist die übrige App
 * ausgeblendet, bis die Lehrkraft die Wahl beendet.
 */
@Component({
  selector: 'app-group-choice-page',
  template: `
    @if (offline()) {
      <p class="sync-warning" role="status">
        Keine Verbindung zum Server: Deine Wahl ist auf diesem Tablet gespeichert und wird später übertragen.
      </p>
    }
    @if (groups().length === 0) {
      <header class="head">
        <h1>Gruppe wählen</h1>
        <p>Die Gruppenwahl ist beendet.</p>
      </header>
      <div class="bottom">
        <button (click)="choice.stopTablet()">Zur App zurückkehren</button>
      </div>
    } @else if (student(); as current) {
      <header class="head">
        <h1>{{ current.name }}</h1>
        <p>Welche Gruppe wählst du?</p>
      </header>
      @if (notice(); as text) {
        <p class="notice" role="alert">{{ text }}</p>
      }
      <div class="options">
        @for (group of groups(); track group.id) {
          <button class="option" [class.chosen]="chosenId() === group.id" [disabled]="busy()" (click)="choose(current, group)">
            <span class="name">{{ label(group) }}</span>
            @if (chosenId() === group.id) {
              <span class="state">✓ deine Gruppe</span>
            }
          </button>
        }
      </div>
      <div class="bottom">
        <button class="secondary" (click)="back()">Zurück zu den Namen</button>
      </div>
    } @else {
      <header class="head">
        <h1>Gruppe wählen</h1>
        <p>Tippe auf deinen Namen.</p>
      </header>
      @if (thanks(); as text) {
        <p class="thanks" role="status">{{ text }}</p>
      }
      <div class="names">
        @for (person of students(); track person.id) {
          <button class="name" [class.done]="!!choiceOf(person)" (click)="studentId.set(person.id)">
            <span>{{ labels().get(person.id) }}</span>
            <span class="state">{{ choiceOf(person) ? '✓ ' + label(choiceOf(person)!) : 'noch keine' }}</span>
          </button>
        }
      </div>
      <div class="bottom">
        <button class="secondary" (click)="stop()">Gruppenwahl beenden</button>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      max-width: 60rem;
      margin: 0 auto;
      padding: 1rem;
    }

    .head h1 {
      margin: 0;
    }

    .names,
    .options {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
      gap: 0.6rem;
      margin-top: 1rem;
    }

    .name,
    .option {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      min-height: 4rem;
      padding: 0.75rem;
      border-color: var(--border);
      background: var(--card);
      color: var(--text);
      font-size: 1.05rem;
      text-align: left;
      white-space: normal;
    }

    .name.done,
    .option.chosen {
      border-color: var(--state-done);
      background: var(--state-done-bg);
    }

    .option .name {
      font-weight: 600;
    }

    .state {
      color: var(--muted);
      font-size: 0.85rem;
    }

    .bottom {
      margin-top: 1.5rem;
    }

    .thanks,
    .notice {
      margin: 0.75rem 0 0;
      padding: 0.6rem 0.9rem;
      border-radius: 6px;
      background: var(--state-done-bg);
    }

    .notice {
      background: #fbe9e7;
      color: var(--danger);
    }

    .sync-warning {
      padding: 0.6rem 0.9rem;
      border-radius: 6px;
      background: #fff4d6;
    }
  `,
})
export class GroupChoicePage {
  protected readonly choice = inject(GroupChoice);
  private readonly sync = inject(ServerSync);
  private readonly periodId = computed(() => this.choice.tablet()?.periodId ?? '');
  protected readonly students = computed(() => this.choice.students(this.periodId()));
  protected readonly groups = computed(() => this.choice.offered(this.periodId()));
  protected readonly labels = computed(() => planningLabels(this.students(), shortName));
  protected readonly studentId = signal<string | null>(null);
  protected readonly student = computed(() => this.students().find((s) => s.id === this.studentId()) ?? null);
  protected readonly chosenId = computed(() => {
    const student = this.student();
    return student ? this.choiceOf(student)?.id : undefined;
  });
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly thanks = signal<string | null>(null);
  protected readonly offline = computed(() => ['reconnect', 'initial', 'conflict', 'error'].includes(this.sync.status()));

  constructor() {
    // Wahlen anderer Tablets sollen schnell zu sehen sein.
    this.sync.fastPolling.set(true);
    inject(DestroyRef).onDestroy(() => this.sync.fastPolling.set(false));
  }

  protected choiceOf(student: Student): Group | undefined {
    // Abhängig von den Gruppen, damit sich die Anzeige nach der Wahl aktualisiert
    this.groups();
    return this.choice.choiceOf(student.id, this.periodId());
  }

  protected label(group: Group): string {
    return this.choice.label(group);
  }

  protected async choose(student: Student, group: Group): Promise<void> {
    this.busy.set(true);
    this.notice.set(null);
    try {
      const result = await this.choice.chooseOnTablet(student.id, group.id, this.periodId());
      if (result === 'rejected') {
        this.notice.set('Das hat gerade nicht geklappt. Bitte noch einmal tippen.');
        return;
      }
      this.thanks.set(`${student.name.split(' ')[0]}: ${this.label(group)} ✓`);
      this.studentId.set(null);
      window.scrollTo({ top: 0 });
    } finally {
      this.busy.set(false);
    }
  }

  protected back(): void {
    this.notice.set(null);
    this.studentId.set(null);
  }

  /** Mit PIN nur, wer sie kennt; ohne nach Rückfrage */
  protected stop(): void {
    const pin = this.choice.tablet()?.pin ?? '';
    if (pin) {
      const entered = prompt('PIN zum Beenden der Gruppenwahl:');
      if (entered === null) return;
      if (entered.trim() !== pin) {
        alert('Die PIN stimmt nicht.');
        return;
      }
    } else if (!confirm('Gruppenwahl am Tablet beenden und zur App zurückkehren?')) {
      return;
    }
    this.choice.stopTablet();
  }
}
