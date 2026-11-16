import { Component, inject, signal } from '@angular/core';
import { serverApi } from './server-folder';
import { ServerSync } from './server-sync';

/** Mindestlänge wie auf dem Server (`auth.MinPasswordLength`) */
const MIN_PASSWORD_LENGTH = 8;

/**
 * Eigenes Passwort ändern, mit dem bisherigen. Dieses Gerät bleibt angemeldet; andere Geräte des Kontos meldet der
 * Server ab, dort meldet man sich mit dem neuen Passwort wieder an.
 */
@Component({
  selector: 'app-password-change',
  template: `
    <details class="password-change" #panel>
      <summary>Passwort ändern …</summary>
      <form class="fields" (submit)="$event.preventDefault(); change(current, next, repeat, panel)">
        <label>
          Bisheriges Passwort
          <input #current type="password" autocomplete="current-password" required />
        </label>
        <label>
          Neues Passwort (mindestens {{ minLength }} Zeichen)
          <input #next type="password" autocomplete="new-password" [minLength]="minLength" required />
        </label>
        <label>
          Neues Passwort wiederholen
          <input #repeat type="password" autocomplete="new-password" required />
        </label>
        <div class="row">
          <button type="submit" [disabled]="busy()">Passwort ändern</button>
        </div>
      </form>
      @if (error(); as text) {
        <p class="message error">{{ text }}</p>
      }
    </details>
    @if (done()) {
      <p class="message" role="status">
        Das Passwort ist geändert. Andere Geräte mit diesem Konto sind abgemeldet; dort meldest du dich mit dem neuen
        Passwort wieder an.
      </p>
    }
  `,
  styles: `
    .password-change {
      margin-top: 1rem;

      summary {
        cursor: pointer;
        color: var(--primary-text);
      }
    }

    .fields {
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
      max-width: 22rem;
      margin-top: 0.75rem;

      label {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
    }

    .message {
      margin-top: 0.75rem;
    }
  `,
})
export class PasswordChange {
  private readonly sync = inject(ServerSync);
  protected readonly minLength = MIN_PASSWORD_LENGTH;
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly done = signal(false);

  protected async change(
    current: HTMLInputElement,
    next: HTMLInputElement,
    repeat: HTMLInputElement,
    panel: HTMLDetailsElement,
  ): Promise<void> {
    const login = this.sync.login();
    if (!login) return;
    this.error.set(null);
    this.done.set(false);
    if (next.value.length < MIN_PASSWORD_LENGTH) {
      this.error.set(`Das neue Passwort braucht mindestens ${MIN_PASSWORD_LENGTH} Zeichen.`);
      return;
    }
    if (next.value !== repeat.value) {
      this.error.set('Die beiden neuen Passwörter stimmen nicht überein.');
      return;
    }
    this.busy.set(true);
    try {
      await serverApi.changePassword(login, current.value, next.value);
      current.value = next.value = repeat.value = '';
      panel.open = false;
      this.done.set(true);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
    }
  }
}
