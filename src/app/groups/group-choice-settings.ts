import { Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { ConfigStore } from '../config.store';
import { GroupsStore } from '../groups.store';
import { Group, groupMembers } from '../model';
import { ReportPeriod } from '../report-period';
import { StudentLabelPipe } from '../student-label.pipe';
import { StudentsStore } from '../students.store';
import { GroupChoice } from './group-choice';

/**
 * In der Gruppenplanung: Gruppen zur Wahl anbieten, die Wahl am Tablet starten und sehen, wer noch keine Gruppe
 * gewählt hat. Die Einstellung gehört zum Berichtszeitraum; über seinen Download-Link wählen die Personen auf ihrer
 * eigenen Seite.
 */
@Component({
  selector: 'app-group-choice-settings',
  imports: [StudentLabelPipe],
  template: `
    <section class="card group-choice">
      <h2>Gruppe selbst wählen</h2>
      <p class="muted">
        Jede Person wählt selbst genau eine der angehakten Gruppen – am Tablet oder auf ihrer Seite des Download-Links
        (Konfiguration → Allgemein → beim Zeitraum). Bis zum Beenden kann sie wechseln. Automatische Gruppen stehen
        nicht zur Wahl.
      </p>
      @if (candidates().length === 0) {
        <p class="muted">Lege zuerst Gruppen an.</p>
      } @else {
        <div class="choices">
          @for (group of candidates(); track group.id) {
            <label>
              <input type="checkbox" [checked]="selected().includes(group.id)" (change)="toggle(group)" />
              {{ choice.label(group) }}
              <span class="muted small">({{ memberCount(group) }})</span>
            </label>
          }
        </div>
        <div class="row actions">
          @if (running()) {
            <button [disabled]="selected().length < 2 || !changed()" (click)="save()">Auswahl speichern</button>
            <button class="secondary" (click)="stop()">Gruppenwahl beenden</button>
          } @else {
            <button [disabled]="selected().length < 2" (click)="save()">Gruppenwahl starten</button>
            @if (selected().length < 2) {
              <span class="muted small">Mindestens zwei Gruppen anhaken.</span>
            }
          }
        </div>
      }

      @if (running()) {
        <div class="tablet row">
          <input type="text" inputmode="numeric" autocomplete="off" placeholder="PIN zum Beenden (optional)" #pin />
          <button class="secondary" (click)="choice.startTablet(periodId(), pin.value)">Am Tablet wählen lassen</button>
        </div>

        <h3>
          Noch nicht gewählt: {{ missing().length }} von {{ total() }}
          @if (missing().length === 0) {
            <span class="done">✓ alle</span>
          }
        </h3>
        @if (missing().length > 0) {
          <ul class="missing">
            @for (student of missing(); track student.id) {
              <li>{{ student | studentLabel }}</li>
            }
          </ul>
          <div class="row">
            <button class="secondary small-button" (click)="copyMissing()">Namen kopieren</button>
            @if (copied()) {
              <span class="muted small">Kopiert.</span>
            }
          </div>
        }
      }
    </section>
  `,
  styles: `
    .group-choice h3 {
      margin: 1rem 0 0.5rem;
    }

    .choices {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem 1.25rem;
      margin: 0.5rem 0;

      label {
        display: flex;
        align-items: center;
        gap: 0.35rem;
      }
    }

    .actions,
    .tablet {
      margin-top: 0.75rem;
    }

    .tablet input {
      flex: 1 1 12rem;
      max-width: 16rem;
    }

    .done {
      margin-left: 0.5rem;
      color: var(--state-done);
    }

    .missing {
      display: flex;
      flex-wrap: wrap;
      gap: 0.3rem 0.5rem;
      margin: 0 0 0.5rem;
      padding: 0;
      list-style: none;

      li {
        padding: 0.15rem 0.6rem;
        border-radius: 999px;
        background: var(--bg);
        font-size: 0.9rem;
      }
    }
  `,
})
export class GroupChoiceSettings {
  protected readonly choice = inject(GroupChoice);
  private readonly configStore = inject(ConfigStore);
  private readonly groupsStore = inject(GroupsStore);
  private readonly studentsStore = inject(StudentsStore);
  private readonly reportPeriod = inject(ReportPeriod);

  protected readonly periodId = computed(() => this.reportPeriod.period().id);
  private readonly settings = computed(() => this.reportPeriod.period().groupChoice);
  protected readonly running = computed(() => !!this.settings());
  /** Gruppen des Zeitraums ohne die automatischen, nach Namen */
  protected readonly candidates = computed(() =>
    this.groupsStore
      .groups()
      .filter((g) => !g.auto)
      .sort((a, b) => this.choice.label(a).localeCompare(this.choice.label(b), 'de')),
  );
  protected readonly selected = linkedSignal<string[]>(() => this.settings()?.groupIds ?? []);
  protected readonly changed = computed(
    () => this.selected().slice().sort().join() !== (this.settings()?.groupIds ?? []).slice().sort().join(),
  );
  protected readonly missing = computed(() => (this.running() ? this.choice.missing(this.periodId()) : []));
  protected readonly total = computed(() => this.choice.students(this.periodId()).length);
  protected readonly copied = signal(false);

  protected memberCount(group: Group): number {
    return groupMembers(group, this.studentsStore.allStudents()).length;
  }

  protected toggle(group: Group): void {
    this.selected.update((ids) => (ids.includes(group.id) ? ids.filter((id) => id !== group.id) : [...ids, group.id]));
  }

  protected save(): void {
    this.configStore.setGroupChoice(this.periodId(), { groupIds: this.selected() });
  }

  protected stop(): void {
    if (!confirm('Gruppenwahl beenden? Die gewählten Gruppen bleiben, wählen geht danach aber nicht mehr.')) return;
    this.configStore.setGroupChoice(this.periodId(), null);
    if (this.choice.tablet()?.periodId === this.periodId()) this.choice.stopTablet();
  }

  /** Namen der Fehlenden, eine Zeile je Person, z. B. für eine Nachricht */
  protected copyMissing(): void {
    const text = this.missing()
      .map((s) => s.name)
      .join('\n');
    navigator.clipboard?.writeText(text).then(
      () => this.copied.set(true),
      () => undefined,
    );
  }
}
