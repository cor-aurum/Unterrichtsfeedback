import { Component, computed, inject, input, output, signal } from '@angular/core';
import { PdfFile } from '../pdf-export';
import { ReportPeriod } from '../report-period';
import { serverApi } from '../sync/server-folder';
import { ServerSync } from '../sync/server-sync';
import { SharedFiles } from './shared-files';

interface Colleague {
  teacherId: string;
  name: string;
}

/**
 * Formular „Bereitstellen für …“ unter einem PDF-Export: an alle Lehrkräfte des Berichtszeitraums oder an einzeln
 * gewählte mit Konto auf dem Server. Erst beim Bereitstellen entsteht das PDF (`build`).
 */
@Component({
  selector: 'app-share-pdf-panel',
  template: `
    <div class="share-panel">
      <strong>{{ title() }} bereitstellen</strong>
      <p class="muted small">
        Die gewählten Lehrkräfte finden das PDF unter „Export &amp; Sicherung“ und können es drucken oder versenden,
        auch ohne Zugriff auf die Daten. Es liegt 30 Tage auf dem Server; du siehst, wer es schon geöffnet hat.
      </p>
      @if (inPeriod()) {
        <label class="check">
          <input type="radio" name="share-target" [checked]="toAll()" (change)="toAll.set(true)" />
          An alle Lehrkräfte von „{{ periodName() }}“
        </label>
      }
      <label class="check">
        <input type="radio" name="share-target" [checked]="!toAll()" (change)="toAll.set(false)" />
        An einzelne Lehrkräfte:
      </label>
      @if (!toAll()) {
        <div class="colleagues">
          @for (colleague of colleagues(); track colleague.teacherId) {
            <label class="check">
              <input
                type="checkbox"
                [checked]="chosen().has(colleague.teacherId)"
                (change)="toggle(colleague.teacherId, $any($event.target).checked)"
              />
              {{ colleague.name }}
            </label>
          } @empty {
            <span class="muted small">{{ loading() ? 'Wird geladen …' : 'Keine andere Lehrkraft hat ein Konto.' }}</span>
          }
        </div>
      }
      @if (error(); as text) {
        <p class="message error small">{{ text }}</p>
      }
      <div class="row">
        <button [disabled]="busy() || (!toAll() && chosen().size === 0)" (click)="share()">
          {{ busy() ? 'Wird bereitgestellt …' : 'Bereitstellen' }}
        </button>
        <button class="secondary" [disabled]="busy()" (click)="closed.emit(null)">Abbrechen</button>
      </div>
    </div>
  `,
  styles: `
    .share-panel {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      margin-top: 0.75rem;
      padding: 0.75rem;
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .colleagues {
      display: flex;
      flex-wrap: wrap;
      gap: 0.3rem 1rem;
      padding-left: 1.6rem;
    }
    .check {
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }
    p {
      margin: 0;
    }
  `,
})
export class SharePdfPanel {
  /** z. B. „Feedback-PDF“ oder „Gruppen-PDF“ */
  readonly title = input.required<string>();
  readonly build = input.required<() => Promise<PdfFile>>();
  /** Nach dem Bereitstellen der Text für die Meldung, beim Abbrechen `null` */
  readonly closed = output<string | null>();

  private readonly sync = inject(ServerSync);
  private readonly sharedFiles = inject(SharedFiles);
  private readonly reportPeriod = inject(ReportPeriod);

  protected readonly periodName = computed(() => this.reportPeriod.period().name);
  /** An alle des Zeitraums darf nur, wer selbst darin eingetragen ist. */
  protected readonly inPeriod = computed(() => {
    const period = this.reportPeriod.period();
    return !period.placeholder && period.teacherIds.includes(this.sync.login()?.teacherId ?? '');
  });
  protected readonly toAll = signal(this.inPeriod());
  protected readonly colleagues = signal<Colleague[]>([]);
  protected readonly chosen = signal(new Set<string>());
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  private usernames = new Map<string, string>();

  constructor() {
    void this.loadColleagues();
  }

  protected toggle(teacherId: string, on: boolean): void {
    this.chosen.update((set) => {
      const next = new Set(set);
      if (on) next.add(teacherId);
      else next.delete(teacherId);
      return next;
    });
  }

  protected async share(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const file = await this.build()();
      const target = this.toAll() ? { period: this.reportPeriod.period().id } : { to: [...this.chosen()] };
      const recipients = await this.sharedFiles.share(file, target);
      const names = recipients.map((id) => this.sharedFiles.teacherName(id, this.usernames)).join(', ');
      this.closed.emit(`„${file.name}“ ist bereitgestellt für ${names}.`);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
    }
  }

  private async loadColleagues(): Promise<void> {
    const login = this.sync.login();
    if (!login) return;
    try {
      const accounts = await serverApi.accounts(login);
      this.usernames = new Map(accounts.map((a) => [a.teacherId, a.username]));
      this.colleagues.set(
        accounts
          .filter((a) => !a.disabled && a.teacherId !== login.teacherId)
          .map((a) => ({ teacherId: a.teacherId, name: this.sharedFiles.teacherName(a.teacherId, this.usernames) }))
          .sort((a, b) => a.name.localeCompare(b.name, 'de')),
      );
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.loading.set(false);
    }
  }
}
