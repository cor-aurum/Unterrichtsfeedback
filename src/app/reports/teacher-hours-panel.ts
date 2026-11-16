import { Component, computed, inject, linkedSignal } from '@angular/core';
import { ConfigStore } from '../config.store';
import { csvBlob } from '../csv';
import { GroupsStore } from '../groups.store';
import { formatShortDate, ReportPeriodEntry } from '../model';
import { ReportPeriod } from '../report-period';
import { safeFileName, saveFile } from '../save-file';
import { StudentsStore } from '../students.store';
import { hoursText, teacherHours, TeacherHours } from './teacher-hours';

/**
 * Auswertung nach einem Berichtszeitraum: Wie viel Unterricht hat jede Lehrkraft gegeben – Anzahl und Zeit, getrennt
 * nach Einzel- und Gruppenunterricht, als Tabelle und zum Herunterladen für Excel.
 */
@Component({
  selector: 'app-teacher-hours-panel',
  template: `
    <section class="card">
      <h2>Auswertung: Unterricht je Lehrkraft</h2>
      <p class="muted">
        Alle Stunden im Berichtszeitraum – von Hand erfasste und von selbst begonnene. Gezählt wird bei der Lehrkraft,
        die die Stunde gegeben hat. Gelöschte (ausgefallene) Stunden zählen nicht.
      </p>
      <label class="period">
        Berichtszeitraum
        <select (change)="periodId.set(valueOf($event))">
          @for (period of periods(); track period.id) {
            <option [value]="period.id" [selected]="period.id === periodId()">{{ label(period) }}</option>
          }
        </select>
      </label>
      @if (rows().length > 0) {
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th rowspan="2">Lehrkraft</th>
                <th colspan="2">Einzelunterricht</th>
                <th colspan="2">Gruppenunterricht</th>
                <th colspan="2">Gesamt</th>
              </tr>
              <tr>
                <th>Stunden</th>
                <th>Zeit</th>
                <th>Stunden</th>
                <th>Zeit</th>
                <th>Stunden</th>
                <th>Zeit</th>
              </tr>
            </thead>
            <tbody>
              @for (row of rows(); track row.teacher.id) {
                <tr>
                  <td>
                    {{ row.teacher.name }}
                    @if (row.teacher.inactiveSince) {
                      <span class="muted small">(deaktiviert)</span>
                    }
                  </td>
                  <td>{{ row.individual.count }}</td>
                  <td>{{ hours(row.individual.minutes) }}</td>
                  <td>{{ row.group.count }}</td>
                  <td>{{ hours(row.group.minutes) }}</td>
                  <td><strong>{{ row.total.count }}</strong></td>
                  <td><strong>{{ hours(row.total.minutes) }}</strong></td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (withoutDuration() > 0) {
          <p class="muted small">
            {{ withoutDuration() === 1 ? 'Eine Stunde hat' : withoutDuration() + ' Stunden haben' }} keine Länge (ohne
            Uhrzeit angelegt) und {{ withoutDuration() === 1 ? 'zählt' : 'zählen' }} mit der Standardlänge von
            {{ defaultMinutes() }} Minuten.
          </p>
        }
        <div class="row">
          <button class="secondary" (click)="download()">Als Tabelle (Excel/CSV) herunterladen</button>
        </div>
      } @else {
        <p class="muted">In diesem Berichtszeitraum gibt es keine Lehrkräfte.</p>
      }
    </section>
  `,
  styles: `
    .period {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      margin: 0.5rem 0 0.75rem;
    }

    .table-scroll {
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
    }

    th,
    td {
      padding: 0.35rem 0.6rem;
      border-bottom: 1px solid var(--border);
      text-align: right;
      white-space: nowrap;
    }

    th:first-child,
    td:first-child {
      text-align: left;
    }

    thead th {
      color: var(--muted);
      font-weight: 600;
    }

    .row {
      margin-top: 0.75rem;
    }
  `,
})
export class TeacherHoursPanel {
  private readonly config = inject(ConfigStore).config;
  private readonly students = inject(StudentsStore).allStudents;
  private readonly groups = inject(GroupsStore).allGroups;
  private readonly reportPeriod = inject(ReportPeriod);

  /** Neueste zuerst; vorgewählt ist der oben gewählte Zeitraum */
  protected readonly periods = computed(() =>
    [...this.config().reportPeriods.filter((p) => !p.placeholder)].sort((a, b) => b.from.localeCompare(a.from)),
  );
  protected readonly periodId = linkedSignal(() => this.reportPeriod.period().id);
  protected readonly rows = computed<TeacherHours[]>(() =>
    teacherHours(this.config(), this.periodId(), this.students(), this.groups()),
  );
  protected readonly withoutDuration = computed(() => this.rows().reduce((sum, row) => sum + row.withoutDuration, 0));
  protected readonly defaultMinutes = computed(() => this.config().calendar.defaultDurationMinutes);
  protected readonly hours = hoursText;

  protected valueOf(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  protected label(period: ReportPeriodEntry): string {
    return `${period.name} (${formatShortDate(period.from)} – ${formatShortDate(period.to)})`;
  }

  /** Tabelle für Excel: je Lehrkraft eine Zeile, Zeiten in Minuten und Stunden */
  protected download(): void {
    const period = this.config().reportPeriods.find((p) => p.id === this.periodId());
    const header = [
      'Lehrkraft',
      'Einzelstunden',
      'Einzelunterricht (Minuten)',
      'Gruppenstunden',
      'Gruppenunterricht (Minuten)',
      'Stunden gesamt',
      'Minuten gesamt',
      'Zeit gesamt',
    ];
    const lines = this.rows().map((row) => [
      row.teacher.name + (row.teacher.inactiveSince ? ' (deaktiviert)' : ''),
      String(row.individual.count),
      String(row.individual.minutes),
      String(row.group.count),
      String(row.group.minutes),
      String(row.total.count),
      String(row.total.minutes),
      hoursText(row.total.minutes),
    ]);
    void saveFile(`Unterricht_je_Lehrkraft_${safeFileName(period?.name ?? 'Zeitraum')}.csv`, csvBlob([header, ...lines]));
  }
}
