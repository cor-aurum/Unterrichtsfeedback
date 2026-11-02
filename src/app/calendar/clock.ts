import { Injectable, signal } from '@angular/core';

/** Aktuelle Uhrzeit als Signal, damit Ansichten wie die Schnellauswahl sich selbst aktualisieren. */
@Injectable({ providedIn: 'root' })
export class Clock {
  readonly now = signal(new Date());

  constructor() {
    setInterval(() => this.now.set(new Date()), 30_000);
  }
}
