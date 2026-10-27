import { Component, effect, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { ConfigStore } from './config.store';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly theme = inject(ConfigStore).theme;
  protected readonly nativeApp = Capacitor.isNativePlatform();
  /** Neueste APK aus den GitHub-Releases (siehe .github/workflows/android.yml) */
  protected readonly apkUrl =
    'https://github.com/cor-aurum/Unterrichtsfeedback/releases/latest/download/Unterrichtsfeedback.apk';

  constructor() {
    // Überschreibt die Standardwerte der CSS-Variablen aus styles.scss mit der konfigurierten Farbe.
    effect(() => {
      const theme = this.theme();
      const style = document.documentElement.style;
      style.setProperty('--primary', theme.primary);
      style.setProperty('--on-primary', theme.onPrimary);
      style.setProperty('--primary-text', theme.primaryText);
      style.setProperty('--primary-light', theme.primaryLight);
    });
  }
}
