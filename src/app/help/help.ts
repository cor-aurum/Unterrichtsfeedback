import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PLACEHOLDERS } from '../model';
import { isNativeApp } from '../save-file';

@Component({
  selector: 'app-help',
  imports: [RouterLink],
  templateUrl: './help.html',
  styleUrl: './help.scss',
})
export class Help {
  /** Abschnitte in der Reihenfolge der Seite; die IDs stehen an den Abschnitten in help.html. */
  protected readonly contents = [
    { id: 'stunden', title: 'Stunden erfassen' },
    { id: 'personen', title: 'Personen' },
    { id: 'gruppenplanung', title: 'Gruppenplanung' },
    { id: 'kalender', title: 'Kalender' },
    { id: 'zeitraeume', title: 'Berichtszeiträume' },
    { id: 'konfiguration', title: 'Konfiguration' },
    { id: 'export', title: 'Export & Sicherung' },
    { id: 'daten', title: 'Wo sind meine Daten?' },
  ];
  protected readonly placeholders = PLACEHOLDERS;
  /** Adresse dieser Webseite, die der Server erlauben muss (`--allow-origin`); in der App unbekannt */
  protected readonly origin = isNativeApp ? null : location.origin;

  /** Die App nutzt Hash-Routing; Sprungmarken in der URL gehen deshalb nicht, gescrollt wird direkt. */
  protected scrollTo(id: string): void {
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }
}
