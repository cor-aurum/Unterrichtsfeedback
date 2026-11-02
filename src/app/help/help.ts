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
  protected readonly placeholders = PLACEHOLDERS;
  /** Adresse dieser Webseite für die Freigabe in der Nextcloud; in der App unbekannt */
  protected readonly origin = isNativeApp ? null : location.origin;
}
