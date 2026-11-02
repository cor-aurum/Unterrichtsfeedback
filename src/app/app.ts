import { Component, computed, effect, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ActiveTeacher } from './active-teacher';
import { ConfigStore } from './config.store';
import { FolderSync } from './sync/folder-sync';
import { isNativeApp } from './save-file';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly configStore = inject(ConfigStore);
  private readonly theme = this.configStore.theme;
  protected readonly teachers = computed(() => this.configStore.config().teachers);
  protected readonly activeTeacher = inject(ActiveTeacher);
  /** Startet die Ordner-Synchronisation, falls ein Ordner gewählt ist */
  private readonly folderSync = inject(FolderSync);
  protected readonly syncNeedsAttention = computed(() =>
    ['reconnect', 'changed', 'error'].includes(this.folderSync.status()),
  );
  protected readonly nativeApp = isNativeApp;
  /** Neueste APK aus den GitHub-Releases (siehe .github/workflows/android.yml) */
  protected readonly apkUrl =
    'https://github.com/cor-aurum/Unterrichtsfeedback/releases/latest/download/Unterrichtsfeedback.apk';

  protected valueOf(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

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
