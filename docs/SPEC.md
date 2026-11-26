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
- The layout is a plain object `{ settings, page, geometry, typical, pages:
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
- "PDF herunterladen" (phone: "PDF") saves `handschrift-YYYY-MM-DD.pdf` from the
  same document object; "Teilen" appears only where the browser can share files.

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
