import { Routes } from '@angular/router';
import { Lessons } from './lessons/lessons';

// „Stunden erfassen“ ist die Startseite; die übrigen Seiten werden erst beim ersten Aufruf geladen.
export const routes: Routes = [
  { path: 'stunden', component: Lessons, title: 'Stunden erfassen' },
  {
    path: 'kalender',
    loadComponent: () => import('./calendar/calendar-page').then((m) => m.CalendarPage),
    title: 'Kalender',
  },
  {
    path: 'konfiguration',
    loadComponent: () => import('./config-editor/config-editor').then((m) => m.ConfigEditor),
    title: 'Konfiguration',
  },
  {
    path: 'export',
    loadComponent: () => import('./export-page/export-page').then((m) => m.ExportPage),
    title: 'Export & Sicherung',
  },
  { path: 'hilfe', loadComponent: () => import('./help/help').then((m) => m.Help), title: 'Hilfe' },
  { path: '**', redirectTo: 'stunden' },
];
