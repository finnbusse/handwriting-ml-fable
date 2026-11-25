// The Erfassen screen (SPEC 2.3): one prompt, one writing band, explicit confirm.
import { createRecorder } from './recorder.js';
import { buildRecord, validate, uuid } from './hwline.js';
import * as qa from './qa.js';
import { nextPrompt, progressOf } from '../prompts.js';

const INK_WIDTH = 2;            // constant CSS px, no pressure-dependent width
const BUTTON_QUIET_MS = 300;    // buttons ignore taps this long after a stroke ends
const BASELINE_FRAC = 0.64;     // baseline position inside the band
const GUIDE_INSET = 32;         // baseline starts/ends this far inside the band

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
  };

  let ctx2d = null;
  let size = { w: 0, h: 0, dpr: 1, px: [0, 0] };
  let guides = null;
  let colors = { sheet: '#fff', ink: '#000', rule: '#ccc' };
  let state = 'loading';
  let visible = false;
  let current = null;           // prompt being written
  let attempts = {};            // prompt id -> attempt number
  let edits = { undo: 0, clear: 0 };
  let flags = [];
  let session = { id: uuid(), seq: 0 };
  let lastStrokeEnd = -Infinity;
  let busy = false;
  let wakeLock = null;
  let hintTimer = null;
  let layoutAtStart = null;     // canvas geometry when the first stroke of the line began
  let lineLayout = null;        // size + guides frozen at the first pen-down; the record is built from this
  let cleared = null;           // what "Löschen" took away, so "Rückgängig" can bring it back
  let lastConfirmRate = null;
  const activeTouches = new Set();   // touch contacts currently on the screen (palm, finger)
  let ignoreClickUntil = 0;          // a palm press on a button blocks the click that follows it

  const rec = createRecorder(canvas, {
    penOnly: !deps.settings().allowFinger,
    onStrokeStart: () => {
      if (!layoutAtStart) {
        layoutAtStart = geometry();
        lineLayout = { size: { w: size.w, h: size.h, dpr: size.dpr, px: size.px.slice() }, guides: Object.assign({}, guides) };
      }
      cleared = null;            // writing again ends the chance to restore a cleared line
      hint.hidden = true;
    },
    onSamples: (s, from) => drawSegment(s, from),
    onStrokeEnd: () => { lastStrokeEnd = performance.now(); updateTools(); },
    onIgnored: (e) => {
      if (rec.strokes.length) return;
      showHint(e.pointerType === 'mouse'
        ? 'Mit der Maus geht es nur, wenn du es in den Einstellungen erlaubst.'
        : 'Bitte mit dem Stift schreiben. Finger werden nicht aufgezeichnet.');
    },
  });

  // ---------- state ----------

  function setState(s) {
    state = s;
    root.dataset.state = s;
    if (s === 'write') requestAnimationFrame(() => layoutCanvas(true));
    updateInline();
  }

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
    btn.undo.disabled = !has && !cleared; btn.clear.disabled = !has; btn.done.disabled = !has;
    updateInline();
  }

  const goalBlocks = () => cfg.goalBlocks || 5;

  function updateProgress() {
    const { prompts } = deps.prompts();
    const p = progressOf(prompts, deps.doneIds(), current);
    const extra = current && p.block > goalBlocks();
    $('cap-progress').textContent = current
      ? `${extra ? 'Extra-Block' : 'Block'} ${extra ? p.block - goalBlocks() : p.block} · Zeile ${Math.min(p.index, p.size)} von ${p.size}` : '';
    $('cap-total').textContent = p.done ? `${p.done} geschafft` : '';
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
    rec.reset();
    rec.paused = false;
    layoutAtStart = null;
    lineLayout = null;
    cleared = null;
    flags = [];
    edits = { undo: 0, clear: 0 };
    hint.textContent = 'Schreib mit dem Stift auf die Linie.';
    hint.hidden = false;
    redraw();
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

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    colors = {
      sheet: cs.getPropertyValue('--sheet').trim() || '#fff',
      ink: cs.getPropertyValue('--ink-stroke').trim() || '#123',
      rule: cs.getPropertyValue('--rule').trim() || '#ccc',
    };
  }

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
    size = { w, h, dpr, px: [Math.round(w * dpr), Math.round(h * dpr)] };
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    canvas.width = size.px[0]; canvas.height = size.px[1];
    ctx2d = canvas.getContext('2d', { desynchronized: true, alpha: false });
    const baselineY = Math.round(h * BASELINE_FRAC) + 0.5;
    const inset = Math.min(GUIDE_INSET, Math.round(w * 0.04));
    guides = { visible: true, baseline_y: baselineY, x_start: inset, x_end: w - inset,
               extra_lines_y: [], ink_width_css: INK_WIDTH, pressure_width: false };
    redraw();
  }

  function redraw() {
    if (!ctx2d) return;
    readColors();
    const c = ctx2d;
    c.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    c.fillStyle = colors.sheet; c.fillRect(0, 0, size.w, size.h);
    c.strokeStyle = colors.rule; c.lineWidth = 1;
    c.beginPath(); c.moveTo(guides.x_start, guides.baseline_y); c.lineTo(guides.x_end, guides.baseline_y); c.stroke();
    for (const s of rec.strokes) drawSegment(s, 0);
  }

  function drawSegment(s, from) {
    if (!ctx2d) return;
    const c = ctx2d;
    c.strokeStyle = colors.ink; c.fillStyle = colors.ink;
    c.lineWidth = INK_WIDTH; c.lineCap = 'round'; c.lineJoin = 'round';
    if (s.x.length === 1) {
      c.beginPath(); c.arc(s.x[0], s.y[0], INK_WIDTH / 2, 0, Math.PI * 2); c.fill();
      return;
    }
    const i0 = Math.max(1, from);
    if (i0 >= s.x.length) return;
    c.beginPath(); c.moveTo(s.x[i0 - 1], s.y[i0 - 1]);
    for (let i = i0; i < s.x.length; i++) c.lineTo(s.x[i], s.y[i]);
    c.stroke();
  }

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
    c.setTransform(dpr * scale, 0, 0, dpr * scale, 0, -y0 * dpr * scale);
    c.fillStyle = colors.sheet; c.fillRect(0, y0, size.w, y1 - y0);
    c.strokeStyle = colors.rule; c.lineWidth = 1 / scale;
    c.beginPath(); c.moveTo(guides.x_start, guides.baseline_y); c.lineTo(guides.x_end, guides.baseline_y); c.stroke();
    c.strokeStyle = colors.ink; c.fillStyle = colors.ink; c.lineWidth = INK_WIDTH; c.lineCap = 'round'; c.lineJoin = 'round';
    for (const s of rec.strokes) {
      if (s.x.length === 1) { c.beginPath(); c.arc(s.x[0], s.y[0], INK_WIDTH / 2, 0, Math.PI * 2); c.fill(); continue; }
      c.beginPath(); c.moveTo(s.x[0], s.y[0]);
      for (let i = 1; i < s.x.length; i++) c.lineTo(s.x[i], s.y[i]);
      c.stroke();
    }
    // Ring stray strokes so the writer sees what the hint means.
    if (flags.includes('stray_stroke')) {
      c.strokeStyle = colors.ink; c.lineWidth = 1.5 / scale; c.setLineDash([4 / scale, 4 / scale]);
      for (const i of qa.strayStrokes(rec.strokes)) {
        const s = rec.strokes[i];
        const cx = (Math.min(...s.x) + Math.max(...s.x)) / 2, cy = (Math.min(...s.y) + Math.max(...s.y)) / 2;
        c.beginPath(); c.arc(cx, cy, 14 / scale, 0, Math.PI * 2); c.stroke();
      }
      c.setLineDash([]);
    }
  }

  // ---------- robustness ----------

  function layoutEvent(kind) {
    if (!visible) return;
    // Outside 'write' the sheet is hidden (0x0); its size is measured again when writing resumes.
    if (state === 'confirm') { requestAnimationFrame(drawConfirm); return; }
    if (state !== 'write') return;
    const inLine = rec.strokes.length > 0 || rec.active;
    if (inLine) {
      const leftFullscreen = kind === 'fullscreenchange' && !document.fullscreenElement;
      if (leftFullscreen || !sameGeometry(layoutAtStart, geometry())) {
        rec.paused = true;
        setState('pause');
        return;
      }
      return;
    }
    if (cleared && !sameGeometry(cleared.layoutAtStart, geometry())) { cleared = null; updateTools(); }
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
  document.addEventListener('fullscreenchange', () => layoutEvent('fullscreenchange'));
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

  async function enterFullscreen() {
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen
          && !matchMedia('(display-mode: fullscreen)').matches) {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      }
    } catch (_) {}
    try { if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape'); } catch (_) {}
  }

  // ---------- actions ----------

  // Palm guard: a button pressed by a touch while another touch rests on the screen
  // (a palm, the writing hand) is ignored. A single finger tap still works.
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    activeTouches.add(e.pointerId);
    if (activeTouches.size > 1 && e.target.closest && e.target.closest('#cap button')) ignoreClickUntil = performance.now() + 1000;
  }, true);
  for (const ev of ['pointerup', 'pointercancel']) {
    document.addEventListener(ev, (e) => { if (e.pointerType === 'touch') activeTouches.delete(e.pointerId); }, true);
  }

  /** Guard: no double activation, no taps right after a stroke, none mid-stroke, no palm presses. */
  function guarded(fn) {
    return async (e) => {
      if (e) e.preventDefault();
      if (performance.now() < ignoreClickUntil) { ignoreClickUntil = 0; return; }
      if (busy || rec.active) return;
      if (performance.now() - lastStrokeEnd < BUTTON_QUIET_MS) return;
      busy = true;
      try { await fn(e); } catch (err) {
        console.error(err);
        toast(err && err.name === 'QuotaExceededError'
          ? 'Der Speicher auf dem Gerät ist voll. Bitte lade in den Einstellungen die Sicherung herunter und gib Platz frei.'
          : 'Das hat nicht geklappt. Bitte noch einmal tippen.', 7000);
      } finally { setTimeout(() => { busy = false; }, 250); }
    };
  }

  btn.undo.addEventListener('click', guarded(() => {
    if (!rec.strokes.length && cleared) {
      // Undo "Löschen": the whole line comes back as it was.
      if (!sameGeometry(cleared.layoutAtStart, geometry())) { cleared = null; updateTools(); return; }
      const c = cleared; cleared = null;
      rec.restore(c.rec);
      layoutAtStart = c.layoutAtStart; lineLayout = c.lineLayout;
      edits.undo++;
      hint.hidden = true;
      redraw(); updateTools();
      return;
    }
    if (!rec.strokes.length) return;
    rec.undo(); edits.undo++;
    if (!rec.strokes.length) { layoutAtStart = null; lineLayout = null; }
    redraw(); updateTools();
  }));

  btn.clear.addEventListener('click', guarded(() => {
    if (!rec.strokes.length) return;
    const e = edits;
    const keep = { rec: rec.stash(), layoutAtStart, lineLayout };
    resetLine();
    cleared = keep;
    edits = { undo: e.undo, clear: e.clear + 1 };
    updateTools();
    toast('Zeile gelöscht. „Rückgängig“ holt sie zurück.');
  }));

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

  btn.redo.addEventListener('click', guarded(() => {
    attempts[current.id] = (attempts[current.id] || 1) + 1;
    resetLine();
    setState('write');
  }));

  btn.ok.addEventListener('click', guarded(async () => {
    // Size, DPR and guides as they were when the line was written, never the live values:
    // the sheet may have been resized (or measured as 0x0) while this screen was open.
    const ls = lineLayout.size;
    const record = buildRecord({
      cfg, sessionId: session.id, seq: session.seq, prompt: current, flags,
      attempt: attempts[current.id] || 1, edits, rec,
      canvasCss: [ls.w, ls.h], canvasPx: ls.px.slice(), dpr: ls.dpr, guides: Object.assign({}, lineLayout.guides),
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

  btn.blockNext.addEventListener('click', guarded(async () => {
    await enterFullscreen();
    session = { id: uuid(), seq: 0 };
    loadNext();
  }));

  btn.blockPause.addEventListener('click', guarded(() => {
    outbox.flush('session-end');
    setState('resting');
  }));

  btn.restGo.addEventListener('click', guarded(async () => {
    await enterFullscreen();
    session = { id: uuid(), seq: 0 };
    loadNext();
  }));

  // ---------- public ----------

  return {
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
        else requestAnimationFrame(() => layoutCanvas(true));
      }
      updateInline();
    },
    hide() {
      visible = false;
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
    enterFullscreen,
    get state() { return state; },
    get recorder() { return rec; },
    get lastRate() { return lastConfirmRate; },
  };
}
