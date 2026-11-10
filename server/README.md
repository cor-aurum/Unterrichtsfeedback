# unterricht-feedback-server

Server für die App Unterrichtsfeedback. Er speichert die Daten aller Lehrer an einer Stelle, gleicht sie zwischen
Geräten ab und regelt, wer welche Personen sehen darf. Er ersetzt die frühere Ordner-Synchronisation (lokaler
Ordner bzw. Nextcloud per WebDAV).

- Ein einzelnes Programm ohne Abhängigkeiten; alle Daten liegen in einer SQLite-Datei.
- Die App arbeitet weiter auch offline und gleicht ab, sobald der Server erreichbar ist.
- Spricht nur HTTP; HTTPS übernimmt ein Reverse-Proxy (Caddy, nginx, Traefik …).

## Wer sieht was?

- **Alle Lehrer** sehen und ändern die gemeinsame Konfiguration (Textbausteine, feste Inhalte, Instrumente …), die
  Lehrer (Name, Instrument, Standard-Unterrichtszeiten, Blocker) und die allgemeinen Termine außerhalb der
  Berichtszeiträume. Jeder Lehrer kann neue Berichtszeiträume anlegen und neue Lehrer einladen.
- **Alles, was zu einem Berichtszeitraum gehört**, sehen und ändern nur die Lehrer, die in ihm eingetragen sind
  (in der App: Konfiguration → Allgemein → Berichtszeiträume → *Aktive Lehrer:innen*): Name und Daten des Zeitraums,
  seine Lehrer, Unterrichtszeiten und Orte darin, seine allgemeinen Termine und die Personen, Gruppen, Stunden und
  Termine. Die anderen erfahren nur, *dass* es weitere Zeiträume gibt (ihre Anzahl), nicht was darin ist.
- Beim ersten Start einer neuen Version stellt der Server ältere Daten selbst um: Die Berichtszeiträume wandern aus
  der Konfiguration in eigene Dokumente, Unterrichtszeiten und Orte je Zeitraum und die allgemeinen Termine darin
  mit. Ältere App-Versionen kann der Server danach nicht mehr bedienen; sie melden, dass ein Update nötig ist.
- Lehrer eintragen oder austragen dürfen nur Lehrer, die selbst eingetragen sind. Wer einen Zeitraum neu anlegt,
  muss sich selbst eintragen.
- Personen werden nie automatisch zusammengeführt. Wer zwei gleiche Personen sehen kann (gleicher Name, passendes
  Geburtsdatum), bekommt in der App unter *Personen* einen Vorschlag zum Zusammenführen; die Apps der anderen Lehrer
  übernehmen die Zusammenführung beim nächsten Abgleich.

## Programm holen

Fertige Programme für Linux (amd64, arm64, armv7), Windows und macOS baut GitHub Actions bei jedem Push nach
`server/` (unter *Actions* als Artefakte) und hängt sie bei einem Versions-Tag (`v1.2.0`) an den Release.

Selbst bauen (Go 1.26 oder neuer, kein C-Compiler nötig):

```sh
cd server
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o unterricht-feedback-server .
```

## Einrichten unter Linux

```sh
sudo useradd --system --home /var/lib/unterricht-feedback --create-home unterricht-feedback
sudo install -m 755 unterricht-feedback-server-linux-amd64 /usr/local/bin/unterricht-feedback-server
```

`/etc/systemd/system/unterricht-feedback.service`:

```ini
[Unit]
Description=Unterrichtsfeedback-Server
After=network.target

[Service]
User=unterricht-feedback
WorkingDirectory=/var/lib/unterricht-feedback
Environment=UF_DB=/var/lib/unterricht-feedback/daten.db
Environment=UF_PUBLIC_URL=https://feedback.example.de
Environment=UF_LISTEN=127.0.0.1:8080
# Nur Browser von dieser Adresse dürfen zugreifen (die Android-App ist davon nicht betroffen); „*“ erlaubt alle.
Environment=UF_ALLOW_ORIGIN=*
ExecStart=/usr/local/bin/unterricht-feedback-server serve
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/unterricht-feedback

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now unterricht-feedback
```

### Reverse-Proxy

Der Server lauscht nur auf `127.0.0.1`; von außen ist er allein über den Proxy erreichbar. Der Proxy muss auf
demselben Rechner laufen: Nur bei Anfragen von dort wertet die Bremse bei Fehlversuchen `X-Forwarded-For` aus, und
zwar den Eintrag, den der Proxy selbst anhängt. Caddy setzt ihn von sich aus, bei nginx sorgt
`$proxy_add_x_forwarded_for` dafür. Ohne diese Angabe gilt für alle Anfragen über den Proxy eine gemeinsame Bremse.

Caddy (`/etc/caddy/Caddyfile`, holt das Zertifikat selbst):

```
feedback.example.de {
	reverse_proxy 127.0.0.1:8080
}
```

nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name feedback.example.de;
    # ssl_certificate … (z. B. mit certbot)

    client_max_body_size 30m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Host $host;
    }
}
```

## Der erste Lehrer

Den ersten Lehrer lädt man auf dem Server ein, jeden weiteren laden Lehrer in der App ein
(Konfiguration → Lehrer → *Einladungscode erzeugen*):

```sh
sudo -u unterricht-feedback env UF_DB=/var/lib/unterricht-feedback/daten.db \
  UF_PUBLIC_URL=https://feedback.example.de unterricht-feedback-server invite
```

Der Code (`UF1.…`) enthält die Adresse des Servers. Der Lehrer wählt in der App beim ersten Start *Mit Server
verbinden …*, fügt ihn ein, wählt Benutzername und Passwort und richtet sich danach wie gewohnt ein. Codes gelten einmal
und 14 Tage.

Ein so erzeugter Code gehört zu keinem Lehrer: Das Konto bekommt die Lehrer-ID der App, die ihn einlöst. Hat jemand
die App bisher ohne Server benutzt, löst er den Code unter *Export & Sicherung → Server* ein; seine vorhandenen Daten
landen dann auf dem leeren Server, und er ist dort derselbe Lehrer wie bisher.

## Passwort vergessen

```sh
sudo -u unterricht-feedback env UF_DB=/var/lib/unterricht-feedback/daten.db \
  UF_PUBLIC_URL=https://feedback.example.de unterricht-feedback-server reset-code --user anna
```

Den Code fügt der Lehrer in der App unter *Passwort vergessen?* ein und vergibt ein neues Passwort; alle seine
Geräte werden dabei abgemeldet. Reset-Codes gelten einmal und zwei Tage. Benutzernamen zeigt `accounts`.

## Kalender-Abo

Jeder Lehrer kann in der App (Kalender → Kalender-Abo) eine Abo-Adresse für Google-, Apple- oder Outlook-Kalender
einrichten: `https://feedback.example.de/api/kalender/<Schlüssel>.ics`. Den Kalender erzeugt die App bei jedem
Abgleich und schickt ihn mit; der Server liefert ihn nur aus. Damit er nicht erst aktuell wird, wenn der Lehrer selbst
seine App öffnet, schickt jede App auch die Kalender der Kolleg:innen aus denselben Berichtszeiträumen
(`PUT /api/feeds/{Lehrer-ID}`). Der Server nimmt das nur an, wenn das Konto in allen Zeiträumen dieses Lehrers
eingetragen ist, die nicht länger als 28 Tage vorbei sind – sonst fehlten Termine aus den anderen. Ohne Abo des
Lehrers speichert er nichts.

Kalender-Apps können sich nicht anmelden, deshalb ist die Adresse selbst der Schlüssel (256 Bit Zufall). Wer sie
kennt, sieht die Termine mit den Namen der Personen. Eine neue Adresse in der App macht die alte sofort ungültig. Die
Adresse steht in den Zugriffsprotokollen des Proxys; wer sie dort nicht haben will, schließt `/api/kalender/` vom
Protokoll aus.

## Download-Link für Pläne

Für jeden Berichtszeitraum kann eine seiner Lehrkräfte in der App (Konfiguration → Allgemein → beim Zeitraum) einen
Download-Link erzeugen: `https://feedback.example.de/api/plan/<Schlüssel>`. Die Seite dahinter zeigt die Kurznamen
aller Personen im Zeitraum; wer auf einen Namen tippt, sieht dessen Einzel- und Gruppentermine sowie die allgemeinen
Termine für alle Lehrkräfte und lädt sie als PDF oder Kalenderdatei (auch als Abo) herunter. Namen, Termine, PDFs
und Kalender erzeugt die App, sobald sich etwas ändert, und schickt sie mit; der Server zeigt sie nur an.

Wie beim Kalender-Abo ist der Link selbst der Schlüssel (256 Bit Zufall), ein neuer macht den alten ungültig. Er
gilt bis 14 Tage nach dem Ende des Zeitraums (danach `410`). Die Seite braucht kein JavaScript und ist für
Suchmaschinen gesperrt. Wer den Link nicht in den Zugriffsprotokollen haben will, schließt `/api/plan/` vom
Protokoll aus.

Im Demomodus der App gibt es den Berichtszeitraum nur auf dem Gerät. Jedes Konto kann dafür einen Demo-Link unter
der ID `demo-konto-<Lehrer-ID>` anlegen, ohne Zeitraum auf dem Server. Er gilt bis drei Tage nach der letzten
Aktualisierung; die App löscht ihn beim Verlassen der Demo.

### Tauschen und Dazukommen

Auf der Seite einer Person lässt sich ein einzelner künftiger Einzeltermin mit dem einer anderen Person bei derselben
Lehrkraft tauschen, oder man fragt, ob man zum Unterricht einer anderen Person dazukommen darf (auch bei einer anderen
Lehrkraft). Die andere Person nimmt auf ihrer Seite an oder lehnt ab; eine Anmeldung gibt es nicht. Angenommene
Anfragen holt die App einer Lehrkraft des Zeitraums beim Abgleich ab (`GET /api/plans/{Zeitraum}/requests`), ändert
die Daten und meldet `applied` oder `failed` mit Grund. Beim Dazukommen wird der Termin zum Termin einer neuen Gruppe
ohne Namen. Je Person gibt es höchstens 10 offene Anfragen, je Zeitraum 500.
Die Namensliste zeigt offene Anfragen je Person; nach einer Anfrage bietet die Seite den Link zur Seite der gefragten
Person zum Teilen an. Das ist das einzige JavaScript der Seiten, erlaubt über seinen Hash in der
Content-Security-Policy.

## Sicherung

Alle Daten stehen in der SQLite-Datei. Eine konsistente Kopie im laufenden Betrieb:

```sh
sqlite3 /var/lib/unterricht-feedback/daten.db ".backup '/sicherung/daten-$(date +%F).db'"
```

Ohne `sqlite3` den Dienst kurz anhalten und die Datei (samt `daten.db-wal`, falls vorhanden) kopieren.

## Schnittstelle

Für Entwickler; die App nutzt sie in `src/app/sync/server-folder.ts`.

| Methode und Pfad          | Zweck                                                                 |
|---------------------------|-----------------------------------------------------------------------|
| `POST /api/redeem`        | Einladung einlösen: `{code, username, password, teacherId}` → `{token, username, teacherId}`; `teacherId` gilt nur bei Codes ohne Lehrer |
| `POST /api/login`         | Anmelden: `{username, password}` → wie oben                            |
| `POST /api/reset`         | Neues Passwort mit Reset-Code: `{code, password}` → wie oben           |
| `POST /api/logout`        | Abmelden                                                               |
| `GET /api/me`             | Eigenes Konto, Zahl der Berichtszeiträume, in denen man nicht eingetragen ist (`foreignPeriods`), und `conditionalWrites: true` (der Server kennt If-Match) |
| `GET /api/accounts`       | Welche Lehrer schon ein Konto haben                                   |
| `POST /api/invites`       | Einladungscode für einen Lehrer ohne Konto: `{teacherId}` → `{code, expiresAt}` |
| `GET /api/docs`           | Dokumente, die man sehen darf: `[{name, version}]`                     |
| `GET/PUT/DELETE /api/docs/{name}` | Dokument lesen, schreiben, löschen. `PUT` mit `If-Match: <version>` (`0` für ein neues Dokument) schreibt nur, wenn das Dokument noch diese Version hat, sonst `412`; so überschreiben Tablets in der Schüler-Planung nicht gegenseitig ihre Eintragungen |
| `GET /api/merges`         | Zusammengeführte Personen: `[{from, into}]`                            |
| `POST /api/merges`        | Zwei Personen zusammenführen: `{from, into}`                           |
| `GET /api/feed`           | Eigenes Kalender-Abo: `{url, updatedAt}`; `url` leer ohne Abo          |
| `PUT /api/feed`           | Kalender (iCalendar) für das Abo senden                                |
| `PUT /api/feeds/{Lehrer-ID}` | Abo-Kalender eines Lehrers senden, auch eines Kollegen: `403` ohne gemeinsamen Zeitraum, `409`, wenn er in Zeiträumen ist, die das Konto nicht sieht |
| `POST/DELETE /api/feed/address` | Neue Abo-Adresse (die alte gilt nicht mehr) bzw. Abo beenden     |
| `GET /api/kalender/{Schlüssel}.ics` | Der Kalender für die Kalender-App, ohne Anmeldung            |
| `GET /api/plans/{Zeitraum}` | Download-Link des Zeitraums (nur seine Lehrkräfte): `{url, updatedAt, expiresAt}`; `url` leer ohne Link |
| `PUT /api/plans/{Zeitraum}` | Pläne senden: `{title, dates, color, people: [{id, label, days, ics, pdf}]}`; `404` ohne Link |
| `POST /api/plans/{Zeitraum}/address` | Neuer Download-Link (der alte gilt nicht mehr)                 |
| `DELETE /api/plans/{Zeitraum}` | Link, Pläne und Anfragen löschen                                  |
| `GET /api/plans/{Zeitraum}/requests` | Angenommene Anfragen zum Übernehmen: `[{id, kind, from, to, fromSlot, toSlot}]` |
| `POST /api/plans/{Zeitraum}/requests/{id}` | Übernommen melden: `{status: "applied"\|"failed", note}`      |
| `GET /api/plan/{Schlüssel}[/{Person}[.pdf\|.ics]]` | Namensliste, Seite, PDF oder Kalender einer Person, ohne Anmeldung |
| `GET /api/plan/{Schlüssel}/{Person}/tauschen\|dazukommen` | Termine anderer zum Tauschen bzw. Dazukommen        |
| `POST /api/plan/{Schlüssel}/{Person}/anfragen\|antworten` | Anfrage stellen bzw. annehmen, ablehnen, zurückziehen (Formulare) |

Angemeldet wird mit `Authorization: Bearer <token>`. Fehler kommen als `{error: "…"}` mit einem Text für die App.
