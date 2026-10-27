import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PLACEHOLDERS } from '../model';

@Component({
  selector: 'app-help',
  imports: [RouterLink],
  templateUrl: './help.html',
  styleUrl: './help.scss',
})
export class Help {
  protected readonly placeholders = PLACEHOLDERS;
}
