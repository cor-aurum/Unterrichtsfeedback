/**
 * Ein „Ordner“, mit dem die Synchronisation ihre Dateien abgleicht. Früher ein lokaler Ordner oder eine Nextcloud,
 * heute der Unterrichtsfeedback-Server (siehe `server-folder.ts`).
 */
export interface SyncFolder {
  readonly name: string;
  /** Nein, wenn man sich erneut anmelden muss */
  hasAccess(): Promise<boolean>;
  requestAccess(): Promise<boolean>;
  list(): Promise<FolderEntry[]>;
  read(name: string): Promise<string>;
  write(name: string, text: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/** Datei im Ordner; `version` ändert sich mit jeder Änderung (beim Server: die Revision). */
export interface FolderEntry {
  name: string;
  version: string;
}
