import { Component, computed, inject, input, signal } from '@angular/core';
import { formatShortDate, ReportPeriodEntry } from '../model';
import { safeFileName, saveFile } from '../save-file';
import { PlanLinkState, ServerLogin, serverApi } from '../sync/server-folder';
import { ServerSync } from '../sync/server-sync';
import { PlanPublisher } from './plan-publisher';

/**
 * Download-Link eines Berichtszeitraums in seinen Einstellungen: ein Link (mit QR-Code) für alle Personen darin.
 * Auf der Seite dahinter tippt jede Person auf ihren Namen und lädt ihren Plan als PDF oder Kalenderdatei herunter.
 * Verteilt wird der Link außerhalb der App, z. B. per Mail oder Aushang.
 */
@Component({
  selector: 'app-plan-link-panel',
  templateUrl: './plan-link-panel.html',
  styleUrl: './plan-link-panel.scss',
})
export class PlanLinkPanel {
  readonly period = input.required<ReportPeriodEntry>();
  private readonly sync = inject(ServerSync);
  private readonly publisher = inject(PlanPublisher);
  protected readonly login = this.sync.login;

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
    await this.action(async (login) => this.show(await serverApi.plan(login, this.period().id)));
  }

  protected async create(): Promise<void> {
    await this.action(async (login) => {
      await serverApi.newPlanAddress(login, this.period().id);
      await this.publisher.publish(login, this.period(), true);
      this.show(await serverApi.plan(login, this.period().id));
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
      await serverApi.deletePlan(login, this.period().id);
      this.show(await serverApi.plan(login, this.period().id));
    });
  }

  /** Schickt die Pläne sofort, statt auf den nächsten Abgleich zu warten. */
  protected async refresh(): Promise<void> {
    await this.action(async (login) => {
      await this.publisher.publish(login, this.period(), true);
      this.show(await serverApi.plan(login, this.period().id));
      this.message.set('Die Pläne sind auf dem neuesten Stand.');
    });
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
    if (state.url) void qrDataUrl(state.url).then((url) => this.state()?.url === state.url && this.qrCode.set(url));
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
  const QRCode = await import('qrcode');
  return QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 640 });
}
