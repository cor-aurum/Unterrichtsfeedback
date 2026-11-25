import { Component, inject, signal } from '@angular/core';
import { formatShortDate } from '../model';
import { isNativeApp } from '../save-file';
import { serverApi, SharedFileEntry } from '../sync/server-folder';
import { ServerSync } from '../sync/server-sync';
import { HelpLink } from '../help/help-link';
import { SharedFiles } from './shared-files';

/**
 * Unter „Export & Sicherung“: PDFs, die andere Lehrkräfte für mich bereitgestellt haben (öffnen, drucken, versenden,
 * entfernen), und die, die ich bereitgestellt habe, mit „geöffnet“ je Empfängerin. Nur mit Server.
 */
@Component({
  selector: 'app-shared-files-panel',
  imports: [HelpLink],
  template: `
    @if (sync.login() && (files.state().received.length > 0 || files.state().sent.length > 0)) {
      <section class="card">
        <h2>Bereitgestellte PDFs<app-help-link topic="bereitstellen" label="PDFs bereitstellen" /></h2>
        @if (files.state().received.length > 0) {
          <h3>Für dich bereitgestellt</h3>
          <ul class="files">
            @for (file of files.state().received; track file.id) {
              <li [class.new]="!file.openedAt">
                <span class="grow">
                  <strong>{{ file.name }}</strong>
                  @if (!file.openedAt) {
                    <span class="badge-new">neu</span>
                  }
                  <span class="muted small">
                    von {{ name(file.from) }} · {{ time(file.createdAt) }} · {{ size(file) }} · bis {{ day(file.expiresAt) }}
                  </span>
                </span>
                <span class="row actions">
                  <button (click)="run(files.open(file))">Öffnen</button>
                  <button class="secondary" (click)="run(files.save(file))">{{ nativeApp ? 'Teilen' : 'Herunterladen' }}</button>
                  <button class="secondary" title="Aus deiner Liste nehmen" (click)="remove(file, false)">Erledigt</button>
                </span>
              </li>
            }
          </ul>
        }
        @if (files.state().sent.length > 0) {
          <h3>Von dir bereitgestellt</h3>
          <ul class="files">
            @for (file of files.state().sent; track file.id) {
              <li>
                <span class="grow">
                  <strong>{{ file.name }}</strong>
                  <span class="muted small">{{ time(file.createdAt) }} · {{ size(file) }} · bis {{ day(file.expiresAt) }}</span>
                  <span class="recipients small">
                    @for (recipient of file.to ?? []; track recipient.teacherId) {
                      <span [class.opened]="!!recipient.openedAt" [title]="recipient.openedAt ? 'geöffnet ' + time(recipient.openedAt) : 'noch nicht geöffnet'">
                        {{ recipient.openedAt ? '✓' : '○' }} {{ name(recipient.teacherId) }}{{ recipient.doneAt ? ' (erledigt)' : '' }}
                      </span>
                    }
                  </span>
                </span>
                <span class="row actions">
                  <button class="secondary" (click)="run(files.open(file))">Ansehen</button>
                  <button class="secondary" title="Für alle zurückziehen" (click)="remove(file, true)">Zurückziehen</button>
                </span>
              </li>
            }
          </ul>
          <p class="muted small">
            ✓ geöffnet, ○ noch nicht geöffnet, „erledigt“: aus der eigenen Liste genommen. Nach 30 Tagen löscht der
            Server die Dateien von selbst.
          </p>
        }
        @if (error() ?? files.error(); as text) {
          <p class="message error small">{{ text }}</p>
        }
      </section>
    }
  `,
  styles: `
    h3 {
      margin: 0.75rem 0 0.4rem;
      font-size: 1rem;
    }
    .files {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 0.6rem;
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    li.new {
      border-color: var(--primary);
      background: var(--primary-light);
    }
    .grow {
      display: flex;
      flex: 1 1 16rem;
      flex-direction: column;
      gap: 0.15rem;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .badge-new {
      align-self: flex-start;
      padding: 0 0.4rem;
      border-radius: 999px;
      background: var(--primary);
      color: white;
      font-size: 0.75rem;
    }
    .recipients {
      display: flex;
      flex-wrap: wrap;
      gap: 0.2rem 0.8rem;
      color: var(--muted);
    }
    .recipients .opened {
      color: var(--text);
    }
    .actions {
      flex-wrap: wrap;
    }
  `,
})
export class SharedFilesPanel {
  protected readonly files = inject(SharedFiles);
  protected readonly sync = inject(ServerSync);
  protected readonly nativeApp = isNativeApp;
  protected readonly error = signal<string | null>(null);
  private readonly usernames = signal(new Map<string, string>());
  protected readonly name = (teacherId: string | undefined) => this.files.teacherName(teacherId, this.usernames());

  constructor() {
    void this.files.load();
    const login = this.sync.login();
    if (login) {
      serverApi
        .accounts(login)
        .then((accounts) => this.usernames.set(new Map(accounts.map((a) => [a.teacherId, a.username]))))
        .catch(() => undefined);
    }
  }

  protected run(action: Promise<void>): void {
    this.error.set(null);
    action.catch((e) => this.error.set(e instanceof Error ? e.message : String(e)));
  }

  protected remove(file: SharedFileEntry, everyone: boolean): void {
    const question = everyone
      ? `„${file.name}“ für alle zurückziehen? Wer es noch nicht heruntergeladen hat, bekommt es dann nicht mehr.`
      : `„${file.name}“ als erledigt aus deiner Liste nehmen? Wer es bereitgestellt hat, sieht das.`;
    if (confirm(question)) this.run(this.files.remove(file));
  }

  protected time(iso: string): string {
    return new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
  }

  protected day(iso: string): string {
    return formatShortDate(iso.slice(0, 10));
  }

  protected size(file: SharedFileEntry): string {
    return file.size >= 1024 * 1024 ? `${(file.size / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(file.size / 1024))} kB`;
  }
}
