import { Routes } from '@angular/router';

// Alle Seiten werden erst beim ersten Aufruf geladen; wohin das Logo führt, legt jede Lehrkraft selbst fest.
export const routes: Routes = [
  {
    path: 'stunden',
    loadComponent: () => import('./lessons/lessons').then((m) => m.Lessons),
    title: 'Stunden erfassen',
  },
  {
    path: 'personen',
    loadComponent: () => import('./people/people-page').then((m) => m.PeoplePage),
    title: 'Personen',
  },
  {
    path: 'gruppen',
    loadComponent: () => import('./groups/group-planning-page').then((m) => m.GroupPlanningPage),
    title: 'Gruppenplanung',
  },
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
