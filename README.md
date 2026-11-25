# Handschrift

Text eingeben, die eigene Handschrift kommt heraus. Ein kleines neuronales Netz
wird auf die Stiftaufnahmen einer Person feingetunt und läuft danach komplett
im Browser.

Details zum Aufbau stehen in [docs/SPEC.md](docs/SPEC.md).

## Wie es funktioniert

1. **Aufnahmen** liegen als Strichdaten auf Hugging Face (Koordinaten und
   Zeitpunkte des Stifts, keine Bilder). Neue Aufnahmen kommen aus der
   Erfassungs-App in das Dataset `handwriting-fable`.
2. **Aufbereitung** (`hw/prep.py`, `hw/dataset.py`): Jede Aufnahme wird auf
   Grundlinie und Buchstabenhöhe gebracht, zeitlich neu abgetastet und so
   skaliert, dass sie zum vortrainierten Modell passt. Einzelwörter werden für
   das Training zu Zeilen zusammengesetzt.
3. **Training** (`hw/train.py`): Ausgangspunkt ist ein vortrainiertes
   Handschriftmodell nach Graves (2013), das bereits schreiben kann. Das
   Feintuning bringt ihm die eigene Schrift bei, inklusive Umlauten und ß.
4. **Export** (`hw/export.py`) und **Web-App** (`web/`): Das Modell wird als
   rund 8 MB große Datei in den Browser geladen und schreibt dort.

## Qualität der Trainingsdaten

Trainiert wird nur mit sauberen Aufnahmen. Was aussortiert ist und warum,
steht in [data/quality/exclude.json](data/quality/exclude.json): zwei frühe
Test-Datensätze komplett sowie 187 Wörter, die bei einer Sichtprüfung aller
Aufnahmen als flüchtig oder fehlerhaft aufgefallen sind.

## Selbst ausführen

```bash
pip install torch --index-url https://download.pytorch.org/whl/cpu
```

```bash
pip install -r requirements.txt
```

```bash
python -m hw.train --out runs/v1
```

```bash
python scripts/compare.py runs/v1/best --out vergleich.png
```

```bash
python scripts/publish_model.py runs/v1/best
```

Das Training braucht keine Grafikkarte; auf vier CPU-Kernen dauert ein Lauf
etwa eine Stunde. Für den Zugriff auf die privaten Repos muss `HF_TOKEN`
gesetzt sein.

## Übersicht aktualisieren und nachtrainieren

Beides hängt an einem Knopf: im GitHub-Repo unter *Actions → Übersicht
aktualisieren und neu trainieren → Run workflow*. Der Lauf

1. erzeugt aus den Rohaufnahmen die Tabelle für den Dataset Viewer von
   `handwriting-fable` (Vorschaubild, Text, Schreiber, Datum),
2. trainiert das Modell neu, wenn mindestens 20 neue Zeilen dazugekommen sind
   (mit dem Haken *force* auch bei weniger), und legt es im Modell-Repo ab; die
   Web-App lädt es beim nächsten Öffnen.

Es gibt keinen Zeitplan, der Lauf startet nur von Hand. Nötig ist das
Repository-Secret `HF_TOKEN` (Hugging-Face-Token mit Schreibrecht). Als
Ausweichweg gibt es `notebooks/nachtrainieren.ipynb` für Google Colab.

## Training aus der App

Im Tab *Training* startet ein Knopf das Training auf einem kleinen, kostenlosen
Hugging-Face-Space (`<konto>/handschrift-training`, Code in `trainer/`). Er
führt dasselbe `scripts/retrain.py run` aus wie der GitHub-Lauf. Jeder Lauf,
egal wo, schreibt seinen Fortschritt nach `training/` im Modell-Repo
(Stand, Probebild, Zwischenstand zum Fortsetzen); die App zeigt ihn an und
kann ihn abbrechen. Den Space einmal anlegen bzw. aktualisieren:

```bash
python scripts/deploy_trainer.py
```

## Herkunft und Lizenzen

- Vortrainierte Gewichte: [pytorch-handwriting-synthesis-toolkit](https://github.com/X-rayLaser/pytorch-handwriting-synthesis-toolkit)
  von Evgenii Dolotov, MIT-Lizenz. Sie wurden auf der IAM On-Line Handwriting
  Database trainiert, die nur nicht-kommerzielle Forschung erlaubt. Dieses
  Projekt ist für den privaten Gebrauch gedacht.
- Modellarchitektur: Alex Graves, „Generating Sequences With Recurrent Neural
  Networks“ (2013).
