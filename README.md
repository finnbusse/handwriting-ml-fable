# Handschrift

Text eingeben, die eigene Handschrift kommt heraus. Ein kleines neuronales Netz
wird auf die Stiftaufnahmen einer Person feingetunt und läuft danach komplett
im Browser.

**Stand:** Das Training auf den vorhandenen Aufnahmen läuft, die Erfassungs-App
für neue Zeilen ist im Bau. Details zum Aufbau stehen in
[docs/SPEC.md](docs/SPEC.md).

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
pip install torch numpy pandas pyarrow matplotlib huggingface_hub
```

```bash
python -m hw.train --out runs/v1
```

```bash
python scripts/compare.py runs/v1/best --out vergleich.png
```

```bash
python -m hw.export runs/v1/best web/model
```

Das Training braucht keine Grafikkarte; auf vier CPU-Kernen dauert ein Lauf
etwa eine Stunde. Für den Zugriff auf private Datasets muss `HF_TOKEN` gesetzt
sein.

## Herkunft und Lizenzen

- Vortrainierte Gewichte: [pytorch-handwriting-synthesis-toolkit](https://github.com/X-rayLaser/pytorch-handwriting-synthesis-toolkit)
  von Evgenii Dolotov, MIT-Lizenz. Sie wurden auf der IAM On-Line Handwriting
  Database trainiert, die nur nicht-kommerzielle Forschung erlaubt. Dieses
  Projekt ist für den privaten Gebrauch gedacht.
- Modellarchitektur: Alex Graves, „Generating Sequences With Recurrent Neural
  Networks“ (2013).
