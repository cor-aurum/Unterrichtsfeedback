import { Routes } from '@angular/router';
import { ConfigEditor } from './config-editor/config-editor';
import { ExportPage } from './export-page/export-page';
import { Help } from './help/help';
import { Lessons } from './lessons/lessons';

export const routes: Routes = [
  { path: 'stunden', component: Lessons, title: 'Stunden erfassen' },
  { path: 'konfiguration', component: ConfigEditor, title: 'Konfiguration' },
  { path: 'export', component: ExportPage, title: 'Export & Sicherung' },
  { path: 'hilfe', component: Help, title: 'Hilfe' },
  { path: '**', redirectTo: 'stunden' },
];
