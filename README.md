# Unterrichtsfeedback

Angular-App zum Erfassen von Feedback für Schülerinnen und Schüler im Einzelunterricht. Sie läuft
komplett im Browser, ohne Backend: Die Daten liegen im Local Storage, das Feedback wird als PDF
exportiert.

## Entwicklung

```bash
npm install
npm start
```

Die App läuft dann unter `http://localhost:4200/`.

## Veröffentlichen auf GitHub Pages

Der Workflow `.github/workflows/deploy.yml` baut die App bei jedem Push auf `master` oder `main` und
veröffentlicht sie auf GitHub Pages.

Einmalig einrichten:

1. Repository auf GitHub anlegen und den Code pushen.
2. Im Repository unter **Settings → Pages** bei **Source** „GitHub Actions“ auswählen.
3. Den Workflow unter **Actions → Deploy to GitHub Pages** starten (oder erneut pushen).

Die App ist danach unter `https://<benutzer>.github.io/<repository>/` erreichbar.

Damit das ohne Server-Konfiguration funktioniert:

- Der Produktions-Build nutzt `baseHref: "./"`, die App läuft also unter jedem Repository-Namen.
- Die Routen sind Hash-URLs (`#/stunden`, `#/export`). GitHub Pages kennt keine Weiterleitung auf
  `index.html`, sonst würde das Neuladen einer Unterseite einen 404-Fehler liefern.

## Daten

- Personen, Stunden und Konfiguration liegen im Local Storage des Browsers. Sie gehören zur Adresse
  der App: Was lokal erfasst wurde, ist auf GitHub Pages nicht vorhanden. Für den Umzug unter
  **Export & Sicherung** die Daten exportieren und dort wieder importieren.
- Beim Löschen der Browserdaten gehen die Daten verloren. Regelmäßig eine Datensicherung
  herunterladen.
