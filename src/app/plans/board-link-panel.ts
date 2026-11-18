import { Component, computed, inject, input, signal } from '@angular/core';
import { formatShortDate, ReportPeriodEntry } from '../model';
import { demoMode } from '../stored-signal';
import { PlanLinkState, ServerLogin, serverApi } from '../sync/server-folder';
import { ServerSync } from '../sync/server-sync';
import { BoardPublisher } from './board-publisher';
import { planServerId, realServerLogin } from './plan-access';

/**
 * Aushang-Link eines Berichtszeitraums: eine Seite mit allen Terminen für ein zentrales Tablet, das Schüler:innen
 * selbst bedienen. Sie zeigt nur Termine mit Kurznamen und lässt nichts ändern.
 */
@Component({
  selector: 'app-board-link-panel',
  templateUrl: './board-link-panel.html',
  styleUrl: './plan-link-panel.scss',
})
export class BoardLinkPanel {
  readonly period = input.required<ReportPeriodEntry>();
  private readonly publisher = inject(BoardPublisher);
  /** Im Demomodus die echte Anmeldung, wie beim Download-Link */
  protected readonly login = demoMode ? signal(realServerLogin()).asReadonly() : inject(ServerSync).login;
  protected readonly demoMode = demoMode;

  protected readonly state = signal<PlanLinkState | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);
  protected readonly expires = computed(() => {
    const date = this.state()?.expiresAt;
    return date ? formatShortDate(date) : '';
  });

  /** Geladen wird erst beim Aufklappen, damit die Einstellungen nicht für jeden Zeitraum den Server fragen. */
  protected toggled(event: Event): void {
    if ((event.target as HTMLDetailsElement).open && !this.state()) void this.load();
  }

  private async load(): Promise<void> {
    await this.action(async (login) => this.state.set(await serverApi.board(login, this.serverId(login))));
  }

  protected async create(): Promise<void> {
    await this.action(async (login) => {
      await serverApi.newBoardAddress(login, this.serverId(login));
      await this.publisher.publish(login, this.period(), true);
      this.state.set(await serverApi.board(login, this.serverId(login)));
    });
  }

  protected async renew(): Promise<void> {
    if (!confirm('Der bisherige Aushang-Link gilt danach nicht mehr; das Tablet braucht den neuen. Neuen Link erzeugen?')) return;
    await this.create();
  }

  protected async remove(): Promise<void> {
    if (!confirm('Aushang-Link löschen? Das Tablet zeigt danach keine Termine mehr.')) return;
    await this.action(async (login) => {
      await serverApi.deleteBoard(login, this.serverId(login));
      this.state.set(await serverApi.board(login, this.serverId(login)));
    });
  }

  /** Schickt die Termine sofort, statt auf den nächsten Abgleich zu warten. */
  protected async refresh(): Promise<void> {
    await this.action(async (login) => {
      await this.publisher.publish(login, this.period(), true);
      this.state.set(await serverApi.board(login, this.serverId(login)));
      this.message.set('Der Aushang ist auf dem neuesten Stand.');
    });
  }

  protected copy(text: string): void {
    navigator.clipboard?.writeText(text).catch(() => undefined);
    this.message.set('Link kopiert.');
  }

  protected selectAll(event: Event): void {
    (event.target as HTMLInputElement).select();
  }

  protected formatTime(iso: string): string {
    return new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  }

  private serverId(login: ServerLogin): string {
    return planServerId(this.period(), login);
  }

  private async action(run: (login: ServerLogin) => Promise<void>): Promise<void> {
    const login = this.login();
    if (!login) return;
    this.busy.set(true);
    this.error.set(null);
    this.message.set(null);
    try {
      await run(login);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
    }
  }
}
