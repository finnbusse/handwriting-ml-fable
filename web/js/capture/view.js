// The Erfassen screen (SPEC 2.3): one prompt, one writing band, explicit confirm.
import { createRecorder } from './recorder.js';
import { buildRecord, validate, uuid } from './hwline.js';
import * as qa from './qa.js';
import { nextPrompt, progressOf } from '../prompts.js';
import { normalize, sameDisplay, computeGuides, schemeColors, drawPaper, createInk } from './ink.js';
import { createLookControls } from './look.js';

const BUTTON_QUIET_MS = 300;    // buttons ignore taps this long after a stroke ends
const CHECK_EVERY = 8;          // keep a picture of the sheet after every 8th stroke ...
const KEEP_CHECKPOINTS = 3;     // ... but only the newest 3 (plus bare paper): each is a full-sheet canvas
const HIT_PX = 10;              // eraser: a stroke is hit within this distance (CSS px)

export function createCaptureView(deps) {
  const { cfg, store, outbox, toast } = deps;
  const $ = (id) => document.getElementById(id);
  const root = $('cap');
  const canvas = $('cap-canvas');
  const sheet = $('cap-sheet');
  const hint = $('cap-hint');
  const btn = {
    undo: $('cap-undo'), clear: $('cap-clear'), skip: $('cap-skip'), done: $('cap-done'),
    redo: $('confirm-redo'), ok: $('confirm-ok'), pause: $('pause-ok'),
    blockPause: $('block-pause'), blockNext: $('block-next'), restGo: $('rest-go'),
    look: $('cap-look'), lookClose: $('look-close'), fs: $('cap-fs'),
    again: $('cap-again'), erase: $('cap-erase'), eraseCancel: $('erase-cancel'), eraseOk: $('erase-ok'),
    more: $('cap-more'), back: $('confirm-back'),
  };
  const toolbar = root.querySelector('.cap-tools');
  const menu = $('cap-menu');
  const eraseStatus = $('erase-status');
  const lookDlg = $('dlg-look');

  let ctx2d = null;
  let size = { w: 0, h: 0, dpr: 1, px: [0, 0] };
  let guides = null;
  let display = normalize(deps.display ? deps.display() : null);   // how the sheet looks (never what is recorded)
  let ink = null;               // renderer of the writing canvas
  let confirmInk = null;        // renderer of the confirm canvas
  let displayChanged = false;   // the look was changed while this line was being written
  let state = 'loading';
  let visible = false;
  let current = null;           // prompt being written
  let attempts = {};            // prompt id -> attempt number
  const freshEdits = () => ({ undo: 0, redo: 0, clear: 0, erase: 0, erased_strokes: 0, spot: 0 });
  let edits = freshEdits();
  let flags = [];
  let session = { id: uuid(), seq: 0 };
  let lastStrokeEnd = -Infinity;
  let busy = false;
  let wakeLock = null;
  let hintTimer = null;
  let quietTimer = null;
  let layoutAtStart = null;     // canvas geometry when the first stroke of the line began
  let lineLayout = null;        // size + guides frozen at the first pen-down; the record is built from this
  // One history per line. Ops: {kind: 'write'|'erase'|'spot'|'clear', index, strokes, saved}.
  // Rückgängig reverses the newest op, Wiederholen does it again; writing empties the redo
  // stack. LIFO order means strokes only ever come back into exactly the array they were
  // taken from, at their old place, with their own timestamps.
  let history = { undo: [], redo: [] };
  let seen = [];                // [{s, base}] every stroke recorded on this line (for edits.removed_t)
  let erase = null;             // eraser mode: { k, single, pointerId, pointerType, rect, byButton }
  let eraseNoteShown = false;   // the order note, once per session
  let lastConfirmRate = null;
  const activeTouches = new Set();   // touch contacts currently on the screen (palm, finger)
  let palmBlock = null;              // { until, pointerId }: a palm press on a button blocks its click

  const rec = createRecorder(canvas, {
    penOnly: !deps.settings().allowFinger,
    claim: (e) => claimForEraser(e),
    onStrokeStart: () => {
      if (!layoutAtStart) {
        layoutAtStart = geometry();
        lineLayout = { size: { w: size.w, h: size.h, dpr: size.dpr, px: size.px.slice() }, guides: computeGuides(size.w, size.h, display) };
      }
      setQuiet(true);
      hint.hidden = true;
    },
    onSamples: (s, from) => { if (ink) ink.draw(s, from); },
    onStrokeEnd: (s) => {
      lastStrokeEnd = performance.now();
      setQuiet(false);
      const n = rec.strokes.length;
      seen.push({ s, base: rec.timeBase });
      history.undo.push({ kind: 'write', index: n - 1, strokes: [s], saved: null });
      history.redo = [];          // something new was written: nothing to redo any more
      // The sheet shows exactly paper + strokes[0..n) now: keep a copy now and then.
      if (n % CHECK_EVERY === 0) saveCheckpoint(n, canvas);
      updateTools();
    },
    // Finger mode only: a pen took over from a resting palm; its ink was not stored.
    onDropped: () => { setQuiet(false); render(); },
    onIgnored: (e) => {
      if (rec.strokes.length) return;
      showHint(e.pointerType === 'mouse'
        ? 'Mit der Maus geht es nur, wenn du es in den Einstellungen erlaubst.'
        : 'Bitte mit dem Stift schreiben. Finger werden nicht aufgezeichnet.');
    },
  });

  // ---------- state ----------

  function setState(s) {
    if (s !== 'write' && erase) leaveErase();
    closeMenu();
    state = s;
    root.dataset.state = s;
    if (s === 'write') requestAnimationFrame(() => { fitTools(); layoutCanvas(true); });
    updateInline();
  }

  // ---------- toolbar fit ----------
  // The row has a fixed height and must fit in one line at any width, with every button at
  // least 48x48. Step by step: tighter spacing, then rarely used labels go, then all tool
  // labels, then Überspringen, Stift & Papier and Vollbild move behind "Mehr", then Fertig
  // gets compact. The row keeps its height, so the sheet never moves.
  const FIT_STEPS = 7;
  const MENU_STEP = 5;
  const inMenu = [btn.skip, btn.look, btn.fs];
  const homes = inMenu.map((b) => [b, b.nextElementSibling]);   // where each goes back to

  function setFit(level) {
    for (let i = 1; i <= FIT_STEPS; i++) root.classList.toggle(`fit${i}`, level >= i);
    const out = level >= MENU_STEP;
    if (out && btn.more.hidden) {
      for (const b of inMenu) { b.setAttribute('role', 'menuitem'); menu.append(b); }
      btn.more.hidden = false;
    } else if (!out && !btn.more.hidden) {
      closeMenu();
      for (const [b, next] of [...homes].reverse()) { b.removeAttribute('role'); toolbar.insertBefore(b, next); }
      btn.more.hidden = true;
    }
  }

  function toolsFit() {
    if (toolbar.scrollWidth > toolbar.clientWidth) return false;
    for (const b of toolbar.querySelectorAll('.btn')) {
      if (!b.offsetParent) continue;
      const r = b.getBoundingClientRect();
      if (r.width < 48 || b.scrollWidth > b.clientWidth || r.right > innerWidth + 0.5) return false;
    }
    return true;
  }

  function fitTools() {
    if (!visible || state !== 'write' || erase || !toolbar.clientWidth) return;
    for (let lv = 0; lv <= FIT_STEPS; lv++) { setFit(lv); if (toolsFit()) return; }
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fitTools()).catch(() => {});

  function openMenu() {
    if (btn.more.hidden || !menu.hidden) return;
    const tb = toolbar.getBoundingClientRect(), wr = menu.parentElement.getBoundingClientRect();
    menu.style.top = `${Math.round(tb.bottom - wr.top + 4)}px`;
    menu.hidden = false;
    btn.more.setAttribute('aria-expanded', 'true');
  }
  function closeMenu() {
    if (menu.hidden) return;
    menu.hidden = true;
    btn.more.setAttribute('aria-expanded', 'false');
  }
  // A tap on a menu item closes the menu after its own handler ran; so does any touch elsewhere.
  menu.addEventListener('click', () => closeMenu());
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !btn.more.contains(e.target)) closeMenu();
  }, true);

  /** While a line is in progress the top-bar tabs step back (body[data-inline]). */
  function updateInline() {
    const inLine = state === 'confirm' || (state === 'write' && rec.strokes.length > 0);
    if (inLine && visible) document.body.dataset.inline = '1'; else delete document.body.dataset.inline;
  }

  function showHint(text, ms = 3500) {
    hint.textContent = text; hint.hidden = false;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      if (!rec.strokes.length) hint.textContent = 'Schreib mit dem Stift auf die Linie.';
      else hint.hidden = true;
    }, ms);
  }

  function updateTools() {
    const has = rec.strokes.length > 0;
    btn.undo.disabled = !history.undo.length; btn.again.disabled = !history.redo.length;
    btn.erase.disabled = !has; btn.clear.disabled = !has; btn.done.disabled = !has;
    updateInline();
  }

  /** While the pen is down and shortly after, toolbar taps are ignored: they must not look pressed. */
  function setQuiet(down) {
    clearTimeout(quietTimer); quietTimer = null;
    root.dataset.quiet = '1';
    if (!down) quietTimer = setTimeout(() => { quietTimer = null; delete root.dataset.quiet; }, BUTTON_QUIET_MS);
  }

  const goalBlocks = () => cfg.goalBlocks || 5;

  function updateProgress() {
    const { prompts } = deps.prompts();
    const p = progressOf(prompts, deps.doneIds(), current);
    const extra = current && p.block > goalBlocks();
    const w = deps.writer();
    $('cap-writer').textContent = w ? w.name : '';
    $('cap-progress').textContent = current
      ? `${extra ? 'Extra-Block' : 'Block'} ${extra ? p.block - goalBlocks() : p.block} · Zeile ${Math.min(p.index, p.size)} von ${p.size}` : '';
    $('cap-total').textContent = p.done ? `${p.done} ${p.done === 1 ? 'Zeile' : 'Zeilen'} geschrieben` : '';
    $('cap-bar').style.width = current ? `${Math.round(((Math.min(p.index, p.size) - 1) / p.size) * 100)}%` : '0%';
    return p;
  }

  /** One dot per block: filled when every prompt of it is done. Extra blocks are marked. */
  function renderBlockDots(prompts) {
    const done = deps.doneIds();
    const blocks = [...new Set(prompts.map((p) => p.block))].sort((a, b) => a - b);
    const el = $('block-dots');
    el.innerHTML = '';
    for (const b of blocks) {
      const all = prompts.filter((p) => p.block === b);
      const d = document.createElement('span');
      d.className = 'dot' + (all.every((p) => done.has(p.id)) ? ' full' : '') + (b > goalBlocks() ? ' extra' : '');
      el.append(d);
    }
  }

  function resetLine() {
    if (erase) leaveErase();
    rec.reset();
    rec.paused = false;
    layoutAtStart = null;
    lineLayout = null;
    history = { undo: [], redo: [] };
    seen = [];
    flags = [];
    edits = freshEdits();
    displayChanged = false;
    hint.textContent = 'Schreib mit dem Stift auf die Linie.';
    hint.hidden = false;
    dropCheckpointsAfter(0);
    render();
    updateTools();
  }

  /** Load the next prompt; returns false when a block or everything is done. */
  function loadNext(prevBlock = null) {
    const { prompts } = deps.prompts();
    const next = nextPrompt(prompts, deps.doneIds(), deps.skippedIds());
    if (!next) {
      current = null; updateProgress();
      $('all-text').textContent = `Danke! Alle ${prompts.length} Zeilen sind geschrieben.`;
      setState('all');
      return false;
    }
    if (prevBlock !== null && next.block !== prevBlock) {
      current = next;
      updateProgress();
      const goal = goalBlocks();
      $('block-title').textContent = prevBlock <= goal ? `Block ${prevBlock} von ${goal} geschafft` : `Extra-Block ${prevBlock - goal} geschafft`;
      $('block-text').textContent = prevBlock < goal ? 'Gut gemacht. Mach eine Pause, wenn du magst.'
        : prevBlock === goal ? 'Das Ziel ist erreicht. Jeder weitere Block ist ein Extra.'
          : 'Danke für das Extra. Mach eine Pause, wenn du magst.';
      renderBlockDots(prompts);
      setState('block');
      return false;
    }
    current = next;
    attempts[current.id] = attempts[current.id] || 1;
    $('cap-prompt').textContent = current.text;
    updateProgress();
    resetLine();
    setState('write');
    return true;
  }

  // ---------- canvas ----------

  function geometry() {
    const r = canvas.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height, dpr: devicePixelRatio || 1,
             scale: window.visualViewport ? visualViewport.scale : 1 };
  }

  function sameGeometry(a, b) {
    return a && b && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5
      && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5 && a.dpr === b.dpr && a.scale === b.scale;
  }

  function layoutCanvas(force = false) {
    if (!visible || state !== 'write') return;
    const r = sheet.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;        // sheet not laid out (hidden): keep the last size
    const w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
    const dpr = devicePixelRatio || 1;
    if (!force && w === size.w && h === size.h && dpr === size.dpr) return;
    fitTools();
    size = { w, h, dpr, px: [Math.round(w * dpr), Math.round(h * dpr)] };
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    canvas.width = size.px[0]; canvas.height = size.px[1];
    ctx2d = canvas.getContext('2d', { desynchronized: true, alpha: false });
    if (!ink) ink = createInk(ctx2d);
    guides = computeGuides(w, h, display);
    redraw();
  }

  // ---------- rendering ----------
  // The writing canvas is low-latency (desynchronized): live ink goes straight onto it, and
  // the screen may show it in the middle of an update. Everything else (undo, redo, erase,
  // a new look) is therefore composed off screen and put on the sheet with ONE drawImage:
  // the sheet goes from the old picture to the new one and never shows a wiped or
  // half-drawn state. Checkpoints (copies of the sheet after every CHECK_EVERY strokes)
  // keep composing short: an undo draws at most CHECK_EVERY - 1 strokes, not the whole line.
  // Undo works at the end of the line, so only the newest few are kept (memory: each is a
  // copy of the whole sheet in device pixels, about 10 MB on a tablet).
  let work = null, workCtx = null, workInk = null;   // composition canvas, same pixel size
  let pv = null, pvCtx = null;                       // eraser preview: work + red marks (only while erasing)
  const checkpoints = new Map();                      // n -> canvas with paper + strokes[0..n)
  let checkGen = 0;                                   // bumps whenever every checkpoint becomes invalid

  function offscreen(w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    return c;
  }

  function ensureWork() {
    if (work && work.width === canvas.width && work.height === canvas.height) return;
    work = offscreen(canvas.width, canvas.height);
    workCtx = work.getContext('2d', { alpha: false });
    workInk = createInk(workCtx);
    pv = null; pvCtx = null;
    checkpoints.clear(); checkGen++;
  }

  function saveCheckpoint(n, src) {
    if (!ctx2d || erase || checkpoints.has(n)) return;
    if (src.width !== canvas.width || src.height !== canvas.height) return;
    const old = [...checkpoints.keys()].filter((k) => k > 0).sort((a, b) => a - b);
    if (n > 0 && old.length >= KEEP_CHECKPOINTS && n < old[0]) return;     // older than every kept one
    if (n > 0 && old.length >= KEEP_CHECKPOINTS) checkpoints.delete(old[0]);
    // Always a new canvas: an evicted one may still be held by the history (takeOut).
    const c = offscreen(src.width, src.height);
    c.getContext('2d', { alpha: false }).drawImage(src, 0, 0);
    checkpoints.set(n, c);
  }

  /**
   * Strokes from index i on changed: the pictures that contain them are no longer true.
   * Returns the newest dropped one (with its generation) so taking the change back can
   * put it back instead of drawing the whole line again.
   */
  function dropCheckpointsAfter(i) {
    let top = null;
    for (const n of [...checkpoints.keys()]) {
      if (n <= i) continue;
      if (!top || n > top.n) top = { n, c: checkpoints.get(n) };
      checkpoints.delete(n);
    }
    return top && Object.assign(top, { gen: checkGen });
  }

  /** A checkpoint saved by dropCheckpointsAfter() is true again (the strokes are back). */
  function restoreCheckpoint(top) {
    if (!top || top.gen !== checkGen || top.c.width !== canvas.width || top.c.height !== canvas.height) return;
    if (top.n > rec.strokes.length) return;
    const kept = [...checkpoints.keys()].filter((k) => k > 0);
    if (kept.length >= KEEP_CHECKPOINTS) checkpoints.delete(Math.min(...kept));
    checkpoints.set(top.n, top.c);
  }

  /** Paper in device pixels first, so the last, partly covered pixel column and row are paper too. */
  function paperInto(c, colors) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
    c.fillStyle = colors.paper; c.fillRect(0, 0, c.canvas.width, c.canvas.height);
    c.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    drawPaper(c, size.w, size.h, guides, colors, 1);
  }

  /** Paper + every stored stroke into the work canvas, starting from the newest checkpoint. */
  function compose() {
    ensureWork();
    const colors = schemeColors(display.scheme);
    const n = rec.strokes.length;
    let from = -1;
    for (const k of checkpoints.keys()) if (k <= n && k > from) from = k;
    const c = workCtx;
    if (from >= 0) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
      c.drawImage(checkpoints.get(from), 0, 0);
      c.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    } else {
      from = 0;
      paperInto(c, colors);
      saveCheckpoint(0, work);
    }
    workInk.configure(display, colors, size.dpr);
    for (let i = from; i < n; i++) {
      workInk.draw(rec.strokes[i], 0);
      if ((i + 1) % CHECK_EVERY === 0) saveCheckpoint(i + 1, work);
    }
  }

  /** One drawImage onto the visible sheet. */
  function present(src) {
    const c = ctx2d;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
    c.drawImage(src, 0, 0);
    c.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    ink.configure(display, schemeColors(display.scheme), size.dpr);   // live ink goes on from here
  }

  /** The sheet as it is now (paper + stored strokes), shown in one step. */
  function render() {
    if (!ctx2d) return;
    compose();
    if (erase) showPreview(); else present(work);
  }

  /** Full redraw from nothing (new look, new size, theme): no checkpoint is reused. */
  function redraw() {
    if (!ctx2d) return;
    ensureWork();
    checkpoints.clear(); checkGen++;
    render();
  }

  /** A new look: the strokes stay and are drawn again; only the guides metadata follows. */
  function setDisplay(o) {
    const next = normalize(o);
    if (sameDisplay(next, display)) return;
    display = next;
    sheet.dataset.scheme = display.scheme;
    if (size.w) guides = computeGuides(size.w, size.h, display);
    if (lineLayout) {
      lineLayout.guides = computeGuides(lineLayout.size.w, lineLayout.size.h, display);
      if (rec.strokes.length) displayChanged = true;
    }
    for (const op of [...history.undo, ...history.redo]) {
      const lay = op.saved && op.saved.layout;
      if (!lay || !lay.lineLayout) continue;
      lay.lineLayout.guides = computeGuides(lay.lineLayout.size.w, lay.lineLayout.size.h, display);
      lay.displayChanged = true;
    }
    redraw();
    if (state === 'confirm' && visible) requestAnimationFrame(drawConfirm);
    if (lookDlg.open) look.render();
  }
  sheet.dataset.scheme = display.scheme;

  function drawConfirm() {
    if (state !== 'confirm' || !lineLayout) return;
    const { size, guides } = lineLayout;      // the geometry the strokes were written on
    const cv = $('confirm-canvas');
    const box = cv.parentElement.getBoundingClientRect();
    let y0 = Infinity, y1 = -Infinity;
    for (const s of rec.strokes) for (const y of s.y) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
    y0 = Math.min(y0, guides.baseline_y) - 16; y1 = Math.max(y1, guides.baseline_y) + 16;
    y0 = Math.max(0, y0); y1 = Math.min(size.h, y1);
    const scale = Math.min(1, box.width / size.w);
    const cw = Math.floor(size.w * scale), ch = Math.max(40, Math.floor((y1 - y0) * scale));
    const dpr = devicePixelRatio || 1;
    cv.style.width = `${cw}px`; cv.style.height = `${ch}px`;
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    const c = cv.getContext('2d');
    if (!confirmInk) confirmInk = createInk(c);
    const cols = schemeColors(display.scheme);
    c.setTransform(dpr * scale, 0, 0, dpr * scale, 0, -y0 * dpr * scale);
    drawPaper(c, size.w, size.h, guides, cols, 1 / scale);
    confirmInk.configure(display, cols, dpr * scale);
    for (const s of rec.strokes) confirmInk.draw(s, 0);
    // Ring stray and late strokes so the writer sees what the hint means.
    const ringed = [...(flags.includes('stray_stroke') ? qa.strayStrokes(rec.strokes) : []),
      ...(flags.includes('late_stroke') ? qa.lateStrokes(rec.strokes) : [])];
    if (ringed.length) {
      c.strokeStyle = cols.ink; c.lineWidth = 1.5 / scale; c.setLineDash([4 / scale, 4 / scale]);
      for (const i of ringed) {
        const s = rec.strokes[i];
        const cx = (Math.min(...s.x) + Math.max(...s.x)) / 2, cy = (Math.min(...s.y) + Math.max(...s.y)) / 2;
        c.beginPath(); c.arc(cx, cy, 14 / scale, 0, Math.PI * 2); c.stroke();
      }
      c.setLineDash([]);
    }
  }

  // ---------- history: write, erase, Löschen; Rückgängig and Wiederholen ----------

  /** Take strokes out. When the line becomes empty, its time base and layout go with them. */
  function takeOut(index, count) {
    const { base } = rec.remove(index, count);
    // Keep the newest picture that held these strokes, so taking it back is one drawImage
    // plus a few strokes (only for removals of more than one stroke: a single stroke is cheap).
    const top = dropCheckpointsAfter(index);
    const check = count > 1 ? top : null;
    if (check) for (const op of [...history.undo, ...history.redo]) if (op.saved) op.saved.check = null;   // at most one kept
    if (!base) return { base: null, layout: null, check };
    const layout = { layoutAtStart, lineLayout, displayChanged };
    layoutAtStart = null; lineLayout = null; displayChanged = false;
    return { base, layout, check };
  }

  /** Put strokes back where they were. False when the sheet moved since (the line was empty). */
  function putBack(index, strokes, saved) {
    if (!rec.strokes.length) {
      if (!saved || !saved.layout || !sameGeometry(saved.layout.layoutAtStart, geometry())) return false;
      ({ layoutAtStart, lineLayout, displayChanged } = saved.layout);
    }
    rec.insertAt(index, strokes, saved && saved.base);
    dropCheckpointsAfter(index);
    if (saved) restoreCheckpoint(saved.check);
    return true;
  }

  /** Apply an op (forward = as first done) or reverse it. */
  function run(op, forward) {
    const removes = (op.kind === 'write') !== forward;
    if (removes) { op.saved = takeOut(op.index, op.strokes.length); return true; }
    if (!putBack(op.index, op.strokes, op.saved)) return false;
    op.saved = null;
    return true;
  }

  function dropHistory() {
    const had = history.undo.length + history.redo.length > 0;
    history = { undo: [], redo: [] };
    updateTools();
    if (had && visible && state === 'write') toast('Die Ansicht hat sich geändert. Rückgängig geht nicht mehr.');
  }

  /** A new removal (erase, spot, Löschen): done now, can be taken back. */
  function removeOp(kind, index, count) {
    const op = { kind, index, strokes: rec.strokes.slice(index, index + count), saved: null };
    run(op, true);
    history.undo.push(op);
    history.redo = [];
    return op;
  }

  function undoOnce() {
    const op = history.undo[history.undo.length - 1];
    if (!op) return;
    if (!run(op, false)) { dropHistory(); return; }
    history.undo.pop(); history.redo.push(op);
    edits.undo++;
    if (rec.strokes.length) hint.hidden = true;
    render(); updateTools();
  }

  function redoOnce() {
    const op = history.redo[history.redo.length - 1];
    if (!op) return;
    if (!run(op, true)) { dropHistory(); return; }
    history.redo.pop(); history.undo.push(op);
    edits.redo++;
    if (rec.strokes.length) hint.hidden = true;
    render(); updateTools();
  }

  /**
   * Time spans of strokes recorded on this line that are not in the record, in the record's
   * time base: a pause that contained removed writing. Strokes written in another time base
   * (after a Löschen that was later taken back) are moved into this one; only the span
   * values are computed, no stored sample changes. Consecutive removed strokes merge.
   */
  function removedSpans() {
    if (rec.timeBase === null) return [];
    const kept = new Set(rec.strokes);
    const r2 = (v) => Math.round(v * 100) / 100;
    const all = seen.map((e) => {
      const d = e.base - rec.timeBase;
      return { s: e.s, t0: r2(e.s.t[0] + d), t1: r2(e.s.t[e.s.t.length - 1] + d) };
    }).sort((a, b) => a.t0 - b.t0);
    const out = [];
    let open = null;
    for (const { s, t0, t1 } of all) {
      if (kept.has(s)) { open = null; continue; }
      if (t0 < 0) continue;                          // before this line's first pen-down
      if (open) open[1] = Math.max(open[1], t1); else { open = [t0, t1]; out.push(open); }
    }
    return out;
  }

  // ---------- eraser ("Radieren": back to here) ----------
  // Removing never reorders: the writer points at a stroke, and it and everything written
  // after it go (a stray mark far from the text, as qa.js finds it, can go on its own).
  // New writing therefore always continues at the end, in the order of the text.

  const eraseColor = () => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(display.scheme === 'light_on_dark' ? '--paper-dark-erase' : '--paper-light-erase').trim();
    return v || (display.scheme === 'light_on_dark' ? '#FF7A7A' : '#C8102E');
  };

  function enterErase(byButton = false) {
    if (erase || state !== 'write' || !rec.strokes.length || rec.active) return;
    if (lookDlg.open) lookDlg.close();
    closeMenu();
    compose();                         // work = the sheet as it is; the preview is drawn over a copy
    erase = { k: -1, single: false, pointerId: null, pointerType: null, rect: null, byButton };
    root.dataset.mode = 'erase';
    hint.hidden = true;
    setEraseStatus('Tippe auf die Stelle, ab der alles weg soll.');
    btn.eraseOk.disabled = true;
    if (!eraseNoteShown) { eraseNoteShown = true; toast('Neu schreiben geht nur am Ende. So bleibt die Reihenfolge richtig.', 4500); }
  }

  /** Back to writing; the sheet shows `work` (the line as it is). */
  function leaveErase(show = true) {
    if (!erase) return;
    if (erase.pointerId !== null) { try { canvas.releasePointerCapture(erase.pointerId); } catch (_) {} }
    erase = null;
    pv = null; pvCtx = null;           // the preview canvas is only needed while erasing
    delete root.dataset.mode;
    if (show && ctx2d && work) present(work);
    fitTools();
  }

  function setEraseStatus(t) { eraseStatus.textContent = t; }

  /** Indices that go when the eraser cut is at stroke k. */
  function eraseSet() {
    if (!erase || erase.k < 0) return [];
    if (erase.single) return [erase.k];
    const out = [];
    for (let i = erase.k; i < rec.strokes.length; i++) out.push(i);
    return out;
  }

  /** work + the strokes that will go, marked red, in one drawImage. */
  function showPreview() {
    const set = eraseSet();
    if (!set.length) { present(work); return; }
    if (!pv) { pv = offscreen(work.width, work.height); pvCtx = pv.getContext('2d', { alpha: false }); }
    const c = pvCtx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
    c.drawImage(work, 0, 0);
    c.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    const w = (display.pen === 'fueller' ? display.width * 1.6 : display.width) + 1;
    c.strokeStyle = c.fillStyle = eraseColor();
    c.lineWidth = w; c.lineCap = 'round'; c.lineJoin = 'round';
    for (const i of set) {
      const s = rec.strokes[i];
      if (s.x.length === 1) { c.beginPath(); c.arc(s.x[0], s.y[0], w / 2, 0, Math.PI * 2); c.fill(); continue; }
      c.beginPath(); c.moveTo(s.x[0], s.y[0]);
      for (let j = 1; j < s.x.length; j++) c.lineTo(s.x[j], s.y[j]);
      c.stroke();
    }
    present(pv);
  }

  /** The stroke nearest to (x, y) within HIT_PX, or -1. */
  function hitStroke(x, y) {
    let best = -1, bestD = HIT_PX * HIT_PX;
    rec.strokes.forEach((s, k) => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < s.x.length; i++) {
        if (s.x[i] < x0) x0 = s.x[i]; if (s.x[i] > x1) x1 = s.x[i];
        if (s.y[i] < y0) y0 = s.y[i]; if (s.y[i] > y1) y1 = s.y[i];
      }
      if (x < x0 - HIT_PX || x > x1 + HIT_PX || y < y0 - HIT_PX || y > y1 + HIT_PX) return;
      for (let i = 0; i < s.x.length; i++) {
        let d;
        if (i === 0) d = (s.x[0] - x) ** 2 + (s.y[0] - y) ** 2;
        else {
          const ax = s.x[i - 1], ay = s.y[i - 1], bx = s.x[i] - ax, by = s.y[i] - ay;
          const l = bx * bx + by * by;
          const u = l > 0 ? Math.max(0, Math.min(1, ((x - ax) * bx + (y - ay) * by) / l)) : 0;
          d = (ax + u * bx - x) ** 2 + (ay + u * by - y) ** 2;
        }
        if (d <= bestD) { bestD = d; best = k; }
      }
    });
    return best;
  }

  function eraseAt(e) {
    const r = erase.rect;
    const k = hitStroke(e.clientX - r.left, e.clientY - r.top);
    if (k < 0) {
      if (erase.k < 0) {
        setEraseStatus('Hier ist nichts. Tippe auf die Schrift. Zum Schreiben: Abbrechen.');
        eraseStatus.classList.remove('nudge'); void eraseStatus.offsetWidth; eraseStatus.classList.add('nudge');
      }
      return;                                      // no hit: the cut stays where it was
    }
    if (k === erase.k) return;
    erase.k = k;
    erase.single = k < rec.strokes.length - 1 && qa.strayStrokes(rec.strokes).includes(k);
    const n = erase.single ? 1 : rec.strokes.length - k;
    setEraseStatus(erase.single ? 'Nur dieser Fleck wird entfernt.'
      : n === 1 ? 'Dieser Strich wird entfernt.' : `Ab hier wird alles entfernt (${n} Striche).`);
    btn.eraseOk.disabled = false;
    showPreview();
  }

  const sideButton = (e) => e.pointerType === 'pen' && !!((e.buttons & 2) || (e.buttons & 32) || e.button === 5);

  /**
   * Pen-down on the sheet: in eraser mode it erases, never writes. The S Pen side button (or
   * the eraser end) held while touching the writing opens the eraser on that spot; held over
   * empty paper it does nothing special, and the stroke is recorded (flagged button_pressed).
   * An eraser opened by the side button is temporary: the next contact without the button
   * closes it again and writes as usual.
   */
  function claimForEraser(e) {
    if (state !== 'write') return false;
    const counts = e.pointerType === 'pen' || (!rec.penOnly && (e.pointerType === 'touch' || e.pointerType === 'mouse'));
    if (!erase) {
      if (!sideButton(e) || !rec.strokes.length || deps.settings().penButtonErase === false) return false;
      const r = canvas.getBoundingClientRect();
      if (hitStroke(e.clientX - r.left, e.clientY - r.top) < 0) return false;   // not on the writing
      enterErase(true);
      if (!erase) return false;
    } else if (!counts) return false;              // a finger in eraser mode: ignored as always
    else if (erase.byButton && erase.pointerId === null && !sideButton(e)) {
      leaveErase();                                // button let go: back to writing, this stroke records
      return false;
    }
    if (erase.pointerId !== null) {
      // Finger mode: a pen takes over from a resting palm (as when writing); anything else waits.
      if (!(e.pointerType === 'pen' && erase.pointerType !== 'pen')) return true;
      try { canvas.releasePointerCapture(erase.pointerId); } catch (_) {}
    }
    erase.pointerId = e.pointerId;
    erase.pointerType = e.pointerType;
    erase.rect = canvas.getBoundingClientRect();
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    setQuiet(true);
    eraseAt(e);
    return true;
  }

  canvas.addEventListener('pointermove', (e) => { if (erase && e.pointerId === erase.pointerId) eraseAt(e); });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(ev, (e) => {
      // A stroke whose samples were all stale ends without onStrokeEnd: end the quiet look too.
      if (!rec.active && root.dataset.quiet && !quietTimer && !(erase && erase.pointerId !== null)) setQuiet(false);
      if (!erase || e.pointerId !== erase.pointerId) return;
      erase.pointerId = null;
      lastStrokeEnd = performance.now();           // like a stroke: buttons wait 300 ms
      setQuiet(false);
    });
  }

  // ---------- robustness ----------

  function layoutEvent(kind) {
    if (!visible) return;
    // Outside 'write' the sheet is hidden (0x0); its size is measured again when writing resumes.
    if (state === 'confirm') { requestAnimationFrame(drawConfirm); return; }
    if (state !== 'write') return;
    if (!rec.active) fitTools();
    const inLine = rec.strokes.length > 0 || rec.active;
    if (inLine) {
      // Entering or leaving fullscreen moves the sheet, even when the size happens to match.
      if (kind === 'fullscreenchange' || !sameGeometry(layoutAtStart, geometry())) {
        rec.paused = true;
        setState('pause');
        return;
      }
      return;
    }
    // An empty line whose history would bring strokes back onto a sheet that moved: drop it.
    const g = geometry();
    if ([...history.undo, ...history.redo].some((op) => op.saved && op.saved.layout && !sameGeometry(op.saved.layout.layoutAtStart, g))) {
      dropHistory();
    }
    requestAnimationFrame(() => layoutCanvas());
  }

  // A DPR change (zoom, display switch) may come without a resize event.
  function watchDpr() {
    const mq = matchMedia(`(resolution: ${devicePixelRatio || 1}dppx)`);
    const on = () => { mq.removeEventListener('change', on); layoutEvent('dpr'); watchDpr(); };
    mq.addEventListener('change', on);
  }
  watchDpr();

  for (const ev of ['resize', 'orientationchange']) window.addEventListener(ev, () => layoutEvent(ev));
  document.addEventListener('fullscreenchange', () => { updateFsButton(); layoutEvent('fullscreenchange'); });
  if (window.visualViewport) visualViewport.addEventListener('resize', () => layoutEvent('visualviewport'));
  if (screen.orientation && screen.orientation.addEventListener) {
    screen.orientation.addEventListener('change', () => layoutEvent('orientation'));
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { redraw(); });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      outbox.flush('session-end');   // the strokes of an unfinished line stay in memory
    } else if (visible) {
      acquireWakeLock();
      layoutEvent('visible');
    }
  });

  async function acquireWakeLock() {
    try {
      if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
      if (wakeLock && !wakeLock.released) return;
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (_) { wakeLock = null; }   // battery saver etc.: never blocks recording
  }

  // Fullscreen only when the writer asks for it (button); recording never depends on it.
  const fsAvailable = () => !!(document.fullscreenEnabled && document.documentElement.requestFullscreen);

  function updateFsButton() {
    const on = !!document.fullscreenElement;
    // An app installed to start in fullscreen has nothing to switch.
    btn.fs.hidden = !fsAvailable() || (!on && matchMedia('(display-mode: fullscreen)').matches);
    btn.fs.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.fs.setAttribute('aria-label', on ? 'Vollbild beenden' : 'Vollbild');
    $('cap-fs-label').textContent = on ? 'Vollbild beenden' : 'Vollbild';
    $('cap-fs-icon').setAttribute('href', on ? '#i-shrink' : '#i-expand');
    fitTools();
  }
  updateFsButton();

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch (_) {
      toast('Vollbild geht hier gerade nicht. Schreiben klappt auch so.');
    }
    updateFsButton();
  }

  // ---------- actions ----------

  // Palm guard: a button pressed by a touch while another touch rests on the screen
  // (a palm, the writing hand) is ignored. A single finger tap still works. Only the click
  // of that very contact is blocked, so a later real tap is never swallowed.
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    activeTouches.add(e.pointerId);
    if (activeTouches.size > 1 && e.target.closest && e.target.closest('#v-erfassen button')) {
      palmBlock = { until: performance.now() + 1000, pointerId: e.pointerId };
    }
  }, true);
  for (const ev of ['pointerup', 'pointercancel']) {
    document.addEventListener(ev, (e) => { if (e.pointerType === 'touch') activeTouches.delete(e.pointerId); }, true);
  }

  /** True when this click comes from a blocked palm press. */
  function palmClick(e) {
    if (!palmBlock) return false;
    const b = palmBlock;
    if (performance.now() > b.until) { palmBlock = null; return false; }
    const id = e && typeof e.pointerId === 'number' && e.pointerId > 0 ? e.pointerId : null;
    if (id !== null && id !== b.pointerId) return false;   // another contact: a real tap
    palmBlock = null;
    return true;
  }

  /**
   * Guard: no taps right after a stroke, none mid-stroke, no palm presses, and (for actions
   * that take time) no double activation. Instant actions (undo, redo, eraser) are not
   * latched: every tap does exactly one step.
   */
  function guarded(fn, opt = {}) {
    return async (e) => {
      if (e) e.preventDefault();
      if (palmClick(e)) return;
      if (busy || rec.active || (erase && erase.pointerId !== null)) return;
      if (performance.now() - lastStrokeEnd < BUTTON_QUIET_MS) return;
      if (opt.instant) { run1(fn, e); return; }
      busy = true;
      try { await fn(e); } catch (err) { failed(err); } finally { setTimeout(() => { busy = false; }, 250); }
    };
  }
  function run1(fn, e) { try { fn(e); } catch (err) { failed(err); } }
  function failed(err) {
    console.error(err);
    toast(err && err.name === 'QuotaExceededError'
      ? 'Der Speicher auf dem Gerät ist voll. Bitte lade in den Einstellungen die Sicherung herunter und gib Platz frei.'
      : 'Das hat nicht geklappt. Bitte noch einmal tippen.', 7000);
  }

  btn.more.addEventListener('click', guarded(() => { if (menu.hidden) openMenu(); else closeMenu(); }, { instant: true }));
  btn.undo.addEventListener('click', guarded(undoOnce, { instant: true }));
  btn.again.addEventListener('click', guarded(redoOnce, { instant: true }));
  btn.erase.addEventListener('click', guarded(() => enterErase(false), { instant: true }));
  btn.eraseCancel.addEventListener('click', guarded(() => leaveErase(), { instant: true }));
  btn.eraseOk.addEventListener('click', guarded(() => {
    if (!erase || erase.k < 0) return;
    const k = erase.k, single = erase.single;
    const n = single ? 1 : rec.strokes.length - k;
    leaveErase(false);                 // the new sheet is shown once, below
    removeOp(single ? 'spot' : 'erase', k, n);
    if (single) edits.spot++; else { edits.erase++; edits.erased_strokes += n; }
    render(); updateTools();
    toast('Entfernt. „Rückgängig“ holt es zurück.');
  }, { instant: true }));

  btn.clear.addEventListener('click', guarded(() => {
    if (!rec.strokes.length) return;
    removeOp('clear', 0, rec.strokes.length);
    edits.clear++;
    flags = [];
    hint.textContent = 'Schreib mit dem Stift auf die Linie.';
    hint.hidden = false;
    render(); updateTools();
    toast('Zeile gelöscht. „Rückgängig“ holt sie zurück.');
  }, { instant: true }));

  btn.skip.addEventListener('click', guarded(async () => {
    if (!current) return;
    if (rec.strokes.length) { showHint('Zum Überspringen erst die Zeile löschen.'); hint.hidden = false; return; }
    await deps.skip(current.id);
    toast('Übersprungen. Die Zeile kommt später wieder.');
    loadNext();
  }));

  btn.done.addEventListener('click', guarded(() => {
    if (!rec.strokes.length) { showHint('Noch nichts geschrieben.'); return; }
    const layoutChanged = !sameGeometry(layoutAtStart, geometry());
    lastConfirmRate = qa.rateHz(rec.strokes);
    const ls = lineLayout.size;
    flags = qa.check({ text: current.text, strokes: rec.strokes, canvas: [ls.w, ls.h], layoutChanged, rate: lastConfirmRate });
    store.kvSet('lastLine', {
      rate_hz: lastConfirmRate, points: rec.strokes.reduce((n, s) => n + s.x.length, 0),
      strokes: rec.strokes.length, api: rec.rawSamples > 0 ? 'pointerrawupdate' : 'pointermove',
      at: new Date().toISOString(),
    }).catch(() => {});
    $('confirm-prompt').textContent = current.text;
    const list = $('confirm-qa');
    list.innerHTML = '';
    for (const f of flags) {
      const li = document.createElement('li');
      li.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-info"/></svg>';
      const span = document.createElement('span'); span.textContent = qa.HINTS[f] || f;
      li.append(span); li.dataset.flag = f; list.append(li);
    }
    root.classList.toggle('has-flags', flags.length > 0);
    list.hidden = flags.length === 0;
    $('confirm-ok-label').textContent = flags.length ? 'Trotzdem weiter' : 'Ja, weiter';
    setState('confirm');
    requestAnimationFrame(drawConfirm);
  }));

  // Back to the sheet with the line and its history kept (to erase a late or stray stroke).
  btn.back.addEventListener('click', guarded(() => {
    flags = [];
    setState('write');
    requestAnimationFrame(() => {             // after layoutCanvas: the sheet must be where the line began
      if (state === 'write' && rec.strokes.length && !sameGeometry(layoutAtStart, geometry())) { rec.paused = true; setState('pause'); }
    });
  }));

  btn.redo.addEventListener('click', guarded(() => {
    attempts[current.id] = (attempts[current.id] || 1) + 1;
    resetLine();
    setState('write');
  }));

  btn.ok.addEventListener('click', guarded(async () => {
    // Size, DPR and guides as they were when the line was written, never the live values:
    // the sheet may have been resized (or measured as 0x0) while this screen was open.
    const ls = lineLayout.size;
    const writer = deps.writer();
    if (!writer) { toast('Bitte wähle zuerst in den Einstellungen, wer schreibt.', 6000); return; }
    const record = buildRecord({
      cfg, writer, sessionId: session.id, seq: session.seq, prompt: current, flags,
      attempt: attempts[current.id] || 1, edits: Object.assign({}, edits, { removed_t: removedSpans() }), rec,
      canvasCss: [ls.w, ls.h], canvasPx: ls.px.slice(), dpr: ls.dpr,
      guides: Object.assign({}, lineLayout.guides, displayChanged ? { display_changed: true } : {}),
      uaData: deps.uaData(),
    });
    const errors = validate(record);
    if (errors.length) console.warn('hwline/v1 check:', errors);
    await store.putLine(record);                 // durable before anything else happens
    session.seq++;
    const block = current.block;
    delete attempts[current.id];
    await deps.lineSaved(record);
    outbox.flush('line');
    loadNext(block);
  }));

  btn.pause.addEventListener('click', guarded(() => {
    attempts[current.id] = (attempts[current.id] || 1) + 1;
    resetLine();
    setState('write');
  }));

  btn.blockNext.addEventListener('click', guarded(() => {
    session = { id: uuid(), seq: 0 };
    loadNext();
  }));

  btn.blockPause.addEventListener('click', guarded(() => {
    outbox.flush('session-end');
    setState('resting');
  }));

  btn.restGo.addEventListener('click', guarded(() => {
    session = { id: uuid(), seq: 0 };
    loadNext();
  }));

  btn.fs.addEventListener('click', guarded(async () => {
    // Switching moves the sheet, which would cost the line: finish or clear it first.
    if (rec.strokes.length) { showHint('Erst die Zeile fertig schreiben oder löschen.'); return; }
    await toggleFullscreen();
  }));

  // "Stift & Papier": a panel over the sheet; the sheet behind follows every choice.
  const look = createLookControls($('look-controls'), {
    get: () => display,
    set: async (o) => { setDisplay(o); if (deps.saveDisplay) await deps.saveDisplay(normalize(o)); },
    wrap: (fn) => guarded(fn),
  });
  btn.look.addEventListener('click', guarded(() => {
    if (lookDlg.open) return;
    lookDlg.showModal();
    look.render();
  }));
  btn.lookClose.addEventListener('click', () => lookDlg.close());
  lookDlg.addEventListener('click', (e) => { if (e.target === lookDlg) lookDlg.close(); });   // tap beside the panel

  // ---------- public ----------

  return {
    /** A different person writes: new session, nothing of the old line or the old progress stays. */
    newSession() {
      session = { id: uuid(), seq: 0 };
      attempts = {};
      current = null;
      eraseNoteShown = false;
      if (state !== 'nocaps') { resetLine(); setState('loading'); }
      if (visible) this.show();
    },
    show() {
      visible = true;
      acquireWakeLock();
      if (state === 'loading' || state === 'nocaps') {
        const c = rec.caps;
        // Without these the pen comes at frame rate (the defect of the old recordings): do not record.
        if (!c.secureContext || !c.getCoalescedEvents) {
          $('nocaps-text').textContent = !c.secureContext
            ? 'Die App wurde ohne sichere Verbindung geöffnet. So kommen zu wenige Stiftpunkte an. Bitte öffne sie über die https-Adresse.'
            : 'Dieser Browser liefert die Stiftpunkte nicht genau genug. Bitte öffne die App in einem aktuellen Chrome.';
          setState('nocaps');
          return;
        }
        loadNext(); return;
      }
      if (state === 'write') {
        if (rec.strokes.length && !sameGeometry(layoutAtStart, geometry())) { rec.paused = true; setState('pause'); }
        else requestAnimationFrame(() => { fitTools(); layoutCanvas(true); });
      }
      if (state === 'confirm') requestAnimationFrame(drawConfirm);
      updateFsButton();
      updateInline();
    },
    hide() {
      visible = false;
      if (erase) leaveErase();
      closeMenu();
      if (lookDlg.open) lookDlg.close();
      delete document.body.dataset.inline;
      if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
      outbox.flush('session-end');
    },
    /** Prompts or done-set changed from outside (remote progress, new prompt file). */
    refresh() {
      if (state === 'loading') return;
      if (state === 'write' && !rec.strokes.length && (!current || deps.doneIds().has(current.id))) { loadNext(); return; }
      if (state === 'all') { loadNext(); return; }
      updateProgress();
    },
    setPenOnly(v) { rec.penOnly = v; },
    /** The current writer's look (from the panel, the settings or a writer switch). */
    setDisplay,
    get display() { return Object.assign({}, display); },
    get guides() { return guides && Object.assign({}, guides); },
    get sheetColors() { return Object.assign({}, schemeColors(display.scheme)); },
    /** Full redraw from scratch (tests compare it with live drawing and with undo). */
    redraw,
    get state() { return state; },
    get recorder() { return rec; },
    get lastRate() { return lastConfirmRate; },
    /** For tests: the history depth and the eraser state, never part of a record. */
    get history() { return { undo: history.undo.map((o) => o.kind), redo: history.redo.map((o) => o.kind) }; },
    get eraser() { return erase ? { k: erase.k, set: eraseSet(), active: erase.pointerId !== null } : null; },
    get edits() { return Object.assign({}, edits, { removed_t: removedSpans() }); },
  };
}
