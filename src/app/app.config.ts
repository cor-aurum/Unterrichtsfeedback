import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withHashLocation } from '@angular/router';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    // GitHub Pages liefert für Pfade wie /export keine index.html aus. Mit Hash-URLs (#/export)
    // funktionieren Neuladen und Lesezeichen trotzdem.
    provideRouter(routes, withHashLocation()),
  ],
};
