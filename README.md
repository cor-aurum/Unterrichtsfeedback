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

## Android-App

Die App wird mit [Capacitor](https://capacitorjs.com/) als Android-App verpackt (Ordner `android/`).
Der Workflow `.github/workflows/android.yml` baut daraus eine signierte APK:

- **Bei einem Tag wie `v1.2.0`** entsteht ein GitHub-Release mit der APK zum Herunterladen. Die
  Versionsnummer der App kommt aus dem Tag. Die APK hängt zusätzlich als `Unterrichtsfeedback.apk` am
  Release; darauf verlinkt die Web-App unten auf der Seite (`…/releases/latest/download/Unterrichtsfeedback.apk`).
- **Manuell unter Actions → Android-App bauen** entsteht eine Test-APK als Artefakt des Laufs.

Auf dem Android-Gerät die APK öffnen und die Installation aus dieser Quelle erlauben.

### Einmalig: Signaturschlüssel anlegen

Android installiert ein Update nur, wenn es mit **demselben Schlüssel** signiert ist wie die
installierte Version. Geht der Schlüssel verloren, lässt sich die App nur noch neu installieren – und
dabei werden die Daten auf dem Gerät gelöscht. Den Schlüssel und die Passwörter deshalb sicher
aufbewahren, zum Beispiel im Passwortmanager, und **nie ins Repository einchecken**.

1. Schlüssel erzeugen (`keytool` gehört zum JDK, die Passwörter werden abgefragt):

   ```bash
   keytool -genkeypair -v -keystore unterrichtsfeedback.keystore -alias unterrichtsfeedback -keyalg RSA -keysize 4096 -validity 10000
   ```

2. Den Schlüssel für GitHub als Base64-Text in die Zwischenablage kopieren (PowerShell):

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("unterrichtsfeedback.keystore")) | Set-Clipboard
   ```

3. Im Repository unter **Settings → Secrets and variables → Actions** diese Secrets anlegen:

   | Secret | Inhalt |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | der kopierte Base64-Text |
   | `ANDROID_KEYSTORE_PASSWORD` | Passwort des Keystores |
   | `ANDROID_KEY_ALIAS` | `unterrichtsfeedback` |
   | `ANDROID_KEY_PASSWORD` | Passwort des Schlüssels (bei neueren `keytool`-Versionen dasselbe) |

### Release erstellen

```bash
git tag v1.0.0
git push origin v1.0.0
```

### Lokal bauen

Voraussetzungen: Android SDK und **JDK 21** (Gradle 8.14 läuft noch nicht mit neueren Java-Versionen).

```bash
npm run build
npx cap sync android
cd android
./gradlew assembleDebug
```

Die APK liegt dann unter `android/app/build/outputs/apk/debug/`.

Bricht Gradle unter Windows mit „Unable to establish loopback connection“ ab, kommt Java mit dem
Temp-Ordner nicht zurecht (z. B. bei Kurznamen wie `C:\Users\ABCDEF~1`). Dann vor dem Build einen
einfachen Temp-Ordner setzen, zum Beispiel in PowerShell `$env:TMP = $env:TEMP = "C:\Temp"`. Alternativ öffnet `npx cap open android`
das Projekt in Android Studio.

### Was in der App anders ist

- PDF, Konfiguration und Datensicherung werden nicht heruntergeladen, sondern über den
  Android-Teilen-Dialog weitergegeben (Mail, Messenger, Google Drive, „Dateien“ …).
- Die Daten liegen im Speicher der App, getrennt von der Browser-Version. Beim Deinstallieren der App
  werden sie gelöscht.

## Daten

- Personen, Stunden und Konfiguration liegen im Local Storage des Browsers. Sie gehören zur Adresse
  der App: Was lokal erfasst wurde, ist auf GitHub Pages nicht vorhanden. Für den Umzug unter
  **Export & Sicherung** die Daten exportieren und dort wieder importieren.
- Beim Löschen der Browserdaten gehen die Daten verloren. Regelmäßig eine Datensicherung
  herunterladen.
