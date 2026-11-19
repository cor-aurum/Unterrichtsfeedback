import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * Kleines „?“ neben einer Überschrift: öffnet die Hilfe beim passenden Abschnitt (`topic` ist die ID eines Abschnitts
 * oder Punkts in help.html), statt dass man die lange Seite selbst durchsuchen muss.
 */
@Component({
  selector: 'app-help-link',
  imports: [RouterLink],
  template: `<a
    class="help-link"
    routerLink="/hilfe"
    [queryParams]="{ thema: topic() }"
    [title]="'Hilfe: ' + label()"
    [attr.aria-label]="'Hilfe: ' + label()"
    (click)="$event.stopPropagation()"
    >?</a
  >`,
  styles: `
    :host {
      display: inline-block;
      vertical-align: middle;
      margin-left: 0.4rem;
    }
    .help-link {
      display: inline-grid;
      place-items: center;
      width: 1.3rem;
      height: 1.3rem;
      border: 1px solid var(--muted);
      border-radius: 50%;
      color: var(--muted);
      font-size: 0.8rem;
      font-weight: 600;
      line-height: 1;
      text-decoration: none;
    }
    .help-link:hover,
    .help-link:focus-visible {
      border-color: var(--primary);
      color: var(--primary);
    }
  `,
})
export class HelpLink {
  readonly topic = input.required<string>();
  /** Wozu die Hilfe ist, für Tooltip und Screenreader */
  readonly label = input('dazu');
}
