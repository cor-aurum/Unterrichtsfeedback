import { Component } from '@angular/core';
import { download, pendingShare, shareInBrowser } from './save-file';

/**
 * Auf dem Handy: Eine fertige Datei, die nicht gleich geteilt werden konnte (siehe `pendingShare`), wartet hier
 * unten auf dem Bildschirm auf „Teilen …“ oder „Herunterladen“.
 */
@Component({
  selector: 'app-share-sheet',
  template: `
    @if (file(); as f) {
      <div class="sheet" role="dialog" aria-label="Datei teilen">
        <p><strong>{{ f.name }}</strong> ist fertig.</p>
        <div class="row">
          <button (click)="share(f)">Teilen …</button>
          <button class="secondary" (click)="save(f)">Herunterladen</button>
          <span class="grow"></span>
          <button class="secondary" (click)="file.set(null)">Schließen</button>
        </div>
      </div>
    }
  `,
  styles: `
    .sheet {
      position: fixed;
      right: 0;
      bottom: 0;
      left: 0;
      z-index: 200;
      padding: 1rem 1rem calc(1rem + env(safe-area-inset-bottom));
      border-top: 1px solid var(--border);
      background: var(--card);
      box-shadow: 0 -6px 20px rgb(0 0 0 / 0.15);
    }

    p {
      margin: 0 0 0.75rem;
      overflow-wrap: anywhere;
    }
  `,
})
export class ShareSheet {
  protected readonly file = pendingShare;

  protected async share(file: File): Promise<void> {
    try {
      await shareInBrowser(file);
    } catch (e) {
      alert(`Die Datei ließ sich nicht teilen: ${e instanceof Error ? e.message : e}`);
    }
  }

  protected save(file: File): void {
    download(file.name, file);
    this.file.set(null);
  }
}
