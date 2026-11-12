import { Component, computed, inject, input, signal } from '@angular/core';
import { demoMode } from '../stored-signal';
import { formatShortDate, ReportPeriodEntry } from '../model';
import { safeFileName, saveFile } from '../save-file';
import { PlanLinkState, ServerLogin, serverApi } from '../sync/server-folder';
import { ServerSync } from '../sync/server-sync';
import { planServerId, realServerLogin } from './plan-access';
import { PlanPublisher } from './plan-publisher';
import { SelfBookingSettings } from './self-booking-settings';
import { ConfigStore } from '../config.store';

/**
 * Download-Link eines Berichtszeitraums in seinen Einstellungen: ein Link (mit QR-Code) für alle Personen darin.
 * Auf der Seite dahinter tippt jede Person auf ihren Namen und lädt ihren Plan als PDF oder Kalenderdatei herunter.
 * Verteilt wird der Link außerhalb der App, z. B. per Mail oder Aushang.
 */
@Component({
  selector: 'app-plan-link-panel',
  templateUrl: './plan-link-panel.html',
  styleUrl: './plan-link-panel.scss',
  imports: [SelfBookingSettings],
})
export class PlanLinkPanel {
  readonly period = input.required<ReportPeriodEntry>();
  private readonly publisher = inject(PlanPublisher);
  private readonly config = inject(ConfigStore).config;
  /** Im Demomodus die echte Anmeldung: Der Demo-Link wird beim Verlassen der Demo gelöscht. */
  protected readonly login = demoMode ? signal(realServerLogin()).asReadonly() : inject(ServerSync).login;
  protected readonly demoMode = demoMode;

  protected readonly state = signal<PlanLinkState | null>(null);
  protected readonly qrCode = signal<string | null>(null);
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
    await this.action(async (login) => this.show(await serverApi.plan(login, this.serverId(login))));
  }

  protected async create(): Promise<void> {
    await this.action(async (login) => {
      await serverApi.newPlanAddress(login, this.serverId(login));
      await this.publisher.publish(login, this.period(), true);
      this.show(await serverApi.plan(login, this.serverId(login)));
    });
  }

  protected async renew(): Promise<void> {
    const text =
      'Der bisherige Link und sein QR-Code gelten danach nicht mehr; wer ihn hat, braucht den neuen. Neuen Link erzeugen?';
    if (!confirm(text)) return;
    await this.create();
  }

  protected async remove(): Promise<void> {
    if (!confirm('Link löschen? Die Pläne sind danach unter keinem Link mehr abrufbar.')) return;
    await this.action(async (login) => {
      await serverApi.deletePlan(login, this.serverId(login));
      this.show(await serverApi.plan(login, this.serverId(login)));
    });
  }

  /** Schickt die Pläne sofort, statt auf den nächsten Abgleich zu warten. */
  protected async refresh(): Promise<void> {
    await this.action(async (login) => {
      await this.publisher.publish(login, this.period(), true);
      this.show(await serverApi.plan(login, this.serverId(login)));
      this.message.set('Die Pläne sind auf dem neuesten Stand.');
    });
  }

  /** Selbsteintragung gestartet, geändert oder beendet: Die Seiten zeigen es gleich, nicht erst nach dem Abgleich. */
  protected async bookingChanged(): Promise<void> {
    await this.action(async (login) => {
      // Die Einstellung steht schon in der Konfiguration, der Eingang `period` erst nach dem nächsten Zeichnen.
      const period = this.config().reportPeriods.find((p) => p.id === this.period().id) ?? this.period();
      await this.publisher.publish(login, period);
      this.show(await serverApi.plan(login, this.serverId(login)));
    });
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

  private show(state: PlanLinkState): void {
    this.state.set(state);
    this.qrCode.set(null);
    if (state.url) void this.renderQrCode(state.url);
  }

  private async renderQrCode(url: string): Promise<void> {
    try {
      const code = await qrDataUrl(url);
      if (this.state()?.url === url) this.qrCode.set(code);
    } catch (e) {
      console.error('QR-Code nicht erzeugt', e);
      this.error.set(`Der QR-Code ließ sich nicht erzeugen (${e instanceof Error ? e.message : String(e)}). Bitte die Seite neu laden.`);
    }
  }

  /** A4-Seite zum Aushängen oder Verschicken: Zeitraum, QR-Code, Link und eine kurze Anleitung */
  protected async qrPdf(): Promise<void> {
    const [state, code] = [this.state(), this.qrCode()];
    if (!state?.url || !code) return;
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const period = this.period();
    doc.setFont('helvetica', 'bold').setFontSize(24).text(period.name, 105, 35, { align: 'center' });
    doc.setFont('helvetica', 'normal').setFontSize(13);
    doc.text(`${formatShortDate(period.from)} – ${formatShortDate(period.to)}`, 105, 45, { align: 'center' });
    doc.setFontSize(16).text('Deine Termine zum Herunterladen', 105, 65, { align: 'center' });
    doc.addImage(code, 'PNG', 45, 75, 120, 120);
    doc.setFontSize(13);
    const steps = ['1. QR-Code mit dem Handy scannen', '2. Auf deinen Namen tippen', '3. Plan als PDF oder für den Kalender laden'];
    steps.forEach((step, index) => doc.text(step, 45, 210 + index * 8));
    doc.setFontSize(9).setTextColor('#66727f');
    doc.text(doc.splitTextToSize(state.url, 170) as string[], 105, 245, { align: 'center' });
    await saveFile(`QR-Code_${safeFileName(period.name)}.pdf`, doc.output('blob'));
  }

  /** Auf Handy und Tablet: Link über den Teilen-Dialog verschicken (Messenger, Mail …) */
  protected readonly canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  protected shareLink(url: string): void {
    const period = this.period();
    navigator.share({ title: period.name, text: `Deine Termine für „${period.name}“:`, url }).catch(() => undefined);
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
}

async function qrDataUrl(url: string): Promise<string> {
  // CommonJS-Paket: Je nach Build stehen die Funktionen direkt am Modul oder unter `default`.
  const module = await import('qrcode');
  const QRCode = (module as unknown as { default?: typeof module }).default ?? module;
  return QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 640 });
}
