# Handschrift-Server für KI-Assistenten (MCP)

Ein kleiner Server, über den ein KI-Assistent (Claude, ChatGPT …) Text als PDF in
deiner Handschrift schreiben lässt. Du sagst im Chat zum Beispiel „Schreib mir das
als PDF in meiner Handschrift“; der Assistent ruft das Werkzeug `handschrift_pdf`
mit dem Text auf, der Server schreibt die Seiten und antwortet mit einem
Download-Link. Die Seiten sehen aus wie im Modus „Seite“ der App: Papier, Größe,
Ausrichtung auf der Linie und PDF kommen aus denselben Programmteilen.

Der Server ist ein einzelnes, dauerhaft laufendes Programm (Python + Node.js),
läuft auf x86 und arm64 (z. B. Raspberry Pi 5) und braucht von außen nur eine
HTTPS-Adresse, unter der er erreichbar ist (eigener Server, Tunnel, Container-Dienst
– das ist dir überlassen). Claude und ChatGPT rufen den Server aus ihrer eigenen
Cloud auf, nicht von deinem Gerät: eine Adresse wie `localhost` oder `192.168.…`
funktioniert dort nicht. Prüfen kannst du die Adresse, indem du
`https://<deine-adresse>/healthz` auf dem Handy über mobile Daten (WLAN aus) öffnest.

## Was der Assistent sieht

Ein Werkzeug mit fünf Angaben:

| Angabe | Werte | Standard |
|---|---|---|
| `text` | der Text; Absätze durch eine Leerzeile getrennt | – |
| `papier` | `liniert`, `kariert`, `blanko` | `liniert` |
| `farbe` | `hell` (dunkle Schrift auf Weiß), `dunkel` (helle Schrift auf Dunkel) | `hell` |
| `groesse` | `klein`, `mittel`, `gross` | `mittel` |
| `stift` | `fineliner`, `fueller`, `bleistift` | `fineliner` |

Die Antwort ist eine Zeile mit dem Link und der Seitenzahl. Markdown, das
Assistenten gern einbauen (Überschriften mit `#`, `**fett**`, Backticks,
Aufzählungspunkte), wird entfernt; Aufzählungen werden zu „- “, Tabellenzeilen zu
„Zelle, Zelle“. Wörter über 40 Zeichen (meist Internetadressen) werden in Stücke
zu 22 Zeichen geteilt. Höchstens 12.000 Zeichen pro Aufruf. Lesbarkeit ist fest
0,4 (wie in der App). Englische Werte wie `dark` oder `large` werden verstanden;
unbekannte Werte nennt die Antwort.

Ist das PDF nach 40 Sekunden noch nicht fertig, antwortet der Server trotzdem mit
dem Link. Der Link zeigt dann eine Warteseite mit Fortschritt („Schreibt … 120 von
240 Stücken“), die sich selbst neu lädt und am Ende das PDF zeigt. PDFs bleiben
7 Tage abrufbar. Wird der Server neu gestartet, während ein PDF entsteht, sagt der
Link danach, dass das Schreiben unterbrochen wurde; der Text muss dann noch einmal
geschickt werden. Ein PDF, das länger als 10 Minuten braucht, wird abgebrochen.

Gemessen auf einem geteilten Rechner mit 4 Kernen (Zeit vom Aufruf bis zum fertigen
PDF): etwa 600 Zeichen (1 Seite) 2–3 s, etwa 1.500 Zeichen (2 Seiten) 4–9 s, etwa
4.700 Zeichen (4 Seiten) 19–36 s, auf einem stark belasteten Rechner auch deutlich
mehr.

## Einstellungen (Umgebungsvariablen)

| Variable | Bedeutung | Standard |
|---|---|---|
| `HANDSCHRIFT_KEY_HASHES` | SHA-256-Hashes der gültigen Schlüssel, durch Komma getrennt | – |
| `HANDSCHRIFT_MODEL_REPO` | privates Hugging-Face-Modell-Repo, z. B. `name/handwriting-fable-model`; daraus kommen das neueste Modell und `mcp/keys.json` | – |
| `HF_TOKEN` | Hugging-Face-Token mit Leserecht auf dieses Repo | – |
| `HANDSCHRIFT_MODEL_DIR` | stattdessen ein lokaler Modellordner (`model.pt`, `meta.json`) | – |
| `HANDSCHRIFT_PUBLIC_URL` | öffentliche Adresse, z. B. `https://handschrift.example.net`; daraus werden die Links gebaut. Bitte immer setzen, sobald der Server von außen erreichbar ist | aus der Anfrage |
| `HANDSCHRIFT_DATA` | Ordner für PDFs und das zwischengespeicherte Modell | `server/data` (im Container `/data`) |
| `HANDSCHRIFT_PORT` / `PORT` | Port | `8080` |
| `HANDSCHRIFT_HOST` | Adresse, auf der gelauscht wird | `0.0.0.0` |
| `HANDSCHRIFT_WAIT_SECONDS` | so lange wartet die Antwort höchstens aufs PDF | `40` |
| `HANDSCHRIFT_THREADS` | Rechenkerne fürs Schreiben | alle |
| `HANDSCHRIFT_BUDGET` | PDFs pro Link und Stunde | `30` |
| `HANDSCHRIFT_CALLS` | Aufrufe pro Link und Stunde, abgelehnte mitgezählt | doppeltes Budget |
| `HANDSCHRIFT_QUEUE` | Texte, die höchstens warten dürfen | `3` |
| `HANDSCHRIFT_MAX_MINUTES` | danach wird ein PDF abgebrochen | `10` |
| `HANDSCHRIFT_KEEP_DAYS` | Tage, die ein PDF abrufbar bleibt | `7` |
| `HANDSCHRIFT_MAX_MB` | Platz für alle PDFs zusammen | `500` |
| `HANDSCHRIFT_NODE` | Programm für Node.js | `node` |

Ohne Schlüssel lehnt der Server jede Anfrage ab. Läuft auf demselben Rechner noch
anderes, das viel rechnet, ist `HANDSCHRIFT_THREADS=2` oft schneller als alle Kerne.

## Einen Link anlegen

Der Link ist der Schlüssel: `https://<deine-adresse>/k/<schlüssel>/mcp`. Einen neuen
Schlüssel und seinen Hash erzeugt diese Zeile (erste Ausgabezeile: Schlüssel, zweite:
Hash):

```
python -c "import secrets,hashlib;k=secrets.token_urlsafe(32);print(k);print(hashlib.sha256(k.encode()).hexdigest())"
```

Den **Hash** trägst du in `HANDSCHRIFT_KEY_HASHES` ein (oder in `mcp/keys.json` im
Modell-Repo: `{"keys": [{"sha256": "…", "label": "Handy", "created": "2026-11-26"}]}`,
wird spätestens nach einer Minute gelesen). Der **Schlüssel** kommt nur in den Link
und wird nirgends gespeichert. Wer den Link hat, kann PDFs schreiben lassen; zum
Sperren den Hash wieder entfernen. Ist das Modell-Repo länger als eine Stunde nicht
lesbar, gelten die Schlüssel aus `mcp/keys.json` nicht mehr, bis es wieder klappt.
Der Server selbst schreibt den Schlüssel in kein Protokoll, ein Tunnel oder Proxy
davor kann aber die aufgerufenen Adressen (und damit den Schlüssel) protokollieren.

## Starten

Lokal, aus dem Hauptordner des Repos (Python 3.11+, Node.js 20+), unter Linux
oder macOS:

```
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install -r server/requirements.txt
HANDSCHRIFT_KEY_HASHES=<hash> HANDSCHRIFT_MODEL_DIR=<modellordner> python -m server
```

Unter Windows (PowerShell) stattdessen jede Variable einzeln setzen, z. B.
`$env:HANDSCHRIFT_KEY_HASHES='<hash>'`, `$env:HANDSCHRIFT_MODEL_DIR='<modellordner>'`,
dann `python -m server`.

Mit Docker (Build aus dem Hauptordner des Repos). Die Einstellungen kommen in eine
Datei `handschrift.env` (nur für dich lesbar: `chmod 600 handschrift.env`), damit
das Token nicht in der Befehlszeile und im Verlauf steht:

```
HANDSCHRIFT_KEY_HASHES=<hash>
HANDSCHRIFT_MODEL_REPO=<name/repo>
HF_TOKEN=<token>
HANDSCHRIFT_PUBLIC_URL=https://<deine-adresse>
```

```
docker build -f server/Dockerfile -t handschrift .
docker run -d --name handschrift -p 127.0.0.1:8080:8080 -v handschrift-daten:/data \
  --env-file handschrift.env handschrift
```

`127.0.0.1:8080` macht den Server nur auf dem Rechner selbst erreichbar; das ist
richtig, wenn ein Tunnel auf demselben Rechner ihn nach außen bringt. Als
`HF_TOKEN` am besten ein „fine-grained“ Token, das nur dieses eine Repo lesen darf.

Für den Raspberry Pi das Image dort bauen oder mit `docker buildx build --platform
linux/arm64 …`. Ob alles läuft: `https://<deine-adresse>/healthz` zeigt
`{"ok": true, "model": "<version>", "busy": false}`.

## Im Assistenten hinzufügen

Beide brauchen nur die Adresse, keine Anmeldung. Die Menünamen ändern sich je nach
Version und Tarif.

- **Claude** (claude.ai oder App): Einstellungen → Konnektoren → „Benutzerdefinierten
  Konnektor hinzufügen“; Name z. B. „Handschrift“, als URL den Link
  `https://<deine-adresse>/k/<schlüssel>/mcp`, keine OAuth-Angaben.
- **ChatGPT**: Einstellungen → Apps/Konnektoren (eigene Konnektoren brauchen dort
  ggf. den Entwicklermodus) → neuen Konnektor anlegen, als MCP-Server-URL denselben
  Link, Authentifizierung „Keine“.

Danach im Chat: „Schreib diesen Text als PDF in meiner Handschrift, kariert.“
