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

`web/prompts/de-core.json`, set `de-core@5`, 3252 prompts in 163 blocks
(the last block has 12 lines):

```json
{"set": "de-core@5", "streams": {"eszett": [["de-core-2808", "de-core-2880"]], "rows": [["de-core-2881", "de-core-3252"]]},
 "prompts": [{"id": "de-core-0001", "text": "…", "lang": "de", "block": 1}, …]}
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
  (blocks 1–8) are exactly those of de-core@2 and stay frozen (all written).
  Ids 0801–2807 are the lines of
  `data/prompts/additions.txt` (grouped by category) in file order, minus the
  ones that duplicate or nearly duplicate an earlier prompt (same text ignoring
  case and punctuation, nearly the same words, or nearly the same characters).
  Ids 0001–2807 in the order of de-core@4 (snapshot `data/prompts/de-core@4.json`,
  checked against git) are the main sequence.
- Two streams are woven into the main sequence from position 161 on (ids in
  `streams`, so training can tell rows from sentences):
  - ß sentences, ids 2808–2880: the 73 lines of `data/prompts/eszett.txt`
    (ordinary sentences with ß; the recordings held 29 ß in all), in file order.
  - Word rows, ids 2881–3252: the 372 lines of `data/prompts/rows.txt`, 3–6
    unrelated words or numbers each, in file order. Training cuts a row into its
    words; they replace about 1,400 older single-word recordings in an older
    hand. The first rows pack capital umlauts and ß densely.

  In every block after the frozen ones, slots 3, 7, 11, 15 and 19 hold the next
  rows and slots 5 and 13 the next ß sentences while each stream lasts (rows up
  to position 1647, ß sentences to 885); all other slots hold the main sequence
  in its order. Removing the stream entries gives de-core@4 exactly. Stream
  lines are checked for alphabet, length and exact duplicates; ß sentences also
  for near-duplicates. De-core@5 is published, so no stream line is moved,
  changed or removed (checked against its git commit); a new line goes at the
  end of its file and takes the next free id (3253 on), added as a further
  range of that stream in `streams`. The variety rules below apply to the main sequence;
  per block (number rows count as digit-heavy) at most four digit-heavy lines,
  six lines with digits and two English lines hold in the woven blocks too.
- Blocks 1–2 alone contain every lowercase and uppercase letter incl. ä ö ü ß
  Ä Ö Ü, every digit at least 3 times, and `. , ! ? : - ( ) " '`.
- From position 161 on the main sequence (de-core@4) serves three goals:
  - Focus: its positions 161–220 are rich in what the trained model writes
    worst (Ä Ö Ü T at a word start, the 'über' family, Q X Y C J j, ä ü, every
    digit, the scarce signs; minimums `FOCUS` in `build_prompts.py`), 221–420
    at half that rate, and neither below what de-core@3 offered there.
  - Coverage: rare character pairs come early, and the rarest characters
    (Ä Ö Ü % € C E L N O Q V X Y) follow a schedule: two more per block until
    each has been offered 30 times (counted from position 1; by about position
    440 in the main sequence, 570 in de-core@5, where Ä Ö Ü get there by 261),
    then the rest spread evenly. While Ä, Ö or Ü is below 30 every block
    contains it and at least 3 capital umlauts; afterwards no two blocks in a
    row are without one (this holds in the woven blocks too).
  - Variety: never two neighbours of the same category (additions carry
    one; for de-core@2 lines: English, digit-heavy, direct speech, list-like,
    plain sentence) or with the same first word; at most one digit-heavy line
    (3+ digits) among any four neighbours and at most four per block; at most
    two English lines per block; every block of the main sequence has at least
    two lines of ≤ 28 and two of ≥ 37 characters (rows are mostly long: 10 woven
    blocks miss it, block 9, the writer's next, has no short line).
- The writer's next 60 prompts (positions 161–220 of de-core@5: 39 of the main
  sequence, 15 rows, 6 ß sentences) hold ß in 18 lines, Ä/Ö/Ü at a word start in
  16/16/17, Q 6, X 5, Y 6, C 7, J 7. The 21 stream slots cost signs that rows do
  not carry: `# & ' * €` 2 times, `/ @` once, `%` not at all (de-core@4 had 3
  each there); X has only two rows.
- `scripts/build_prompts.py` rebuilds the main sequence deterministically from
  the snapshots and `additions.txt`, compares it with `de-core@4.json` and
  weaves in the streams; `scripts/check_prompts.py` verifies all of the above
  and prints a coverage table per 100 prompts (`--reproduce` also rebuilds and
  compares byte for byte).

### 2.5 Schreiben (generate)

Two things on the screen: the sheet, and below it the line where the text is
typed. The sheet is always there and fills the height; without a model it
says why and what to do. Between the two sits one quiet row: what is going on
(left) and three tools (right): **Nochmal** (same text, new random sample),
**Stil** (opens in place, so the sheet stays in view while it changes) and
**Speichern**. "Schreiben" turns into "Abbrechen"
while the pen is running. Ctrl/Cmd + Enter writes.

**Stil** holds the look of the page, with the same words and the same pens
as the capture sheet (`capture/ink.js`: samples, pressure, widths, tones,
grain; a finished word is stroked as one path per tone or width, not piece by
piece: 1 311 instead of 101 799 calls for an A4 page in Bleistift): Stift
(Fineliner, Füller, Bleistift), Strichstärke (five steps, relative to the x-height),
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
The sheet and the pages are drawn by a worker (`paint-worker.js`, the canvases
handed over with `transferControlToOffscreen`; without it on the main thread):
the writing animation redraws only the box of the word being written. The
sheet's ink is a stack of strips 512 device px tall, so a frame hands the
compositor the strip or two the pen is in, not the whole sheet; the paper
canvas grows by half at a time. Ink and paper hold at most 16 Mpx each; past
that the ink is drawn again at a lower resolution.
The UI typeface (Instrument Sans, OFL) is bundled in `web/fonts/`.

### 2.5.1 Seite: layout and PDF (`js/generate/document.js`, `pdf.js`)

The page mode writes a typed text onto A4 pages (210 × 297 mm, portrait). All
geometry is in millimetres, y down, from the top left corner.

- Paper: **Liniert** – a line every 8 mm from 24 mm down, the last one at least
  12 mm above the edge (33 lines), across the full width. **Kariert** – a 5 mm
  grid centred on the page (lines at y = 1, 6, …), writing on every second grid
  line (10 mm, 26 lines from 26 mm); the margin x = 20 mm is a grid line.
  **Blanko** – no ruling, the lines of Liniert. Margins 20 mm left, 15 mm right.
- Letter size: x-height = 0.16 / 0.18 / 0.21 × the line distance (Klein /
  Mittel / Groß; 1.44 mm on lines, 1.8 mm on squares for Mittel). Chosen by
  looking at pages and counting neighbouring lines whose ink touches: this
  hand's tops reach a median 3.5 x-heights above the baseline within a piece and
  its descenders 1.5. On a lined page of prose 0.25 touched on 16 of 36 line
  pairs, 0.21 on 12 of 31, 0.18 on 4 of 28 (three lined pages: 12 of 75).
- Text: one newline = a new line, an empty line = one empty line, trailing empty
  lines dropped. Paragraphs are cut into pieces (`layout.js: splitPieces`); piece
  i is written with seed `pieceSeed(seed, i, version)`, so the result does not
  depend on how many workers write or in which order; `version` counts rewrites.
- Layout: each written piece is straightened and cut into levelled words
  (`layout.js`); if its gaps are unclear, a looser cut is tried and kept only if
  the word widths fit their texts. Words flow greedily, ragged right; gaps inside
  a piece as written (clamped as on the quick sheet), between pieces the writer's
  gap (`gap_xh`) drawn per piece. Words `wordLevel` leaves alone (1–2
  characters, or bottoms more than 1.5 xh off) are set on the line by their own
  letter bottoms (`sitLine`, up to 2.5 xh); a piece with a word still more than
  0.5 xh off the line, a word reaching above 5 xh, or a long stroke lying more
  than 1 xh above the line is flagged (`flags`; 3 of ~200 test pieces) and the
  page mode writes it once more. A line starts at the margin ± at most 0.5 mm
  (sd 0.2 mm). A word wider than a line is scaled down onto a line of its own.
  Pages break when their lines are used up; an empty line never opens a page.
  Layout random numbers come from the document seed and the piece index only.
- Even letter size: every piece gets an estimate of its log letter size,
  0.85 × log(pen-down ink length / expected length of its characters) + 0.15 ×
  (log stroke size − what its text explains). On 322 real pieces scaled by a
  known factor (4-fold by line) its error is 0.136 (stroke size alone 0.220,
  ink alone 0.140), of which most is the real lines' own size (two pieces of one
  line: 0.085). A piece is pulled towards the median estimate of the first 12
  pieces (so nothing shown moves while the rest is written) by
  0.7 of its deviation (cov with an independent x-height fit / variance, measured
  on 117 generated pieces), clamped to ×0.8–1.25; words of 4+ characters
  additionally towards their piece by 0.46 (clamped ×0.85–1.18). A rewrite keeps
  the document's median, so nothing before the rewritten piece moves. The
  effect is modest: an independent x-height fit per piece spreads by sd 0.133
  (log) without evening and 0.112 with it; letter size still varies by about
  ×1.5 between the 5th and 95th percentile of pieces.
- The layout is a plain object (a structured document adds to it, 2.5.3) `{ settings, page, geometry, typical, pages:
  [{ strokes: Float32Array[x, y, penUp…] per word in mm, words: [{ text, piece,
  word, line, x, width, baseline, box }] }], pieces }`. The screen
  (`render.js: drawDocumentPage`) and the PDF read the same object; pens, widths
  and colours are those of the quick sheet with the page's x-height as unit.
- PDF (`pdf.js`, written by hand, PDF 1.4): one page per document page, the
  paper colour on dark paper, the ruling (0.16 mm, the scheme's rule / faint
  colour), the ink as stroked paths with round caps and joins (Fineliner: the
  screen's curves as Béziers; Füller: 13 width steps; Bleistift: 8 tones as
  opacity with Darken / Lighten blending, no grain). Coordinates in pt, 2
  decimals; content streams deflated where `CompressionStream` exists. Title
  (UTF-16) and creation date in the info dictionary. An invisible text layer
  (render mode 3, Helvetica, WinAnsi with umlauts, ß, €, „ “ –, other
  characters `?`) holds the words as typed (`planDocument` keeps them beside the
  model's folded text) and puts every word on its baseline stretched to its width, with its space widened
  to the next word so text tools read whole lines; it can be switched off.

### 2.5.2 Seite: interface and workers (`js/generate/page-view.js`)

A switch above the sheet chooses **Zettel** (the quick sheet above, unchanged)
or **Seite**. Seite shows A4 pages fitted to the column, one under the other and
scrollable, and its own multi-line text field (typing and pasting, up to 40 000
characters). Stil is shared; in Seite it shows **Schrift** (Klein / Mittel /
Groß) instead of Größe, Papier is the page's own, Zeilenabstand is hidden;
Lesbarkeit is read when writing starts. "Erweitert" adds a switch for the PDF's
text layer. Mode, text, paper, letter size and the text-layer switch are stored
(`kv: generateMode`, `kv: page`); the written pages live until the tab is
reloaded.

- Layout (`styles.css`, `editor-tools.js`). From 900 CSS px wide (a tablet in
  landscape, a desktop) the page mode fills the window under the tab bar in two
  columns: the text field on the left over the full height (40 % of the width, 320–560
  px), scrolling inside itself; the pages on the right (at most 880 px wide, centred),
  scrolling inside their column; the page itself does not scroll. One bar runs under
  both: under the text a switch that hides it, Formatierung, the detected format (it
  wraps out of sight where the half is too narrow) and Schreiben / Abbrechen at its right
  end; under the pages the status line, Stil, Teilen, PDF herunterladen. Formatierung
  and Stil open over their own half, above the bar, without moving anything, and scroll
  inside themselves; Stil there puts one option under the other where its half is
  narrower than 760 px. With the text hidden the pages are centred in the window and the
  bar keeps the switch and Schreiben; hidden or not is kept on the device (`localStorage
  hw.pageEditor`). Narrower (a tablet in portrait, a phone) the pages stay above and
  the text below; a switch at the end of the Formatierung row makes the field half the
  visible height over the whole width, Schreiben under it, and small again (kept too;
  while Stil or Formatierung is open the field is small, so Schreiben stays on screen), and a paste that overflows the small field
  while it has the focus makes it large by itself. Away from the keyboard the small
  field shows its first two lines.
- On-screen keyboard: it shortens the visual viewport, not the layout, so
  `editor-tools.js` reads `visualViewport` and sets `--pg-kb` (the height below what is
  visible) and `--pg-vh` (what is visible); the page mode ends above the keyboard, the
  large field is half of what is visible, the caret's line is scrolled back into the
  field, and on a phone and in the wide layout the Zettel/Seite switch steps aside while
  the keyboard is open.  A pinch zoom (`visualViewport.scale` above 1) is not taken for
  a keyboard.
  Schreiben stays on screen in both layouts (tested with a visual viewport of 420 px at
  1280 × 800 and 360 × 740, 960 px at 800 × 1280).
- Mark tools: one slim row of quiet words that scrolls sideways, the end that runs on
  out of sight fading out (wide: under the field;
  narrow: in the status row's place while the text has the focus, so it takes no line
  from the text). Überschrift, Liste, Kästchen, Merkkasten and Mitte act on every line
  the selection touches; kräftig, unterstreichen, markieren and Farbe on the selection
  (spaces at its ends left out, each line on its own, a list marker or heading never
  inside) or, at a caret, on its word (none: an empty pair with the caret inside); in
  Markdown a selection that starts or ends inside a word takes the whole word, because
  markup.js reads a mark only at a word's edge. `*` and `**` are read together (`***…***`
  is both) and written out flat again, so a tap never nests or cuts one star mark in
  another; in LaTeX a group is found by counting its braces. Pfeil and Datum are put in
  after the selection, with a space either side. A second tap takes a mark
  off (a pair just put in at the caret too); Kästchen goes empty → ticked → none, Farbe
  rot → blau → grün → none. Markdown (and Automatisch on a text read as Markdown) gets
  `# `, `- `, `- [ ] `, `> `, `{mitte} `, `**…**`, `*…*`, `==…==`, `[…]{rot}`, `->`,
  `{datum}`; LaTeX gets `\section{…}`, `\item `, `\item[$\square$] ` /
  `\item[$\checkmark$] `, `\begin{framed}`, `\begin{center}`, `\textbf{…}`,
  `\underline{…}`, `\hl{…}`, `\textcolor{red}{…}`, `$\rightarrow$`, `\today{}`; "Nur
  Text" has no row. Every change goes in through the browser's own editing
  (`execCommand('insertText')` on the part that changed), so it fires the same input
  event typing does and Strg+Z takes it back; the focus and the on-screen keyboard stay
  in the text. The text operations are pure functions (`applyTool`, `listKey`), tested
  in Node.
- Keys: on a list or check-list line Tab and Shift+Tab move it one level in or out (two
  spaces, at most two levels in; a line that cannot move leaves Tab its meaning); Enter goes on with the list (the next number or
  letter, an empty box after a ticked one, the same indent and box) and on an empty item
  ends it; Enter on a row of a box goes on with the box the same way. Shift+Enter is a
  plain line break; Strg+Enter writes. Enter is taken as an edit (`beforeinput`), so
  on-screen keyboards behave the same.

- Workers: `engine-client.js: createEnginePool`, hardwareConcurrency − 1, at
  most 4, 2 with deviceMemory ≤ 4 and 1 with ≤ 2; each worker holds its own
  copy of the model, read on its own thread from one Blob of `model.bin`.
  Pieces are handed out in text order; piece i always gets
  `pieceSeed(seed, i, version)`, so one worker and several write identical pages
  (tested). A rewrite goes ahead of the queue. A piece that fails is tried once
  more; an engine whose worker died is replaced by a fresh one (at most `size`
  times, then dropped), so one crash does not end the text (tested with a
  worker that dies). If a piece fails twice the run stops and the next one
  starts with new engines.
- While writing, the pages show every piece from the start of the text up to
  the first unfinished one (`layoutDocument` stops there); the view follows the
  last line until the writer scrolls. Pages within one screen height of the
  viewport are drawn (each at most 8 Mpx), a page only with its new words while
  the text grows; a drawn page keeps its canvas when it scrolls away (three in
  all), so scrolling draws nothing. The piece picked for rewriting is a box
  laid over the page (CSS `mix-blend-mode`), not drawn. The status reads
  "schreibt … 26 von 79 · Seite 2 · noch etwa 2 Min." with a bar; the time left
  is (time so far / pieces done) × pieces left, shown once every worker has
  finished one piece. "Abbrechen" stops all workers; what is written stays.
- Tap to rewrite: a tap (pointer moving less than 10 px) within 3 mm (finger),
  2 mm (pen) or 1.5 mm (mouse) of a word marks its piece and shows
  "Neu schreiben" next to it, under or over the piece where it hides the
  fewest other words (opening Stil drops the mark); only that piece is written again with the next
  version of its seed, the typical size is kept, so nothing before it moves. A
  tap on empty paper or Escape drops the mark. A rewrite lost to "Abbrechen"
  is named in the note. A paste cut at the field's 40 000 characters is named
  too.
- Paper and letter size lay the written pieces out again; pen, width, ink and
  colours redraw; a new text or Lesbarkeit needs "Schreiben". A newer model
  waits until nothing is being written.
- Drawn by keys: every stroke and highlighter band of a page has a key (its style and
  its exact first, middle and last points) and a box. A page draws its new strokes; where
  a stroke went or a band came (a frame growing with its box, an underline run getting
  longer, a rewritten piece and its neighbours) each such box (joined where they overlap)
  is drawn anew on its own, clipped to it: paper, ruling, bands, then every stroke that
  meets it. More than 40 % of the page: the whole page. A plain text (no `rich`) draws
  the whole page whenever anything on it went, as before: same pixels, tested against
  the earlier app in two looks. A document is laid out again at most once per frame
  while pieces arrive, not once per piece.
- Formatierung (`js/generate/format-help.js`): a quiet button under the Seite text field
  opens a panel in the style of Stil (one of the two at a time) that scrolls inside
  itself; Escape, a tap outside or the button close it, and focus goes in on opening and
  back to the button on closing. It shows `CHEAT_SHEET` of `markup.js` as a two-column
  list (what to type in monospace, what it gives; one column on a phone), the choice of
  format (Automatisch, Markdown, LaTeX, Nur Text; stored with the page settings,
  `format`, default auto; beside the button the detected format is named, nothing for
  plain text) and "Beispiel einsetzen", which puts a short page of school notes into the
  field and sets "Nur Text" back to Automatisch. On a filled field it first asks
  ("Text ersetzen" / "Behalten"); the replaced text comes back once with "Rückgängig" in
  the panel as long as the example is unedited (setting the field clears the browser's
  undo, and Android keyboards have none).
- "PDF herunterladen" (phone: "PDF") saves `handschrift-YYYY-MM-DD.pdf` from the
  same document object; "Teilen" appears only where the browser can share files.

### 2.5.3 Seite: documents with structure (`document.js`, `decor.js`, `pdf.js`)

Copied line breaks (`js/generate/unwrap.js`): a text copied from a web page, a
PDF or an e-mail keeps the line breaks of its source column (a law from
gesetze-im-internet.de: 70 characters), and a page row of this hand holds
about 55 characters, so every such line ran over by a word or two that stood
alone on a row. Before the text is parsed, `unwrapLines` joins such lines: the
column is the ninth decile of the lengths of the lines that have a line after
them (not the maximum, so that one line never wrapped does not hide it); a
line is full when the first word of the next line would not have fitted
behind it, or not into 0.8 of the column when the line does not end a
sentence (a source in a proportional font wraps by width, so its full lines
differ in their number of characters); the text counts as wrapped when the
column is at least 40 characters, at least 3 lines are full, of the lines at
least half the column wide at least two thirds are, not more than half of
the lines end a sentence (that is one sentence a line, typed so), and some
line after a full one starts with a small letter (running text goes on in
the middle of a sentence; titles or entries one a line do not). Then every full line is joined to the
next with one space. Lines that start a block of their own (heading, list
item, quote, table row, rule, alignment mark, an enumerator like "(1)") are
never joined to the line before, and two spaces, a backslash or `<br>` at the
end of a line keep its break. Short lines typed on purpose, poems, lists and
paragraphs typed in one line stay as they are. LaTeX texts are not touched (a
line break is a space there already). The note line says "Kopierte
Zeilenumbrüche zusammengeführt."; the switch "Kopierte Zeilenumbrüche
zusammenführen" in the Formatierung panel (on by default, stored) turns it
off.

`planDocument` also takes the document model of `markup.js` (`{ format, blocks:
[{ type, level, marker, align, box, lines: [[span]] }], notes }`); a string
behaves as before, and a document of plain paragraphs gives the same pieces,
seeds, positions and PDF bytes as its text (tested).

- Pieces: as for text, per typed line; a piece never crosses a block or a line.
  An arrow is a piece border unless a side of it has 3 characters or fewer:
  then both sides are one piece ("A -> B" is the piece "A B", "CO2 -> O2 und
  Wasser" one piece) and the layout places the written piece in two parts
  with the arrow between them (`piece.cuts`, the word indices where it is cut,
  and `piece.ats`; a line's items are `{ piece, from, to }` word ranges and
  `{ arrow }`). A run of words in one style (bold, underline, strike, highlighter,
  colour) of 4 or more characters gets piece borders of its own, so its
  decoration lands exactly even where the network's word gaps are unclear; a
  plain stretch of 3 characters or fewer between such runs joins the next piece
  (pieces that short write badly), so that border then relies on the word cut.
  Shorter runs stay inside a piece. Where a border falls inside a piece written
  as one (the cut failed), it is put at the clearest gap in the ink within 3 x-heights
  of where its letters should be (letter widths weighted: narrow i, l, t …,
  wide m, w); inside a word (`**Wort**.`) by the letter widths alone.
  `plan.stats` and `doc.stats` count runs, runs on piece borders, short runs
  inside pieces, and borders placed by `guessed` (gap) / `inWord`, and pieces
  written as one that had to be `cut` for an arrow or a label (`uncut` where
  one side would have held no ink: the arrow then follows the whole piece). On the
  proof documents (5 runs of 4+ characters out of 7 on borders in the lecture
  notes, 12 of 12 in the two-page text; one short run, cut cleanly) nothing
  had to be guessed.
- Blocks: heading 1 is written 1.45× larger, headings have a firmer stroke;
  heading 1 gets a double underline, heading 2 a single one, heading 3 none.
  A heading 1 that wraps puts an empty line between its rows (at 1.45× on
  8 mm ruling the rows' ink overlapped by up to 5 mm) and draws one line under
  each row, the double one under the last.
  An empty line before heading 1, before heading 2 unless it follows another
  heading, and after heading 1 (none at the top of a page). List items: level k indented (k − 1) × 4.2 x-heights;
  the bullet (dot, level 2 a dash) or check box sits at the indent, the text of
  every row of the item starts 3.6 / 6.0 x-heights after it (this hand's letters
  stand about 1.5 x-heights tall: 2.6 / 4.8 read as touching). A numbered item's
  label (it stays text) is written with the item's first words but placed on
  its own: at the indent, set on the line by the lowest point of its digits
  (`sitLine` reads the inner turns of a 3 or 5 as letter bottoms), and the
  text of every item of the list at that level, and of every later row, starts
  in one column, a word gap after the widest label. Where the label could not
  be cut off, the item hangs after it as written. Boxes (blocks with the same
  `box`): text 1.6 x-heights inside the frame, an empty line before and after;
  the frame runs 0.65 line pitches above the first row's and below the last
  row's middle of the writing (0.7 x-heights over the baseline), at least 0.6
  x-heights from the ink, with as much room above the ink as below, but never
  more than 1.25 pitches from those baselines. Centred and right-aligned rows are
  shifted after they are filled (±0.25 mm by eye). Rules take a row and are
  drawn at mid-letter height. Baselines stay on the ruling.
- Lines in parts (the school notebook's header: date left, title centred;
  name left, date right; subject, topic, class). Typed: `{mitte}` and
  `{rechts}` inside a paragraph or heading line split it into parts (at the
  start of a line they still align the whole line; a mark that would go back
  to the left, a repeated one, one after `\` or in code, and any in a list item
  stay as typed); `{datum}` anywhere is the date as written in a notebook,
  `26.11.2026` (`parseMarkup` option `today`); LaTeX: `a \hfill b` left and
  right, `a \hfill b \hfill c` left, centre, right (a third `\hfill` and any
  in a list item is a space). Model: spans with `part: 'center' | 'right'`
  (none = left) in that order; in a heading the centred part is the heading,
  else the left one, and the other parts' spans carry `body: true`. A line
  left with one part is an ordinary line (a leading mark: the block's `align`).
  Plan: a part border is a word and piece border; a part of 3 characters or
  fewer is written with its neighbour ("Erörterung 7b") and cut there again,
  as for arrows; the plan's line has `parts: true` and its items `part` /
  `body`. Layout: every part is first laid out as a line of its own alignment
  (left at the block's left edge, centre on the text width, right ending at
  the right edge, ±0.25 mm by eye); when each took one row and 3 letter widths
  of the writing (`PART_GAP`, measured on the parts' own words at body size)
  stay clear between them, they share one row and one baseline. A centred
  part is never moved off the middle to make room. A level-1 title that does
  not fit at its full size (1.45) is tried at 1.3, 1.15 and body size
  (`TITLE_FIT`) before the row is given up, the way a long title is written
  less large in a notebook: this hand writes "Die Weimarer Republik" 112 mm
  wide at full size and the date 32 mm, so on liniert (175 mm of text width)
  it shares the row at 1.15. Parts that fit at none of these sizes go onto
  rows of their own in reading order, each keeping its alignment, the title
  at full size, an empty line between a large title row and its neighbours. Body parts in a heading row are written
  at body size and stroke; the heading's underline (double for level 1) spans
  its part only; marks, highlighter and strike runs end at a part border. A
  line in parts is shown only once all its pieces are written. Text layer:
  the parts of a shared row on one line in reading order (`pdftotext -raw`,
  pypdf; `pdftotext` without `-raw` reads the wide gap as a column break).
- Tables. Typed: Markdown pipe tables (a header row, the delimiter row of
  `---` per column with `:` for left / centre / right, body rows; leading and
  trailing pipes optional; `\|` a pipe inside a cell; `<br>` a line break inside a
  cell; inline marks work in cells, block marks do not; the table ends at an empty
  line or a line without a pipe; a row with fewer cells is filled with empty ones,
  one with more adds columns, so nothing typed is lost). A line with pipes but no
  delimiter row, or one whose delimiter row has another number of cells, is text;
  a second delimiter row is dropped; past 64 columns the rest of a row goes into the
  last column, with a note.
  LaTeX: `tabular` (`tabular*`, `tabularx`, `tabulary`, `longtable`) with
  `l c r` (`p{…}`, `m{…}`, `b{…}`, `X` as `l`; `|`, `@{…}`, `>{…}` dropped; `*{n}{…}`
  repeated), rows split at `\\`, cells at `&`; `\hline`, `\toprule`, `\midrule`,
  `\bottomrule`, `\cline` … are read and dropped (the grid is always drawn in full),
  and a rule after the first row makes it the header; `\newline` breaks a cell's
  line; `\caption` inside a `\begin{table}` that holds a tabular is the table's
  caption wherever it stands (without one it stays text where it is typed, as
  before tables). What a table cannot show is written as lines of text, with a note: a table
  inside a list item or a box, merged cells (`\multicolumn`, `\multirow`), a table
  in a table; `array` (mathematics) stays text as before. Model: `{ type: 'table',
  columns: ['left' | 'center' | 'right'], rows: [{ head?: true, cells: [[span]] }],
  caption?: [span], lines }`, a cell a list of spans like a line, a break in it the
  span `{ text: '', br: true }`; `lines` are the rows' words (cells one space apart,
  then the caption) for code that reads only lines. Plan: one line per row (and one
  for the caption, `caption: true`), `head: true` on the header row, whose spans are
  written with the firmer stroke; every span, word and item carries its `cell` and
  `sub` (its text row inside the cell); a cell border and a break are piece and
  item borders. A cell of 3 characters or fewer is written with a longer neighbour
  and cut apart again by the layout (`cuts`, "1 Mathe"); between short neighbours
  (a timetable, a row of numbers, a row "| Ja |") it is written followed by a
  spare word, `Haus`, whose ink the layout drops (`spare: 1`, "Mo Haus"). Measured
  with the real model on 27 timetable cells × 10 seeds: the cell border lay in no
  real gap of the ink in 1 of 270 pieces with the spare word against 9 of 270
  pairs ("Mo Di"), and by eye 3-4 of 81 cells were misspelt against about 10 (the
  pairs wrote "3" as "ɔ", "En" as "tn", "Ek" as "Gh"); a whole run of short cells
  as one piece garbled the header on three of three seeds. A cut between cells
  must lie in a real gap (`CELL_GAP`, 1.5 x-heights: inside words 95 % of the gaps
  between strokes are under 1.15 and 99 % under 1.68, at word borders 95 % over
  1.89; every misplaced border seen, "D" | "iMi", "5M" | "Ma", "Fr1" | "0 C", lay
  under 1.45): `preparePiece` flags a table piece whose border gap is smaller or
  whose words do not come apart (`Zellgrenze …`), and the page writes it once more
  as it does any flagged piece. Only the table pieces of the document planned last
  are checked, so plain text and other documents are written as before. On 880
  short-cell pieces with the real model 52 were flagged and 1 of 890 borders stayed
  without a real gap after the retry (before: 15 of 570, unflagged). Layout (`TABLE_*`, `GRID_*`):
  a table is shown once all of it is written. Cells are written at 0.8 of body size
  (`TABLE_SIZE`), and the whole table at 0.9, 0.8 or 0.7 of that (`TABLE_FIT`)
  where its ink leaves too few rows room for a clear grid line: a row with no
  clear place for its line gets an empty ruled line more, and one such line in
  every fifth row weighs as much as writing 20 % smaller. at full size this hand's tall capitals and descenders fill the
  8 mm pitch (a piece reaches a median 3.5 x-heights up and 1.5 down), and on the
  liniert proof tables 23 of 56 grid lines came within 0.3 x-heights of the ink
  (21 words touched a line), at 0.85 14 (10), at 0.8 9 (5) – a person writes
  smaller in a table too. A number ("3", "12,50", "9,8") and a short word without
  a descender ("Mi", "mm", "C") sit on the line by the median of the lowest points
  of their strokes at least 0.5 x-heights tall: a comma's tail reaches below the
  line, and the letter-bottom reading of plain text took a hook at the top of an M
  or a C for a bottom and hung "Mi" and a unit 2 x-heights low. A
  column is as wide as its widest cell written on one row plus `TABLE_PAD` (one
  letter width of the table's own writing) at each side; the table starts at the
  left edge of the text and is never wider than it: then the columns narrower than
  an even share keep their width and the others share the rest evenly, by their
  width or its square root, whichever writes the table in the fewest rows (a word
  written smaller counts half a row), their words wrapping inside them (whole words;
  a word wider than its column is written smaller). Every text row of a cell is a
  row of the page on its ruling; a table row is as high as its tallest cell. Cells
  align as their column says: left a little after the line (±0.2 mm), right ending
  within 0.1 mm of the padding, centred ±0.15 mm. A horizontal grid line lies
  0.34 of the pitch under the baseline of the row above it (`GRID_SPLIT`), moved to
  where the fewest points of the two rows' ink come within 0.3 x-heights
  (`GRID_CLEAR`) or cross it, between 0.1 of the pitch under the upper row's last
  baseline and 0.4 above the lower row's first (`GRID_FROM`, `GRID_TO`), the
  nearest such place to 0.34; the top and bottom lines alike against their row;
  `doc.stats` counts the lines that could not keep that distance (`gridTouching`),
  the empty ruled lines added (`gridRoom`) and the tables written smaller
  (`gridFit`). On 16 proof documents with the real model no ink came closer than
  0.31 mm to a row line. The line under the header is drawn twice, 0.45 x-heights
  apart (`HEAD_GAP`): next to each other on proof pages the doubled line read as
  the header's line, a single firmer one (1.5× in Fineliner) was hardly told apart;
  where the header's ink leaves room for one line only, it is drawn once, firmer. Vertical lines run at the
  column borders from the top to the bottom line. An empty line above and below a
  table; a LaTeX caption is written centred under the table on the next row. A
  table row never splits across pages and the header row keeps the row after it;
  a table that does not fit goes on with its next row on the next page, the grid
  closed at the bottom of the first part and the top of the second; the header is
  not repeated. Drawn (`decor.js: rulerLine`): along a ruler, one stroke a line,
  straight (held within 0.12 x-heights of its course, the turn 0.05° sd), each end
  0.1 ± 0.14 x-heights past its mark (−0.12 … 0.45: more often over the crossing
  than short of it), seeded by the table's block, page and line, so no two lines
  are alike; drawn as ink of the chosen pen like every decoration (stroke kind
  `grid`; nothing new for the screen or the PDF). Words in cells are ordinary
  words: a tap rewrites their piece (`wordAt`, `pieceBoxes`; the columns follow the
  new ink), and the text layer holds the cells row by row in reading order, a
  wrapped cell's rows together before the next cell (words carry `trow` and `cell`).
  Per page `tables: [{ block, xs, ys, rows, head? }]` gives the column lines, the
  row lines and the ruled lines of every table row on that page, and how the
  header line is drawn (`'double'` or `'firm'`; only on pages with a table).
- Pages: as before (an empty line never opens a page), plus explicit page
  breaks; a heading moves on with the next row rather than stand alone at the
  bottom; a box that fits on a page is not split. While pieces are missing a
  box is paginated by its rows so far, so it can still move once it is complete.
- Drawn by hand (`decor.js`): one generator for every line – a slow wobble
  (one wave about as long as the line, one of a few letters), a small turn and
  bow, ends that overshoot or stop short (sd 0.22 x-heights), and the speed of a
  hand (points close at the ends, about twice the writing speed in the middle),
  so that Füller and Bleistift draw it firmer where it starts and stops. It
  makes underlines (0.42 x-heights under the baseline, through the descenders),
  the double underline, strike-throughs, rules, frames (four lines whose corners
  do not close, the first set down with a small hook), bullets, check boxes
  (2.8 x-heights, about a capital of the writing; two strokes, left side and
  bottom, then top and right side, crossing at the corners by 0.25–0.55
  x-heights, sides ±8 %,
  turned up to 3°), ticks (from inside the box up and out past its top right
  corner), arrows (shaft 4.4
  x-heights at mid-height, two head strokes; `=>` two shafts; `<->` two heads).
  All of them are ordinary ink strokes of the document seed and their block,
  never of what comes before. A turn given in degrees moves the far end of a
  long line a lot (0.9° over 150 mm is 2.4 mm, through the letters), so an
  underline may leave its straight course by at most 0.16 x-heights and a
  strike by 0.25 (over 1000 seeds up to 150 mm the underline stays 0.26
  x-heights under the baseline; tested). Highlighter: per row of a run a filled outline
  from 0.5 x-heights under the baseline to 1.8 above, with a chisel's slanted
  ends and slightly uneven edges.
- Colours (`decor.js: INK_COLORS`, `MARKER_COLORS`): rot, blau, gruen,
  schwarz, orange, lila, grau, each with a light-paper and a dark-paper value;
  a span without colour keeps the document's ink. Highlighters gelb, gruen,
  rosa, blau, orange: multiplied at opacity 0.5–0.55 on light paper, screened at
  0.4–0.48 on dark paper. On the dark paper a band bright enough to glow takes
  the light ink's contrast away; the values keep the ink #C9D4FF at a contrast
  of 3.2 (gelb, leaning to gold, where a paler yellow read as olive) to 5
  (rosa).
- The document object additionally carries `rich: true`, `blocks`, `styles`,
  `notes`, `stats`, and per page `styles` (one `{ color, bold, kind }` per entry
  of `strokes`; kind word / underline / strike / rule / frame / bullet / check /
  tick / arrow / grid), `bands` (`{ color, points: [x, y, …] mm, line, block }`),
  `arrows` (`{ text: '->', line, x, width, baseline }`), `markers` (the list
  markers for the text layer: `{ text: '-' | '[ ]' | '[x]', line, x, width,
  baseline }`) and `frames` (`{ box, rect }`). Words keep their fields and add `block`, `frame`, `size`, `style`
  and `strokes: [from, to)` (a word whose ink changes colour or weight is split
  into several stroke entries); the drawn strokes follow the words.
- PDF: bands first, filled with their opacity and blend (ExtGState `/ca`, `/BM
  /Multiply` or `/Screen`), then the ink grouped by colour and weight. Bold:
  the line 1.5× (Fineliner), 1.4× (Füller), 1.3× and two tone levels darker
  (Bleistift) – chosen by looking: firmer, still the same pen. Transparency and
  extra colours appear only when used. The text layer holds the words,
  arrows (as `->`, `=>`, `<-`, `<->`) and list markers (`-`, `[ ]`, `[x]`)
  row by row; struck words stay in it as typed.
- In the page mode (`page-view.js`): the text is read with `parseMarkup` in the stored
  format (`kv: page.format`: auto, markdown, latex, text; the "Formatierung" panel,
  `format-help.js`, chooses it); a text that comes out as plain paragraphs, or the choice
  "Nur Text", is written as the text itself, exactly as before marks. `{datum}` and
  `\today` are the day "Schreiben" was pressed. The detected format ("Markdown",
  "LaTeX") stands beside the field. What the marks could not do (`notes`, each shown as a sentence without the format's
  name; a Markdown table row is written as a line of its cells) follows the
  note line's message. The length limit stays 40 000 typed characters, marks included
  (they rarely add a tenth); the characters the model cannot write are looked for in
  the words only, not in the marks. The PDF is written from the same document; its title (and the
  share title) is the first heading (in a header line its title, not the date), the file
  name stays `handschrift-YYYY-MM-DD.pdf`. The
  screen draws what the PDF holds: bands under the ink (multiply / screen at the
  marker's opacity), named inks in the scheme's value, bold 1.5 / 1.4 / 1.3 × wider
  and, in Bleistift, two tones darker, decorations as ink of the chosen pen.

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

## 4. MCP server (`server/`)

Lets an assistant (Claude, ChatGPT, …) turn text into a PDF in the writer's hand
through the Model Context Protocol. One Python process (ASGI, uvicorn) with the
official MCP SDK (Streamable HTTP, stateless, JSON responses) and `hw.sampling`;
planning, layout and PDF come from the app's own modules (`document.js`,
`pdf.js`), run by `server/pages.mjs` in a node child process, so a server page
is the page the app would make. Owner's guide: `server/README.md` (German).

- Routes: `/k/<key>/mcp` (POST, DELETE; GET is 405, since a stateless server
  never sends on a server stream and an open one would stay open) is the MCP
  endpoint; `/d/<id>` the PDF, or a waiting page (reloads every 3 s, shows pieces
  done of total) while it is written, 410 with a German page for a job a restart
  interrupted, a German 404 page for an unknown or expired id;
  `/healthz` → `{"ok": true, "model": <version|null>, "busy": <bool>}`.
  Everything else, a wrong or missing key included, is the same plain 404.
- Keys: 32 random bytes, base64url (43 characters), in the path because most
  clients cannot send headers. Only SHA-256 hashes are kept: `HANDSCHRIFT_KEY_HASHES`
  and `mcp/keys.json` in the model repository (`{"keys": [{"sha256", "label",
  "created"}]}`, read in the background once a minute, never inside a request; a
  failed read keeps the last list for up to an hour, then its keys no longer
  count; a missing file means no keys from there). Constant-time comparison;
  with no key configured every request is refused.
- One tool, `handschrift_pdf(text, papier = liniert|kariert|blanko, farbe =
  hell|dunkel, groesse = klein|mittel|gross, stift = fineliner|fueller|bleistift)`;
  description under 60 words, tool definition under 1,000 bytes (tested). The
  result is one line: the link and the page count, or that the pages are still
  being written. Refusals (too long, empty, budget, queue, no model, restart) and
  unexpected errors are one German line with `isError`, never an exception
  message. English option values (`dark`, `large`, …) are mapped; unknown ones
  fall back to the default and are named in the line.
- Text (`server/text.py`): Markdown marks go (headings, emphasis, back ticks,
  links, quotes, rules, code fences), bullets become "- ", numbered lists stay,
  table rows become "cell, cell", runs of empty lines become one; at most
  12 000 characters after that. Words over 40 characters are cut into parts of
  22: one word is one piece, and a single 1,600-character word kept the writer
  busy for over 7 minutes.
  Characters outside the alphabet are handled by the model's normalisation and
  named in the result line.
- Writing (`server/jobs.py`): Lesbarkeit 0.4 (the app's default), pieces in
  batches of 48 through `Synthesizer.write` (the app's retry policy), then the
  pieces `preparePiece` flags are written once more and the attempt with fewer
  flags is kept (as `page-view.js: writeChecked`). One document at a time, at
  most 3 waiting (a call being planned holds its place); torch uses
  `HANDSCHRIFT_THREADS` (default: all cores). At most two node processes at
  once; node gets only PATH, TZ and LANG from the environment. A job checks
  between batches whether to stop: after `HANDSCHRIFT_MAX_MINUTES` (10) it fails,
  and on SIGTERM waiting calls answer at once with a German line.
- Waiting: the tool answers when the PDF is ready, at the latest after
  `HANDSCHRIFT_WAIT_SECONDS` (40) with the same link.
- Storage: `<HANDSCHRIFT_DATA>/pdf/<id>.pdf`, id = 16 random bytes base64url;
  an id not matching `^[A-Za-z0-9_-]{22}$` is answered before the file system is
  touched (tested). Files older than 7 days go, then the oldest until the total
  is under `HANDSCHRIFT_MAX_MB` (500), at start, hourly and after every document.
  A job keeps `<id>.json` (state and time, no text) until its PDF exists, so its
  link explains a restart instead of answering 404.
- Model: `HANDSCHRIFT_MODEL_DIR`, or the newest version of
  `HANDSCHRIFT_MODEL_REPO` (`models/index.json`, then `models/<id>/checkpoint/`,
  else the root `checkpoint/`), read with `HF_TOKEN`, cached under
  `<data>/model/`, checked for a newer version at most every 10 minutes.
- Limits against a leaked link: request bodies ≤ 200 KB (413 with a German
  JSON-RPC error), 60 tool calls per key and hour, refused ones included
  (`HANDSCHRIFT_CALLS`), 30 documents per key and hour (`HANDSCHRIFT_BUDGET`),
  both checked before the text is planned, the queue.
  No access log (paths carry the key); logs hold lengths, the first 6 hex
  characters of the key's hash and timings, never the text or the key (tested).
- Links: `HANDSCHRIFT_PUBLIC_URL`, else the request's `X-Forwarded-Host` /
  `X-Forwarded-Proto`, else `Host`; only a plain host name and http(s) are taken
  from headers, because the line goes into the assistant's context.
