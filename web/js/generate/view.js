// The Schreiben screen: text in, handwriting out (SPEC 2.5).
//
// Pieces: model-store.js (download, check, cache), engine-client.js (network in a
// worker), page-writer.js (text -> page, piece by piece), render.js (drawing, export).
//
// What regenerates and what only redraws:
//   text, "Schreiben", "Nochmal schreiben", Lesbarkeit (bias)  -> the network writes again
//   Schriftgröße, Zeilenabstand -> the finished pieces are laid out again (page-writer.relayout),
//                                  nothing is generated
//   Stift, Strichstärke, Papier, Farben, Tinte, window size -> redraw only
//
// The look starts out as the current writer's capture sheet ("Stift & Papier", kv
// `displayBy`), so the page looks like what they write on.  Once it is changed here,
// Schreiben keeps its own (kv `generate`.look).
import { createNormalizer } from '../engine/engine.js';
import { createPageWriter } from './page-writer.js';
import { drawWord, drawWords, drawPartial, drawSheet, toSVG, toCanvas, lookColors, normalizeLook, lookFromCapture, INKS, DEFAULT_LOOK } from './render.js';
import { createEngine } from './engine-client.js';
import { createModelStore } from './model-store.js';
import { normalize as normalizeDisplay, WIDTHS as CAPTURE_WIDTHS } from '../capture/ink.js';

const PAGE_TOP = 6.5, PAGE_MARGIN = 3;   // first baseline and side margin, x-heights (ascenders of enlarged words need about 3.5)
const MIN_PAGE_WIDTH = 18;         // x-heights
const BASE_PPS = 260;              // writing animation: points per second when nothing is waiting
const CATCHUP_S = 1.0;             // ... and never slower than "everything waiting within this many seconds"
const MAX_PIXELS = 16e6;           // canvas budget (per canvas; there are two)
const RECHECK_MS = 5 * 60 * 1000;  // look for a newer model at most this often

const DEFAULTS = { text: '', bias: 0.4, size: 11, spacing: 6.5 };   // size: CSS px per x-height

const mb = (bytes) => (bytes / 1e6).toFixed(1).replace('.', ',');

/** "26. November, 01:48 Uhr" (local time; the year only when it is not this one), or for a bare date "25. November 2026". */
export function formatWhen(value) {
  if (!value) return null;
  const s = String(value);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  const d = dateOnly && m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  if (dateOnly) return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
  const day = d.toLocaleDateString('de-DE', d.getFullYear() === new Date().getFullYear() ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' });
  return `${day}, ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr`;
}

/** One version in the "Modell" list: "26. Nov. 2026, 01:48 · 143 Zeilen · Notiz · Anna" (the writer only when it is someone else). */
export function versionLabel(v, writerId, names = {}) {
  const d = new Date(v.created || '');
  const parts = [Number.isNaN(d.getTime()) ? v.id
    : `${d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`];
  if (Number.isFinite(v.lines)) parts.push(v.lines === 1 ? '1 Zeile' : `${v.lines} Zeilen`);
  if (v.note) parts.push(String(v.note));
  if (v.writer && v.writer !== writerId) parts.push(names[v.writer] || v.writer);
  return parts.join(' · ');
}

const pad = (n) => String(n).padStart(2, '0');
const stamp = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

export function createGenerateView(deps) {
  const { store, hf, toast } = deps;
  const ms = deps.modelStore || createModelStore({ store, hf });
  const $ = (id) => document.getElementById(id);
  const el = {
    view: $('v-schreiben'), card: $('gen-model'), cardText: $('gm-text'), cardBar: $('gm-bar'), cardFill: $('gm-fill'),
    signin: $('gm-signin'), capture: $('gm-capture'), retry: $('gm-retry'),
    work: $('gen-work'), text: $('gen-text'), write: $('gen-write'), again: $('gen-again'),
    busy: $('gen-busy'), busyText: $('gen-busy-text'), cancel: $('gen-cancel'),
    note: $('gen-note'), chars: $('gen-chars'), bad: $('gen-bad'),
    bias: $('gen-bias'), size: $('gen-size'), spacing: $('gen-spacing'), inks: $('gen-inks'),
    infoText: $('gi-text'), infoBar: $('gi-bar'), infoFill: $('gi-fill'),
    stage: $('gen-stage'), paper: $('gen-paper'), canvas: $('gen-canvas'), lines: $('gen-lines'), empty: $('gen-empty'),
    info: $('gen-info'), styleBtn: $('gen-style-btn'), style: $('gen-style'),
    moreBtn: $('gen-more-btn'), more: $('gen-more'), inkRow: $('gen-ink-row'),
    modelRow: $('gen-model-row'), modelPick: $('gen-model-pick'),
    save: $('gen-save'), saveMenu: $('gen-save-menu'),
    png: $('gen-png'), inkPng: $('gen-ink-png'), svg: $('gen-svg'), copy: $('gen-copy'),
  };
  const ctx = el.canvas.getContext('2d');
  const gctx = el.lines.getContext('2d');               // the paper and its lines, under the ink
  const layer = document.createElement('canvas');      // everything already written (the animation draws on top of it)
  const lctx = layer.getContext('2d');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');

  const S = {
    settings: Object.assign({}, DEFAULTS),
    look: Object.assign({}, DEFAULT_LOOK),
    ownLook: false,                               // changed here at least once: no longer follows the capture sheet
    visible: false,
    // model
    engine: null, engineUser: null, sha: null, normalizer: null, writer: null, trainedOn: null,
    version: null, index: null, choice: 'newest', switching: false, again: false,
    pendingModel: null, syncing: null, lastCheck: 0, authUser: undefined, stale: true,
    info: { kind: 'date' },                       // what the line under the controls says
    // writing
    phase: 'idle', runId: 0, cancelled: false, follow: true,
    lastText: null, seed: null, pageWriter: null,
    page: null, bad: 0,
    // drawing
    settled: 0, pos: 0, total: 0, done: 0, geo: null, raf: 0, last: 0, width: 0, sheetKey: '',
  };

  // ---------- model card / info line ----------

  function showCard(kind, o = {}) {
    const texts = {
      checking: 'Dein Modell wird gesucht …',
      signin: 'Bitte anmelden, damit dein Modell geladen werden kann.',
      nomodel: 'Es gibt noch kein Modell. Schreib zuerst ein paar Zeilen unter Erfassen.',
      downloading: `Dein Modell wird geladen … ${o.total ? `${mb(o.loaded || 0)} von ${mb(o.total)} MB` : ''}`.trim(),
      verifying: 'Das Modell wird geprüft …',
      failed: 'Das Modell konnte nicht geladen werden. Bitte prüfe die Verbindung.',
      checksum: 'Das geladene Modell ist beschädigt und wird nicht benutzt. Bitte versuch es noch einmal.',
      auth: 'Deine Anmeldung gilt nicht mehr. Bitte melde dich neu an.',
      broken: 'Das Modell konnte nicht gestartet werden.',
    };
    el.card.dataset.kind = kind;
    el.cardText.textContent = texts[kind];
    el.cardBar.hidden = kind !== 'downloading';
    el.cardFill.style.width = o.total ? `${Math.min(100, (100 * (o.loaded || 0)) / o.total)}%` : '0%';
    el.signin.hidden = !['signin', 'auth'].includes(kind);
    el.capture.hidden = kind !== 'nomodel';
    el.retry.hidden = !['nomodel', 'failed', 'checksum', 'broken'].includes(kind);
    el.retry.querySelector('span').textContent = kind === 'nomodel' ? 'Nochmal prüfen' : 'Nochmal versuchen';
    el.card.hidden = false;
    el.work.hidden = true;
    el.empty.hidden = true;
  }

  function showWork() {
    el.card.hidden = true;
    el.work.hidden = false;
    renderInfo();
    syncUi();
    autosize();
    if (S.visible) { requestAnimationFrame(() => { fit(); rebuildLayer(); paint(); }); }
  }

  function renderInfo() {
    const i = S.info;
    const date = formatWhen((S.version && S.version.created) || (S.trainedOn && S.trainedOn.date));
    const stand = date ? `Modell vom ${date}` : 'Modell bereit';
    const what = S.switching ? 'Modell' : 'Neues Modell';
    let text = stand, bar = null;
    if (i.kind === 'updating') { text = `${what} wird geladen … ${i.total ? `${mb(i.loaded || 0)} von ${mb(i.total)} MB` : ''}`.trim(); bar = i.total ? (100 * (i.loaded || 0)) / i.total : 0; }
    else if (i.kind === 'verifying') text = `${what} wird geprüft …`;
    else if (i.kind === 'updated') text = `Neues Modell geladen. ${stand}`;
    else if (i.kind === 'switched') text = `Jetzt in Gebrauch: ${stand}`;
    else if (i.kind === 'gone') text = `Das gewählte Modell gibt es nicht mehr. Jetzt schreibt das neueste: ${stand}`;
    else if (i.kind === 'waiting') text = `Neues Modell gefunden. Es wird nach dem Schreiben benutzt.`;
    else if (i.kind === 'checksum') text = 'Das neue Modell war beschädigt und wurde nicht übernommen. Das bisherige bleibt im Gebrauch.';
    else if (i.kind === 'auth') text = `Deine Anmeldung gilt nicht mehr. ${stand}`;
    el.infoText.textContent = text;
    el.infoBar.hidden = bar === null;
    if (bar !== null) el.infoFill.style.width = `${Math.min(100, bar)}%`;
  }

  const ownEngine = () => {
    const user = hf.userName();
    return !!S.engine && (!user || S.engineUser === user);
  };

  async function useModel(entry, trainedOn, { updated = false, info = null } = {}) {
    if (S.phase === 'writing') {                    // never swap the network under a running text
      S.pendingModel = { entry, trainedOn, updated, info };
      S.info = { kind: 'waiting' }; renderInfo();
      return;
    }
    const engine = createEngine(entry.manifest, entry.buffer);
    let ready;
    try { ready = await engine.ready; }
    catch (e) {
      console.error(e);
      engine.terminate();
      if (!S.engine) showCard('broken');
      return;
    }
    const old = S.engine;
    const normalizer = createNormalizer(ready.charset);
    S.engine = engine; S.engineUser = entry.user; S.sha = entry.manifest.sha256;
    S.normalizer = normalizer; S.trainedOn = trainedOn || null; S.version = entry.version || null;
    S.writer = createPageWriter({
      normalize: normalizer.normalize, xhModel: ready.xhModel, gapXh: ready.gapXh,
      sizeByBias: entry.manifest.size_by_bias || null,
      writePiece: (job) => engine.writePiece(job),
    });
    if (old) old.terminate();
    S.info = { kind: info || (updated ? 'updated' : 'date') };
    S.switching = false;
    renderPicker();
    showWork();
    syncUi();
  }

  function onSyncError(e) {
    const have = ownEngine();
    if (!have && S.engine) { S.engine.terminate(); S.engine = null; S.writer = null; }   // some other account's model
    switch (e.kind) {
      case 'cancelled': return;
      case 'signin': if (!have) showCard('signin'); return;
      case 'nomodel': if (!have) showCard('nomodel'); return;
      case 'auth': if (have) { S.info = { kind: 'auth' }; renderInfo(); } else showCard('auth'); return;
      case 'checksum': if (have) { S.info = { kind: 'checksum' }; renderInfo(); } else showCard('checksum'); return;
      default: if (!have) showCard('failed');          // offline or server trouble: the cached model, if any, just carries on
    }
  }

  /** The current writer (for "Neuestes") and the names of all writers on this device (for the list). */
  async function writers() {
    try {
      const id = await store.kvGet('writer', null);
      const list = await store.kvGet('writers', []);
      const names = {};
      for (const w of Array.isArray(list) ? list : []) if (w && w.id) names[w.id] = w.name;
      return { id, names };
    } catch (_) { return { id: null, names: {} }; }
  }

  /** Use what is on the device at once, then look for a newer model (or the chosen one). */
  function refresh() {
    if (S.syncing) { S.again = true; return S.syncing; }      // a choice made meanwhile is looked at right after
    S.syncing = (async () => {
      try {
        S.authUser = hf.userName();
        S.stale = false;
        if (!ownEngine()) {
          const cached = await ms.usableCache(S.choice);
          if (cached) await useModel(cached.entry, cached.trainedOn);
          else if (!hf.userName()) { showCard('signin'); return; }
          else showCard('checking');
        }
        const had = ownEngine();
        const who = await writers();
        S.writerId = who.id; S.writerNames = who.names;
        const choice = S.choice;
        let r;
        try {
          r = await ms.sync({
            choice, writer: who.id,
            onStage: (stage, o = {}) => {
              if (stage === 'downloading') { if (had) S.info = { kind: 'updating', loaded: 0, total: o.total }; else showCard('downloading', { loaded: 0, total: o.total }); }
              else if (had) S.info = { kind: 'verifying' }; else showCard('verifying');
              if (had) renderInfo();
            },
            onProgress: (loaded, total) => {
              if (had) { S.info = { kind: 'updating', loaded, total }; renderInfo(); }
              else showCard('downloading', { loaded, total });
            },
          });
        } catch (e) { onSyncError(e); return; }
        S.lastCheck = Date.now();
        S.index = r.index;
        if (r.fallback && choice === S.choice) { S.choice = 'newest'; saveChoice(); }
        // r.described: same weights, but the model's description changed (its letter-size table): take it over too
        const other = !ownEngine() || r.described || String(r.entry.manifest.sha256).toLowerCase() !== String(S.sha || '').toLowerCase();
        const info = r.fallback ? 'gone' : S.switching ? 'switched' : null;
        if (other) await useModel(r.entry, r.trainedOn, { updated: had && choice === 'newest', info });
        else {
          S.trainedOn = r.trainedOn || S.trainedOn; S.version = r.version || S.version; S.switching = false;
          if (info) S.info = { kind: info };
          else if (S.info.kind !== 'updated') S.info = { kind: 'date' };
          renderInfo(); renderPicker();
        }
      } catch (e) {
        console.error(e);
        if (!ownEngine()) showCard('failed');
      } finally {
        S.syncing = null;
        if (S.again) { S.again = false; refresh(); }
      }
    })();
    return S.syncing;
  }

  // ---------- "Modell" (under Erweitert): which version writes ----------

  function renderPicker() {
    const models = (S.index && S.index.models) || [];
    el.modelRow.hidden = models.length === 0;               // an older repo without versions: nothing to choose
    if (!models.length) return;
    const pick = el.modelPick;
    const want = [['newest', 'Neuestes']].concat(models.map((m) => [m.id, versionLabel(m, S.writerId, S.writerNames || {})]));
    const have = [...pick.options].map((o) => [o.value, o.textContent]);
    if (JSON.stringify(want) !== JSON.stringify(have)) {
      pick.textContent = '';
      for (const [value, label] of want) { const o = document.createElement('option'); o.value = value; o.textContent = label; pick.append(o); }
    }
    pick.value = models.some((m) => m.id === S.choice) ? S.choice : 'newest';
  }

  function saveChoice() {
    store.kvSet('modelChoice', { user: hf.userName(), id: S.choice }).catch(() => {});
  }

  function choose(id) {
    if (id === S.choice) return;
    S.choice = id; saveChoice();
    S.switching = true;
    refresh();
  }

  // ---------- drawing ----------

  /** What every drawing call needs: the look, its colours and the current scale. */
  const drawOptions = () => ({ scale: S.geo.scale, look: S.look, colors: lookColors(S.look) });

  /** The page as shown and exported: widened when an unsplit piece sticks out past the right edge. */
  function framed(page) {
    let right = page.width;
    for (const w of page.words) right = Math.max(right, w.x + w.width + 3);
    return right > page.width ? Object.assign({}, page, { width: right }) : page;
  }

  /** Device px per CSS px for a canvas of cssW x cssH, within the pixel budget. */
  function ratioFor(cssW, cssH) {
    const ratio = window.devicePixelRatio || 1;
    const px = cssW * ratio * cssH * ratio;
    return px > MAX_PIXELS ? ratio * Math.sqrt(MAX_PIXELS / px) : ratio;
  }

  /** Size the canvases to the page and the sheet; true when the ink bitmap size changed (= it is blank now).
   *  Without a page the paper is still drawn, at the scale the next page will have. */
  function fit() {
    const page = S.page;
    const cssW = el.paper.clientWidth;
    if (!cssW) return false;
    const cssScale = cssW / (page ? framed(page).width : pageWidth());
    const cssH = page ? Math.max(1, Math.ceil(page.height * cssScale)) : 0;
    const ratio = ratioFor(cssW, Math.max(cssH, 1));
    const pw = Math.round(cssW * ratio), ph = Math.max(1, Math.round(cssH * ratio));   // never 0: getImageData must work
    const changed = el.canvas.width !== pw || el.canvas.height !== ph;
    if (changed) { el.canvas.width = pw; el.canvas.height = ph; layer.width = pw; layer.height = ph; }
    el.canvas.style.height = `${cssH}px`;
    S.geo = { scale: cssScale * ratio, cssScale, ratio };
    S.width = cssW;
    paintSheet();
    return changed;
  }

  const sheetGeometry = (scale, lineWidth) => ({ scale, spacing: S.settings.spacing, top: PAGE_TOP, margin: PAGE_MARGIN, lineWidth });

  /** The paper canvas covers the whole sheet (also below the last line); repainted only when something it shows changed. */
  function paintSheet() {
    if (!S.geo) return;
    const cssW = el.paper.clientWidth, cssH = el.paper.clientHeight;
    if (!cssW || !cssH) return;
    const ratio = ratioFor(cssW, cssH);
    const pw = Math.round(cssW * ratio), ph = Math.round(cssH * ratio);
    const scale = S.geo.cssScale * ratio;
    const key = [pw, ph, scale, S.look.paper, S.look.scheme, S.settings.spacing].join('|');
    if (key === S.sheetKey) return;
    S.sheetKey = key;
    if (el.lines.width !== pw || el.lines.height !== ph) { el.lines.width = pw; el.lines.height = ph; }
    el.lines.style.height = `${cssH}px`;
    drawSheet(gctx, pw, ph, S.look, lookColors(S.look), sheetGeometry(scale, Math.max(1, Math.round(ratio))));
  }

  /** The settled words, drawn one by one exactly as the animation draws them. */
  function rebuildLayer() {
    if (!S.page || !S.geo) return;
    lctx.clearRect(0, 0, layer.width, layer.height);
    drawWords(lctx, S.page.strokes.slice(0, S.settled), drawOptions());
  }

  function paint() {
    if (!S.page || !S.geo) { ctx.clearRect(0, 0, el.canvas.width, el.canvas.height); return; }
    ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
    ctx.drawImage(layer, 0, 0);
    if (S.settled < S.page.strokes.length && S.pos >= 1) drawPartial(ctx, S.page.strokes[S.settled], Math.floor(S.pos), drawOptions());
  }

  /** Everything still to be animated is drawn at once. */
  function settleAll() {
    const page = S.page;
    if (!page) return;
    if (S.visible && S.geo) {
      const rest = page.strokes.slice(S.settled);
      if (rest.length) drawWords(lctx, rest, drawOptions());
    }
    S.settled = page.strokes.length; S.pos = 0; S.done = S.total;
    if (S.visible) paint();
  }

  const wordPoints = (words) => words.reduce((n, w) => n + w.length / 3, 0);

  function schedule() {
    if (S.raf) return;
    S.last = performance.now();
    S.raf = requestAnimationFrame(tick);
  }

  // The pen runs at a steady pace, but never so slowly that more than about a
  // second of writing is waiting: when generation outruns the pen, the pen speeds up.
  function tick(now) {
    S.raf = 0;
    const page = S.page;
    if (!page) return;
    if (!S.visible || motion.matches) { settleAll(); return; }
    const dt = Math.min(0.1, Math.max(0, (now - S.last) / 1000));
    S.last = now;
    let adv = Math.max(BASE_PPS, (S.total - S.done) / CATCHUP_S) * dt;
    const before = S.settled;
    while (adv > 0 && S.settled < page.strokes.length) {
      const w = page.strokes[S.settled];
      const left = w.length / 3 - S.pos;
      if (adv >= left) {
        drawWord(lctx, w, drawOptions());
        S.settled++; S.pos = 0; S.done += left; adv -= left;
      } else { S.pos += adv; S.done += adv; adv = 0; }
    }
    paint();
    if (S.settled !== before) follow();
    if (S.settled < page.strokes.length) schedule();
  }

  /** Keep the line being written in view (until the writer scrolls by hand). */
  function follow() {
    if (!S.follow || S.phase !== 'writing' || !S.page || !S.geo) return;
    const w = S.page.words[Math.min(S.settled, S.page.words.length - 1)];
    if (!w) return;
    const top = el.canvas.getBoundingClientRect().top;
    const y = top + w.y * S.geo.cssScale;                  // the baseline of the word being written
    const box = el.stage.getBoundingClientRect();
    const room = 2.5 * S.settings.spacing * S.geo.cssScale;
    if (y + room > box.bottom - 16) el.stage.scrollBy({ top: y + room - box.bottom + 24, behavior: 'smooth' });
  }

  function redrawAll() {
    if (!S.visible) return;
    fit(); rebuildLayer(); paint();
  }

  /** Same pieces, other width / line height: no new writing. */
  function relayout() {
    if (!S.visible) return;
    if (!S.page || !S.pageWriter || S.phase === 'writing') { fit(); return; }
    const page = S.pageWriter.relayout({ width: pageWidth(), lineHeight: S.settings.spacing });
    if (!page) return;
    S.page = page;
    S.settled = page.strokes.length; S.pos = 0; S.done = S.total;
    fit(); rebuildLayer(); paint();
  }

  const pageWidth = () => Math.max(MIN_PAGE_WIDTH, Math.floor((el.paper.clientWidth || 600) / S.settings.size));

  // ---------- writing ----------

  function setNote(node, text) {
    node.textContent = text || '';
    node.hidden = !text;
  }

  function syncUi() {
    const writing = S.phase === 'writing';
    el.write.disabled = writing || !S.engine;
    el.write.hidden = writing; el.cancel.hidden = !writing;       // one place, two meanings
    el.again.disabled = writing || !S.engine || !S.lastText;
    el.busy.hidden = !writing; el.info.hidden = writing;
    el.size.disabled = writing; el.spacing.disabled = writing;
    const canExport = !!S.page && !writing;
    el.save.disabled = !canExport;
    el.png.disabled = !canExport; el.inkPng.disabled = !canExport; el.svg.disabled = !canExport; el.copy.disabled = !canExport;
    if (!canExport) closeMenu();
    el.empty.hidden = !!S.page || writing || !el.card.hidden;
  }

  // ---------- small pieces of the surface ----------

  /** The text line grows with its text (up to the height the stylesheet allows). */
  function autosize() {
    if (!S.visible) return;
    el.text.style.height = 'auto';
    el.text.style.height = `${el.text.scrollHeight}px`;
  }

  function closeMenu() {
    if (el.saveMenu.hidden) return;
    el.saveMenu.hidden = true;
    el.save.setAttribute('aria-expanded', 'false');
  }

  function toggleMenu() {
    if (!el.saveMenu.hidden) { closeMenu(); return; }
    el.saveMenu.hidden = false;
    el.save.setAttribute('aria-expanded', 'true');
  }

  function toggleStyle() {
    const open = el.style.hidden;
    el.style.hidden = !open;
    el.styleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function toggleMore() {
    const open = el.more.hidden;
    el.more.hidden = !open;
    el.moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function badText(n) {
    return n === 1 ? 'Eine Stelle ist unsauber geworden. „Nochmal“ schreibt alles neu.'
      : `${n} Stellen sind unsauber geworden. „Nochmal“ schreibt alles neu.`;
  }

  function charsText(list) {
    const shown = [...new Set(list)].slice(0, 8).map((c) => `„${c}“`).join(', ');
    const more = new Set(list).size > 8 ? ' …' : '';
    return `Diese Zeichen kann ich nicht schreiben und lasse sie weg: ${shown}${more}`;
  }

  async function run(text) {
    if (!S.engine || S.phase === 'writing') return;
    text = String(text || '').replace(/\r/g, '');
    const norm = text.split('\n').map((l) => S.normalizer.normalize(l)).join('\n');
    setNote(el.note, ''); setNote(el.bad, '');
    const unsupported = S.normalizer.unsupported(text);
    setNote(el.chars, unsupported.length ? charsText(unsupported) : '');
    if (!norm.replace(/\s/g, '')) {
      setNote(el.note, text.trim() ? 'In diesem Text steht nichts, was ich schreiben kann.' : 'Bitte tippe zuerst einen Text.');
      if (!text.trim()) el.text.focus();
      return;
    }

    const mine = ++S.runId;
    if (matchMedia('(pointer: coarse)').matches) el.text.blur();   // put the on-screen keyboard away: the sheet is the thing to watch
    el.stage.scrollTop = 0;
    S.phase = 'writing'; S.cancelled = false; S.follow = true;
    S.lastText = text; S.seed = (Math.random() * 2 ** 32) >>> 0;
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    S.page = null; S.settled = 0; S.pos = 0; S.total = 0; S.done = 0; S.bad = 0;
    lctx.clearRect(0, 0, layer.width, layer.height); ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
    el.canvas.style.height = '0px';
    el.busyText.textContent = 'schreibt …';
    S.pageWriter = S.writer;
    syncUi();

    const writer = S.writer;
    let page = null;
    try {
      page = await writer.write(text, {
        bias: S.settings.bias, width: pageWidth(), lineHeight: S.settings.spacing, seed: S.seed,
        top: PAGE_TOP, margin: PAGE_MARGIN,
        onPiece: onPiece,
        onProgress: (done, total) => { if (mine === S.runId) el.busyText.textContent = total > 1 ? `schreibt … ${done} von ${total}` : 'schreibt …'; },
      });
    } catch (e) {
      if (!e || !e.cancelled) { console.error(e); setNote(el.note, 'Beim Schreiben ist etwas schiefgegangen. Bitte versuch es noch einmal.'); }
    }
    if (mine !== S.runId) return;
    S.phase = 'idle';
    if (page) S.page = page;
    if (S.cancelled) { settleAll(); setNote(el.note, S.page ? 'Abgebrochen. Was schon geschrieben ist, bleibt stehen.' : 'Abgebrochen.'); }
    setNote(el.bad, S.bad ? badText(S.bad) : '');
    syncUi();
    if (S.pendingModel) { const p = S.pendingModel; S.pendingModel = null; await useModel(p.entry, p.trainedOn, { updated: p.updated, info: p.info }); }
    save();
  }

  function onPiece({ page, fresh, problems }) {
    S.page = page;
    S.total += wordPoints(fresh);
    if (problems.length) S.bad++;
    el.empty.hidden = true;
    if (!S.visible) { S.settled = page.strokes.length; S.done = S.total; return; }
    if (fit()) rebuildLayer();
    paint();
    schedule();
    syncUi();
  }

  function cancel() {
    if (S.phase !== 'writing') return;
    S.cancelled = true;
    if (S.pageWriter) S.pageWriter.cancel();
    if (S.engine) S.engine.cancel();
  }

  // ---------- export ----------

  /** Export geometry: the lines as wide, relative to the page, as on screen. */
  function exportOptions(scale, paper) {
    const cssScale = (S.geo && S.geo.cssScale) || S.settings.size;
    return { scale, look: S.look, paper, guideWidth: scale / cssScale, spacing: S.settings.spacing, top: PAGE_TOP, margin: PAGE_MARGIN };
  }

  /** paper: true = the sheet as shown (paper, lines, pen); false = transparent, ink only. */
  function pngBlob(paper = true) {
    const page = framed(S.page);
    const scale = Math.max(12, Math.min(40, 2400 / page.width, 30000 / page.height));
    const canvas = toCanvas(page, exportOptions(scale, paper));
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'));
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  async function savePng(paper = true) {
    if (!S.page) return;
    try { download(await pngBlob(paper), `handschrift-${stamp()}${paper ? '' : '-ohne-papier'}.png`); }
    catch (e) { console.error(e); toast('Das Bild konnte nicht erstellt werden.'); }
  }

  function saveSvg() {
    if (!S.page) return;
    const svg = toSVG(framed(S.page), exportOptions(12, true));
    download(new Blob([svg], { type: 'image/svg+xml' }), `handschrift-${stamp()}.svg`);
  }

  async function copyPng() {
    if (!S.page) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob() })]);
      toast('Kopiert.');
    } catch (e) {
      console.error(e);
      toast('Kopieren hat nicht geklappt. Speichern „Als Bild“ geht immer.');
    }
  }

  // ---------- settings ----------

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const { bias, size, spacing } = S.settings;
      const v = { text: el.text.value, bias, size, spacing };
      if (S.ownLook) v.look = Object.assign({}, S.look);
      store.kvSet('generate', v).catch(() => {});
    }, 300);
  }

  function applySettings() {
    el.bias.value = S.settings.bias;
    el.size.value = S.settings.size;
    el.spacing.value = S.settings.spacing;
    applyLook();
  }

  /** Buttons, swatches and the sheet's own colours follow the look. */
  function applyLook() {
    const l = S.look;
    for (const b of el.style.querySelectorAll('.gen-choice')) {
      const v = b.dataset.k === 'width' ? Number(b.dataset.v) : b.dataset.v;
      b.setAttribute('aria-checked', l[b.dataset.k] === v ? 'true' : 'false');
    }
    for (const b of el.inks.querySelectorAll('[data-ink]')) {
      const [color, name] = INKS[l.scheme][b.dataset.ink];
      b.setAttribute('aria-checked', b.dataset.ink === l.ink ? 'true' : 'false');
      b.setAttribute('aria-label', name); b.title = name;
      b.firstElementChild.style.background = color;
    }
    el.inkRow.hidden = l.pen === 'bleistift';       // graphite has no ink to choose
    el.paper.dataset.scheme = l.scheme;
  }

  /** Change one part of the look here: from now on Schreiben keeps its own. */
  function setLook(key, value) {
    const next = normalizeLook(Object.assign({}, S.look, { [key]: value }));
    if (next[key] === S.look[key] && S.ownLook) return;
    S.look = next; S.ownLook = true;
    applyLook(); save();
    S.sheetKey = '';
    if (key === 'paper') paintSheet(); else redrawAll();
  }

  /** Until the look is changed here, it is the current writer's capture sheet (when they set one up). */
  async function followCapture() {
    if (S.ownLook) return;
    let look = DEFAULT_LOOK;
    try {
      const wid = await store.kvGet('writer', null);
      const by = wid ? await store.kvGet('displayBy', null) : null;
      if (by && by[wid] && typeof by[wid] === 'object') look = lookFromCapture(normalizeDisplay(by[wid]), CAPTURE_WIDTHS);
    } catch (_) { /* no capture look: Schreiben's own defaults */ }
    if (S.ownLook) return;
    const next = normalizeLook(look);
    if (JSON.stringify(next) === JSON.stringify(S.look)) return;
    S.look = next;
    applyLook();
    S.sheetKey = ''; redrawAll();
  }

  let relayoutFrame = 0;
  const wire = () => {
    el.write.addEventListener('click', () => run(el.text.value));
    el.again.addEventListener('click', () => run(S.lastText || el.text.value));
    el.cancel.addEventListener('click', cancel);
    el.text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(el.text.value); }
    });
    el.text.addEventListener('input', () => { setNote(el.note, ''); autosize(); save(); });
    el.bias.addEventListener('input', () => { S.settings.bias = Number(el.bias.value); save(); });
    // Lesbarkeit changes how the network writes, so letting go of the slider writes the text again.
    el.bias.addEventListener('change', () => { if (S.lastText && S.phase === 'idle') run(S.lastText); });
    el.styleBtn.addEventListener('click', toggleStyle);
    el.moreBtn.addEventListener('click', toggleMore);
    el.modelPick.addEventListener('change', () => choose(el.modelPick.value));
    el.style.addEventListener('click', (e) => {
      const b = e.target.closest('.gen-choice');
      if (!b) return;
      setLook(b.dataset.k, b.dataset.k === 'width' ? Number(b.dataset.v) : b.dataset.v);
    });
    el.save.addEventListener('click', toggleMenu);
    el.saveMenu.addEventListener('click', (e) => { if (e.target.closest('button')) closeMenu(); });
    document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.gen-menu-wrap')) closeMenu(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.saveMenu.hidden) { closeMenu(); el.save.focus(); } });
    const later = () => { cancelAnimationFrame(relayoutFrame); relayoutFrame = requestAnimationFrame(relayout); };
    el.size.addEventListener('input', () => { S.settings.size = Number(el.size.value); save(); later(); });
    el.spacing.addEventListener('input', () => { S.settings.spacing = Number(el.spacing.value); save(); later(); });
    el.inks.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ink]');
      if (b) setLook('ink', b.dataset.ink);
    });
    el.png.addEventListener('click', () => savePng(true));
    el.inkPng.addEventListener('click', () => savePng(false));
    el.svg.addEventListener('click', saveSvg);
    el.copy.addEventListener('click', copyPng);
    el.copy.hidden = !(typeof ClipboardItem !== 'undefined' && navigator.clipboard && navigator.clipboard.write);
    el.signin.addEventListener('click', () => deps.signIn());
    el.retry.addEventListener('click', () => refresh());
    // The writer scrolling by hand ends the automatic following.
    for (const type of ['wheel', 'touchmove']) el.stage.addEventListener(type, () => { S.follow = false; }, { passive: true });
    let lastW = 0;
    new ResizeObserver(() => {
      const w = el.paper.clientWidth;
      if (w === lastW) { if (S.visible) paintSheet(); return; }     // only taller or shorter: the paper, not the ink
      lastW = w;
      redrawAll();
    }).observe(el.paper);
    window.addEventListener('resize', () => { redrawAll(); autosize(); });
    window.addEventListener('hw-auth', () => { S.stale = true; if (S.visible) refresh(); });
    window.addEventListener('online', () => { if (S.visible && !S.syncing) refresh(); });
  };

  async function init() {
    try {
      const saved = await store.kvGet('generate', null);
      if (saved && typeof saved === 'object') {
        const num = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
        S.settings = {
          text: typeof saved.text === 'string' ? saved.text : '',
          bias: num(saved.bias, 0, 1.2, DEFAULTS.bias),
          size: num(saved.size, 6, 30, DEFAULTS.size),
          spacing: num(saved.spacing, 5, 9, DEFAULTS.spacing),
        };
        if (saved.look && typeof saved.look === 'object') { S.look = normalizeLook(saved.look); S.ownLook = true; }
        el.text.value = S.settings.text;
      } else if (window.innerWidth < 600) S.settings.size = 9;
    } catch (_) { /* no stored settings: defaults */ }
    try {
      const c = await store.kvGet('modelChoice', null);
      if (c && typeof c.id === 'string' && c.user === hf.userName()) S.choice = c.id;
    } catch (_) { /* "Neuestes" */ }
    applySettings();
    wire();
    syncUi();
    await followCapture();
  }

  function show() {
    S.visible = true;
    S.follow = true;
    autosize();
    redrawAll();
    followCapture();
    const stale = S.stale || hf.userName() !== S.authUser || Date.now() - S.lastCheck > RECHECK_MS || el.card.hidden === false;
    if (stale && !S.syncing) refresh();
  }

  function hide() { S.visible = false; }

  return {
    init, show, hide, refresh,
    info: () => ms.info(),
    /** For tests and the diagnostics page. */
    debug: () => ({ choice: S.choice, version: S.version ? S.version.id : null, models: ((S.index && S.index.models) || []).map((m) => m.id), phase: S.phase, page: S.page, seed: S.seed, sha: S.sha, settings: S.settings, look: Object.assign({}, S.look), ownLook: S.ownLook, runs: S.runId, scale: S.geo ? S.geo.scale : 0, text: S.lastText, bad: S.bad, settled: S.settled, total: S.total, done: S.done }),
  };
}
