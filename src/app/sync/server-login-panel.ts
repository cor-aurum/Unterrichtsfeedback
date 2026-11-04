import { Component, computed, input, output, signal } from '@angular/core';
import { PackedCode, ServerLogin, serverApi, unpackCode } from './server-folder';

export type LoginMode = 'invite' | 'login' | 'reset';

/** Ergebnis: angemeldet, und auf welchem Weg */
export interface Connected {
  login: ServerLogin;
  via: LoginMode;
}

/**
 * Anmelden am Server auf drei Wegen: Einladungscode einlösen (neues Konto mit Benutzername und Passwort), mit einem
 * vorhandenen Konto anmelden (z. B. auf einem weiteren Gerät) oder mit einem Reset-Code ein neues Passwort vergeben.
 * Einladungs- und Reset-Codes enthalten die Adresse des Servers.
 */
@Component({
  selector: 'app-server-login-panel',
  templateUrl: './server-login-panel.html',
  styleUrl: './server-login-panel.scss',
})
export class ServerLoginPanel {
  /** Der eigene Lehrer dieser App; ihn bekommt ein Konto aus einer Einladung von der Kommandozeile. */
  readonly teacherId = input.required<string>();
  readonly connected = output<Connected>();

  protected readonly mode = signal<LoginMode>('invite');
  protected readonly codeText = signal('');
  protected readonly code = computed<PackedCode | null>(() => unpackCode(this.codeText()));
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected setMode(mode: LoginMode): void {
    this.mode.set(mode);
    this.error.set(null);
  }

  /** Ein eingefügter Reset-Code wechselt von selbst zu „Passwort vergessen“ und umgekehrt. */
  protected setCode(text: string): void {
    this.codeText.set(text);
    const kind = this.code()?.kind;
    if (kind === 'reset' && this.mode() === 'invite') this.mode.set('reset');
    if (kind === 'invite' && this.mode() === 'reset') this.mode.set('invite');
  }

  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    const field = (key: string) => String(form.get(key) ?? '');
    const mode = this.mode();
    const code = this.code();
    if (mode !== 'login' && !code) {
      this.error.set('Der Code ist unvollständig. Bitte den ganzen Code („UF1.…“) einfügen.');
      return;
    }
    if (mode !== 'login' && field('password') !== field('repeat')) {
      this.error.set('Die beiden Passwörter stimmen nicht überein.');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      const login =
        mode === 'invite'
          ? await serverApi.redeem(code!, field('username'), field('password'), this.teacherId())
          : mode === 'reset'
            ? await serverApi.reset(code!, field('password'))
            : await serverApi.login(field('url'), field('username'), field('password'));
      this.connected.emit({ login, via: mode });
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
    }
  }
}
