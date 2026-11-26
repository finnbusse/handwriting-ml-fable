# Handschrift – technical specification

One writer's handwriting as a model: type text, get pen strokes in that hand.
This file is the contract between the parts of the system. German is the UI
language; code, comments and docs are English.

## 1. Parts

```
recordings (Hugging Face datasets)
   legacy sets (words, digits, 17 lines)  +  finnbusse/handwriting-fable (new, hwline/v1)
        │  hw.sources -> hw.prep -> hw.dataset      (clean, size-normalise, resample, compose lines)
        ▼
fine-tuning (hw.train)   pretrained Graves network (MIT weights) -> the writer's hand
        │  hw.export                                 (model.bin float16 + model.json)
        ▼
web app (web/, static, no backend)
   Erfassen  : record lines with the pen -> upload to handwriting-fable
   Schreiben : text -> strokes, entirely in the browser -> SVG / PNG
```

## 2. Web app

Static files only, no build step, no framework, ES modules, no runtime CDN
imports (everything vendored; the app must work offline once installed).
Target: Chrome and Samsung Internet on an Android tablet with S Pen (landscape),
also usable on phones and desktop. Installable PWA.

```
web/
  index.html  styles.css  manifest.webmanifest  sw.js  icons/
  config.js                 repo names, app version
  js/main.js                boot, view switching (hash routes: #/schreiben #/erfassen #/training #/einstellungen)
  js/hf.js                  Hugging Face: sign-in, whoami, commit, private file download
  js/store.js               IndexedDB: outbox of recorded lines, settings, progress
  js/capture/recorder.js    raw pointer capture (no rendering, no policy)
  js/capture/hwline.js      build / validate an hwline/v1 record
  js/capture/qa.js          automatic checks on a finished line
  js/capture/view.js        the Erfassen screen
  js/generate/…             the Schreiben screen
  js/training/…             the Training screen (status from the model repo, runs on GitHub Actions via .github/workflows/retrain.yml; hw/progress.py has the format)
  js/engine/…               the network in JavaScript
  prompts/de-core.json      what the writer is asked to write
  model/                    model.json + model.bin (not in git; fetched from the model repo)
```

### 2.1 Hugging Face

| Thing | Repo | Visibility |
|---|---|---|
| new recordings | dataset `<user>/handwriting-fable` | public (the writer's choice; the app also works with a private one) |
| trained model  | model `<user>/handwriting-fable-model` (every version under `models/<id>/`, listed in `models/index.json`; the root is a copy of the newest; see `hw/models.py`) | private |
| app            | static Space (app shell only: no data, no weights) | public |

`<user>` is the signed-in account (`/api/whoami-v2`), never hard-coded.

Sign-in, two ways behind one interface (`hf.js`):

1. **"Mit Hugging Face anmelden"** – OAuth with PKCE as a full-page redirect.
   Only available when the app runs on a Space with `hf_oauth: true`
   (`window.huggingface.variables.OAUTH_CLIENT_ID` is injected there);
   scopes `openid profile write-repos`.
2. **Token einfügen** – a fine-grained token pasted once (works everywhere,
   including localhost).

The token lives in `localStorage` with its expiry; a 401 clears it and asks
the user to sign in again without losing queued recordings.

Upload = one NDJSON POST per batch, plain `fetch`:

```
POST https://huggingface.co/api/datasets/<user>/handwriting-fable/commit/main
Authorization: Bearer <token>          Content-Type: application/x-ndjson
{"key":"header","value":{"summary":"Erfassung: 12 Zeilen"}}
{"key":"file","value":{"path":"raw/v1/<writer_id>/<session_id>/<prompt_id>__<id>.json","content":"<json text>","encoding":"utf-8"}}
…
```

One file per line; the path contains the line id, so a retried upload
overwrites instead of duplicating, the prompt id, so progress can be
restored from a file listing alone, and the writer id (the folder), so that
progress is told apart per writer. Several people may record on one device: a writer types a short
name once, `writer_id` is its slug (lowercase, ä/ö/ü/ß as ae/oe/ue/ss, other characters reduced to
`a-z 0-9 -`, at most 24 characters) and `writer_name` the name as typed; both are set on every record and a stored
line keeps its writer. No writer is built into the app. At most 25 lines per commit. Lines are
written to IndexedDB *before* any upload attempt and are never deleted from
the device. A line is `queued` until its commit answers 2xx (`sent`), and
counts as safe (`verified`) only once it shows up in a complete listing of
`raw/v1`; a line that a complete listing does not contain goes back to
`queued` and is uploaded again (same path, so nothing is duplicated). A
listing that fails or is cut off changes nothing. The settings screen says
how many lines are safe ("Alle 47 Zeilen sind sicher gespeichert.") and has
"Jetzt prüfen".

After the raw lines, in a separate best-effort commit, the app writes what
the Dataset Viewer shows: `preview/<writer>/<session>/<prompt>__<id>.png`
and that session's `metadata.jsonl` (columns as in
`scripts/rebuild_preview.py`, which can rebuild all of it at any time). A
failed preview never affects the raw lines. The outbox is flushed after every accepted line (debounced:
when 5 lines are waiting, when the session ends, when the app starts, when the
browser comes back online). If the dataset repo does not exist the app offers
to create it (`POST /api/repos/create`, `{"type":"dataset","name":"handwriting-fable","private":true}`).

**Meine Zeilen** (`#/zeilen`, `js/library.js`; reached from "N Zeilen geschrieben" on the
capture screen and from Einstellungen) lists the current writer's lines: a listing of
`raw/v1/<writer>` merged with the lines waiting on the device, newest first, in portions of
30 with lazily loaded images (the preview PNG, else drawn from the record). Every request
carries the token (the dataset may be private). Two actions, each one commit that touches
only that line's session:

- *Text korrigieren*: `text` changes, `prompt.text` stays, `text_edit {at, original, count}`
  is set; the raw JSON is overwritten at its path and that one row of the session's
  `metadata.jsonl` is replaced (other rows stay byte for byte). A line still waiting is
  only changed on the device.
- *Löschen* (after a confirmation): `deletedFile` for the raw JSON and the preview PNG
  (those a listing of the session shows), and `metadata.jsonl` without the row (deleted
  when it was the last row). On the device the line becomes a tombstone (state `deleted`):
  never uploaded again, not missing, waiting or safe, not written (its prompt comes back),
  not in the backup. Needs the network; a failure changes nothing.

Both run between upload/preview commits (`outbox.exclusive`); uploads re-read their lines
inside that lock and previews built before it are rebuilt. A failed listing keeps the
last complete one on screen. Only this confirmed delete ever sends a `deletedFile`.

### 2.2 Recording format: `hwline/v1`

Schema: `docs/schema/hwline_v1.schema.json` (+ example). One JSON object per
recorded line, columnar strokes (`x[] y[] t[] p[] tiltX[] tiltY[]`), raw and
unprocessed: unrounded CSS-px coordinates relative to the canvas, per-sample
`event.timeStamp`, pressure and tilt as delivered (0 is a legal value), the
pointer-up sample kept outside the arrays. All later processing happens in
Python and can be redone at any time, so the recorder never smooths, thins,
rescales or reorders anything.

### 2.3 Erfassen (capture)

Rules that come from measurements on this writer's earlier recordings:

- Pointer Events only: `pointerdown`, `pointerrawupdate` **and** `pointermove`,
  always iterating `getCoalescedEvents()`, de-duplicating by strictly
  increasing `timeStamp`. Never store predicted events.
- Pen only (`pointerType === "pen"`); finger touches are ignored and counted.
  A settings switch allows finger/mouse for testing; such lines are marked in
  `pointer.type` and are not used for training by default.
- `touch-action: none` on the canvas, `overscroll-behavior: none` on the page,
  no text selection, no context menu, no text inputs on the capture screen.
- One line per screen. The prompt is shown above the writing band in a neutral
  typeface. The baseline always sits at the same place (its y is stored).
- "Stift & Papier" (a button next to the toolbar, the same options in the
  settings; remembered per writer on the device): pen Fineliner (constant
  width), Füller (width follows smoothed pressure) or Bleistift (grey graphite,
  tone follows pressure); five ink widths 0.75–3 CSS px (default 1); paper with
  one baseline (default), ruled or squared at 28 CSS px; dark ink on a light
  sheet (default) or light on dark, independent of the app theme. A change
  mid-line redraws the strokes, never discards them. These options change only
  what is shown: the samples stay raw and identical (`js/capture/ink.js` draws,
  the recorder never sees the options); `guides` reports what was shown (`pen`,
  `ink_width_css`, `pressure_width`, `paper`, `spacing_css`, `scheme`,
  `extra_lines_y`/`extra_lines_x`, `display_changed`).
- Buttons sit outside the canvas and are ignored for 300 ms after a stroke
  (or an eraser contact) ends, so a resting pen never becomes a "stroke" or a
  click; during that time they do not look pressed either. A button pressed
  by a touch while another touch rests on the screen (a palm) is ignored, and
  only that contact's click. Instant actions (Rückgängig, Wiederholen,
  Radieren and its bar) have no double-activation lock: every tap does
  exactly one step.
- Flow: write → **Fertig** → confirm screen shows prompt and ink side by side
  ("Genau so geschrieben?") → **Ja, weiter** / **Nochmal** / **Zurück zum
  Blatt** (back to writing with the line and its history kept, e.g. to erase
  a flagged stroke). No auto-advance. Skip prompt (comes back later).
- The toolbar is one row of fixed height at every width, every button at least
  48x48. `view.js fitTools()` measures it and, only as far as needed, tightens
  the spacing, drops the labels of the rarer buttons, then all tool labels, and
  on a phone puts Überspringen, Stift & Papier and Vollbild behind **Mehr**.
- Removing writing. Rule: **removing never reorders, new strokes always go at
  the end.** The model learns strokes in the order they were written, and that
  order must follow the text; so a stroke can never be rewritten in place.
  - **Rückgängig** takes back the newest step, **Wiederholen** (icon only)
    does it again. One history per line covers every stroke, every erase and
    **Löschen** (whole line); writing a new stroke empties Wiederholen. It
    lives in memory only and ends with the line (new prompt, Nochmal, skip,
    pause, writer switch), or when the sheet moved while the line was empty.
  - **Radieren** ("back to here"): the toolbar row turns into
    [Abbrechen] status [Entfernen] at the same height. A pen tap (or slide)
    on a stroke chooses it and everything written after it; those strokes are
    marked red and the status says how many. Nothing goes before **Entfernen**;
    Abbrechen changes nothing; Rückgängig brings an erase back. A stroke that
    `qa.js` calls a stray mark (tiny, far from all ink) goes on its own.
    Eraser contacts are never recorded or counted. A miss while nothing is
    chosen says so and that Abbrechen goes back to writing. Holding the S Pen
    side button (or using the eraser end) while touching the writing opens a
    temporary eraser there; held over empty paper it does nothing special (the
    stroke is recorded and flagged `button_pressed`), and the next contact
    without the button closes the temporary eraser and writes. In finger mode a
    pen contact takes the eraser over from a resting palm, as when writing.
  - Removing only takes strokes out of the array: what stays keeps every
    sample and timestamp, `t` stays strictly increasing, and new strokes come
    after the last stored `t`. Timestamps are never shifted, so after a stray
    first stroke was removed on its own, `t = 0` (and `t0_epoch_ms`) belongs
    to that removed stroke: the first stored `t` is then above 0 and
    `removed_t` starts at 0. When the line becomes empty its time base and
    the recorder's anomaly counters start over (both come back with the
    strokes on Rückgängig); the counters `touch_ignored`, `non_monotonic`,
    `same_t_dropped` cover everything since the line was last empty, removed
    writing included, while `cancelled`, `button_strokes` and `pointer.api`
    come from the stored strokes. Removed strokes never reach the record;
    `edits` counts what happened (`undo`, `redo`, `clear`, `erase`,
    `erased_strokes`, `spot`) and `removed_t` holds the time spans of removed
    writing in the record's time base (strokes from an earlier time base,
    after a Löschen that was taken back, are moved into it).
  - Drawing: live ink goes straight onto the low-latency canvas; any other
    change of the sheet is composed off screen and shown with one
    `drawImage`, so no wiped or half-drawn sheet reaches the screen.
    Pictures of the sheet after every 8th stroke (the newest 3 and bare paper)
    keep undo short; an erase keeps the newest picture it made untrue, so
    taking the erase back does not redraw the whole line.
- Automatic checks before accepting (`qa.js`); a failed check shows a short
  German hint and suggests "Nochmal", but the writer may still accept (the line
  is then stored with `status: "flagged"` and the flags): stroke count outside
  0.4–2.0 per non-space character, a tiny stroke far from everything else,
  samples outside the canvas, `pointercancel`, pen button pressed, sample rate
  below 200 Hz (this writer's S Pen delivers about 480 Hz; 120 Hz means the
  browser is not passing on the intermediate samples), layout change during the line,
  a stroke added later well left of the ink before it (`late_stroke`: right
  edge more than max(30 px, 4 median stroke heights) left of the rightmost ink
  so far; dots and crosses right after a word stay well inside that).
- Sessions of 20 lines with a progress display; the writer can stop at any
  time and continue later on any device (progress = which prompt ids already
  exist in the dataset under this writer's folder + this writer's lines in the
  local outbox). Recording needs a current writer, asked for ("Wer schreibt?")
  on the start screen and changeable in the settings, never on the capture
  screen; switching starts a new session id. The capture screen shows the
  writer's name next to the progress, and the number of lines written
  instead of a total.
- Screen wake lock where available. Fullscreen only on request (a "Vollbild"
  button; the app never switches or locks the orientation by itself), and
  everything fits with the browser bar visible. Entering or leaving fullscreen
  during a line pauses it like any other layout change. Failures of these must
  never block recording.

### 2.4 Prompts

`web/prompts/de-core.json`, set `de-core@3`, 2491 prompts in 125 blocks
(the last block has 11 lines):

```json
{"set": "de-core@3", "prompts": [{"id": "de-core-0001", "text": "…", "lang": "de", "block": 1}, …]}
```

The app shows prompts block by block in file order and tracks progress by
prompt id, so an id keeps its text for ever. `block` is the position in the
file: (position − 1) // 20 + 1.

- Only characters of the model alphabet (`hw/charset.py`, `DEFAULT_CHARSET`).
- 18–40 characters per line (the tablet shows one line; training cuts lines
  into word groups of at most ~27 characters, so longer lines are fine).
- Natural everyday German the writer would really jot down (notes, lists,
  dates, times, short messages, school, free time, food, weather, little
  thoughts, direct speech), some English lines, no real persons, no personal
  data, nothing awkward to write.
- History: ids 0001–0800 are de-core@2 with unchanged texts (snapshot
  `data/prompts/de-core@2.json`, checked against git). Positions 1–160
  (blocks 1–8) are exactly those of de-core@2. Ids from 0801 are the lines of
  `data/prompts/additions.txt` (grouped by category) in file order, minus the
  ones that duplicate or nearly duplicate an earlier prompt (same text ignoring
  case and punctuation, nearly the same words, or nearly the same characters).
- Blocks 1–2 alone contain every lowercase and uppercase letter incl. ä ö ü ß
  Ä Ö Ü, every digit at least 3 times, and `. , ! ? : - ( ) " '`.
- From position 161 on the order serves two goals at once:
  - Coverage first: rare character pairs come early, and the rarest characters
    (Ä Ö Ü % € C E L N O Q V X Y) follow a schedule: two more per block until
    each has been offered 30 times (counted from position 1; by about position
    480; `%`, X and Y have fewer lines than that, so all of them come early),
    then the rest spread evenly. While Ä, Ö or Ü is below 30 every block
    contains it and at least 3 capital umlauts; afterwards no two blocks in a
    row are without one.
  - Variety always: never two neighbours of the same category (additions carry
    one; for de-core@2 lines: English, digit-heavy, direct speech, list-like,
    plain sentence) or with the same first word; at most one digit-heavy line
    (3+ digits) among any four neighbours and at most four per block; at most
    two English lines per block; every block has at least two lines of ≤ 28
    and two of ≥ 37 characters.
- `scripts/build_prompts.py` rebuilds the file deterministically from the
  snapshot and `additions.txt`; `scripts/check_prompts.py` verifies all of the
  above and prints a coverage table per 100 prompts (`--reproduce` also
  rebuilds and compares byte for byte).

### 2.5 Schreiben (generate)

Two things on the screen: the sheet, and below it the line where the text is
typed. The sheet is always there and fills the height; without a model it
says why and what to do. Between the two sits one quiet row: what is going on
(left) and three tools (right): **Nochmal** (same text, new random sample),
**Stil** (opens in place, so the sheet stays in view while it changes) and
**Speichern**. "Schreiben" turns into "Abbrechen"
while the pen is running. Ctrl/Cmd + Enter writes.

**Stil** holds the look of the page, with the same words and the same
drawing code as the capture sheet (`capture/ink.js`): Stift (Fineliner,
Füller, Bleistift), Strichstärke (five steps, relative to the x-height),
Größe, Papier (Blanko, Liniert, Kariert; the text baselines sit on the
lines) and Farben (dark on light, light on dark); "Erweitert" adds
Lesbarkeit, Zeilenabstand and Tinte. Generated strokes carry no pressure, so
Füller and Bleistift take it from the pen's speed. Until the writer changes
something here, the page looks like their capture sheet. None of these
options runs the network again. Speichern exports what is shown (PNG, SVG,
copy) or the ink alone on a transparent background ("Ohne Papier").

Long text is wrapped into lines; each line is generated in word groups of at
most ~27 characters that are placed on a common baseline with the writer's own
word spacing (`gap_xh` in `model.json`). Lesbarkeit (bias) regenerates;
size and line spacing only lay the finished pieces out again; ink only redraws.
The UI typeface (Instrument Sans, OFL) is bundled in `web/fonts/`.

### 2.6 Engine

`js/engine/` loads `model.json` + `model.bin` (see `hw/export.py`) and
reproduces `hw.model.SynthesisNetwork.sample` exactly. Reference vectors for a
numerical comparison come from `scripts/make_engine_fixture.py`.

## 3. Python package `hw`

| Module | Role |
|---|---|
| `charset.py` | alphabet (pretrained English set + appended German characters), text normalisation |
| `model.py` | the network; loads the pretrained weights unchanged |
| `sources.py` | loaders for every recording format, raw pixel coordinates |
| `prep.py` | baseline, x-height, time resampling |
| `dataset.py` | exclusions, calibration against the base model, composing lines |
| `train.py` | fine-tuning |
| `sampling.py` | text → ink |
| `export.py` | checkpoint → browser files |

Units: recordings are converted to **xh units** (1.0 = the writer's x-height,
baseline at y = 0, y down). The network works in the units of its pretraining
data; `xh_model` (model units per x-height) in `meta.json` / `model.json`
connects the two.
