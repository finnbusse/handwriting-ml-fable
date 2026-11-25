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
  js/main.js                boot, view switching (hash routes: #/schreiben #/erfassen #/einstellungen)
  js/hf.js                  Hugging Face: sign-in, whoami, commit, private file download
  js/store.js               IndexedDB: outbox of recorded lines, settings, progress
  js/capture/recorder.js    raw pointer capture (no rendering, no policy)
  js/capture/hwline.js      build / validate an hwline/v1 record
  js/capture/qa.js          automatic checks on a finished line
  js/capture/view.js        the Erfassen screen
  js/generate/…             the Schreiben screen            (phase 2)
  js/engine/…               the network in JavaScript        (phase 2)
  prompts/de-core.json      what the writer is asked to write
  model/                    model.json + model.bin (not in git; fetched from the model repo)
```

### 2.1 Hugging Face

| Thing | Repo | Visibility |
|---|---|---|
| new recordings | dataset `<user>/handwriting-fable` | private |
| trained model  | model `<user>/handwriting-fable-model` | private |
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
written to IndexedDB *before* any upload attempt and leave the outbox only
after a 2xx answer. The outbox is flushed after every accepted line (debounced:
when 5 lines are waiting, when the session ends, when the app starts, when the
browser comes back online). If the dataset repo does not exist the app offers
to create it (`POST /api/repos/create`, `{"type":"dataset","name":"handwriting-fable","private":true}`).

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
  ends, so a resting pen never becomes a "stroke" or a click.
- Flow: write → **Fertig** → confirm screen shows prompt and ink side by side
  ("Genau so geschrieben?") → **Ja, weiter** / **Nochmal**. No auto-advance.
  Undo last stroke, clear line, skip prompt (comes back later).
- Automatic checks before accepting (`qa.js`); a failed check shows a short
  German hint and suggests "Nochmal", but the writer may still accept (the line
  is then stored with `status: "flagged"` and the flags): stroke count outside
  0.4–2.0 per non-space character, a tiny stroke far from everything else,
  samples outside the canvas, `pointercancel`, pen button pressed, sample rate
  below 200 Hz (this writer's S Pen delivers about 480 Hz; 120 Hz means the
  browser is not passing on the intermediate samples), layout change during the line.
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

`web/prompts/de-core.json`:

```json
{"set": "de-core@1", "prompts": [{"id": "de-core-0001", "text": "…", "lang": "de", "block": 1}, …]}
```

- Only characters of the model alphabet (`hw/charset.py`, `DEFAULT_CHARSET`).
- 18–40 characters per line (the tablet shows one line; training cuts lines
  into word groups of at most ~27 characters, so longer lines are fine).
- Natural everyday German the writer would really jot down (notes, lists,
  dates, times, short messages), a few English lines, no real persons, no
  personal data, nothing awkward to write.
- Blocks of 20. Blocks 1–2 alone must contain every lowercase and uppercase
  letter incl. ä ö ü ß Ä Ö Ü, every digit at least 3 times, and `. , ! ? : - ( ) " '`.
  Later blocks balance letter and bigram frequencies and add the rarer signs.
- `scripts/check_prompts.py` verifies all of the above and prints coverage.

### 2.5 Schreiben (generate) – phase 2

Text box → handwriting on a paper-like canvas, written out stroke by stroke.
Controls: Lesbarkeit (bias), Schriftgröße, Zeilenabstand, Strichstärke, Farbe,
"Nochmal schreiben" (new random sample), export SVG / PNG / copy. Long text is
wrapped into lines; each line is generated in word groups of at most ~27
characters that are placed on a common baseline with the writer's own word
spacing (`gap_xh` in `model.json`).

### 2.6 Engine – phase 2

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
