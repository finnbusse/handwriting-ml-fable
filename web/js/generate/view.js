// The Schreiben screen: text in, handwriting out (SPEC 2.5).
//
// Pieces: model-store.js (download, check, cache), engine-client.js (network in a
// worker), page-writer.js (text -> page, piece by piece), render.js (drawing, export).
//
// What regenerates and what only redraws:
//   text, "Schreiben", "Nochmal schreiben", Lesbarkeit (bias)  -> the network writes again
//   Schriftgröße, Zeilenabstand -> the finished pieces are laid out again (page-writer.relayout),
//                                  nothing is generated
//   Tintenfarbe, window size    -> redraw only
import { createNormalizer } from '../engine/engine.js';
import { createPageWriter } from './page-writer.js';
import { drawStrokes, drawPartial, toSVG, toCanvas } from './render.js';
import { createEngine } from './engine-client.js';
import { createModelStore } from './model-store.js';

const INKS = { blueblack: '#1b2a49', black: '#15171a', blue: '#2141b8' };
const LINE_WIDTH = 0.16;           // pen width in x-heights (render.js default)
const MIN_PAGE_WIDTH = 18;         // x-heights
const BASE_PPS = 260;              // writing animation: points per second when nothing is waiting
const CATCHUP_S = 1.0;             // ... and never slower than "everything waiting within this many seconds"
const MAX_PIXELS = 16e6;           // canvas budget (per canvas; there are two)
const RECHECK_MS = 5 * 60 * 1000;  // look for a newer model at most this often

const DEFAULTS = { text: '', bias: 0.4, size: 16, spacing: 6.5, ink: 'blueblack' };

const mb = (bytes) => (bytes / 1e6).toFixed(1).replace('.', ',');

function formatDate(value) {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
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
    paper: $('gen-paper'), canvas: $('gen-canvas'), empty: $('gen-empty'),
    png: $('gen-png'), svg: $('gen-svg'), copy: $('gen-copy'),
  };
  const ctx = el.canvas.getContext('2d');
  const layer = document.createElement('canvas');      // everything already written (the animation draws on top of it)
  const lctx = layer.getContext('2d');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');

  const S = {
    settings: Object.assign({}, DEFAULTS),
    visible: false,
    // model
    engine: null, engineUser: null, sha: null, normalizer: null, writer: null, trainedOn: null,
    pendingModel: null, syncing: null, lastCheck: 0, authUser: undefined, stale: true,
    info: { kind: 'date' },                       // what the line under the controls says
    // writing
    phase: 'idle', runId: 0, cancelled: false, follow: true,
    lastText: null, seed: null, pageWriter: null,
    page: null, bad: 0,
    // drawing
    settled: 0, pos: 0, total: 0, done: 0, geo: null, raf: 0, last: 0, width: 0,
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
  }

  function showWork() {
    el.card.hidden = true;
    el.work.hidden = false;
    renderInfo();
    if (S.visible) { requestAnimationFrame(() => { fit(); rebuildLayer(); paint(); }); }
  }

  function renderInfo() {
    const i = S.info;
    const date = formatDate(S.trainedOn && S.trainedOn.date);
    const stand = date ? `Modell vom ${date}` : 'Modell bereit';
    let text = stand, bar = null;
    if (i.kind === 'updating') { text = `Neues Modell wird geladen … ${i.total ? `${mb(i.loaded || 0)} von ${mb(i.total)} MB` : ''}`.trim(); bar = i.total ? (100 * (i.loaded || 0)) / i.total : 0; }
    else if (i.kind === 'verifying') text = 'Neues Modell wird geprüft …';
    else if (i.kind === 'updated') text = `Neues Modell geladen. ${stand}`;
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

  async function useModel(entry, trainedOn, { updated = false } = {}) {
    if (S.phase === 'writing') {                    // never swap the network under a running text
      S.pendingModel = { entry, trainedOn, updated };
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
    S.normalizer = normalizer; S.trainedOn = trainedOn || null;
    S.writer = createPageWriter({
      normalize: normalizer.normalize, xhModel: ready.xhModel, gapXh: ready.gapXh,
      writePiece: (job) => engine.writePiece(job),
    });
    if (old) old.terminate();
    S.info = { kind: updated ? 'updated' : 'date' };
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

  /** Use what is on the device at once, then look for a newer model. */
  function refresh() {
    if (S.syncing) return S.syncing;
    S.syncing = (async () => {
      try {
        S.authUser = hf.userName();
        S.stale = false;
        if (!ownEngine()) {
          const cached = await ms.usableCache();
          if (cached) await useModel(cached.entry, cached.trainedOn);
          else if (!hf.userName()) { showCard('signin'); return; }
          else showCard('checking');
        }
        const had = ownEngine();
        let r;
        try {
          r = await ms.sync({
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
        if (r.changed || !ownEngine()) await useModel(r.entry, r.trainedOn, { updated: r.changed && had });
        else if (r.trainedOn && !S.trainedOn) { S.trainedOn = r.trainedOn; S.info = { kind: 'date' }; renderInfo(); }
        else if (S.info.kind !== 'date' && S.info.kind !== 'updated') { S.info = { kind: 'date' }; renderInfo(); }
      } catch (e) {
        console.error(e);
        if (!ownEngine()) showCard('failed');
      } finally { S.syncing = null; }
    })();
    return S.syncing;
  }

  // ---------- drawing ----------

  const ink = () => INKS[S.settings.ink] || INKS.blueblack;
  const drawOptions = () => ({ scale: S.geo.scale, color: ink(), lineWidth: LINE_WIDTH });

  /** The page as shown and exported: widened when an unsplit piece sticks out past the right edge. */
function framed(page) {
  let right = page.width;
  for (const w of page.words) right = Math.max(right, w.x + w.width + 3);
  return right > page.width ? Object.assign({}, page, { width: right }) : page;
}

/** Size the canvases to the page and the sheet; true when the bitmap size changed (= it is blank now). */
  function fit() {
    const page = S.page;
    const cssW = el.paper.clientWidth;
    if (!page || !cssW) return false;
    const cssScale = cssW / framed(page).width;
    const cssH = Math.max(1, Math.ceil(page.height * cssScale));
    let ratio = window.devicePixelRatio || 1;
    let pw = Math.round(cssW * ratio), ph = Math.round(cssH * ratio);
    if (pw * ph > MAX_PIXELS) {
      ratio *= Math.sqrt(MAX_PIXELS / (pw * ph));
      pw = Math.round(cssW * ratio); ph = Math.round(cssH * ratio);
    }
    const changed = el.canvas.width !== pw || el.canvas.height !== ph;
    if (changed) { el.canvas.width = pw; el.canvas.height = ph; layer.width = pw; layer.height = ph; }
    el.canvas.style.height = `${cssH}px`;
    S.geo = { scale: cssScale * ratio, cssScale };
    S.width = cssW;
    return changed;
  }

  function rebuildLayer() {
    if (!S.page || !S.geo) return;
    lctx.clearRect(0, 0, layer.width, layer.height);
    drawStrokes(lctx, S.page.strokes.slice(0, S.settled), drawOptions());
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
      if (rest.length) drawStrokes(lctx, rest, drawOptions());
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
        drawStrokes(lctx, [w], drawOptions());
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
    const box = el.view.getBoundingClientRect();
    const room = 3.5 * S.settings.spacing * S.geo.cssScale;
    if (y + room > box.bottom - 16) el.view.scrollBy({ top: y + room - box.bottom + 24, behavior: 'smooth' });
  }

  function redrawAll() {
    if (!S.visible || !S.page) return;
    fit(); rebuildLayer(); paint();
  }

  /** Same pieces, other width / line height: no new writing. */
  function relayout() {
    if (!S.page || !S.pageWriter || S.phase === 'writing' || !S.visible) return;
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
    el.again.disabled = writing || !S.engine || !S.lastText;
    el.busy.hidden = !writing;
    el.size.disabled = writing; el.spacing.disabled = writing;
    const canExport = !!S.page && !writing;
    el.png.disabled = !canExport; el.svg.disabled = !canExport; el.copy.disabled = !canExport;
    el.empty.hidden = !!S.page || writing;
  }

  function badText(n) {
    return n === 1 ? 'Eine Stelle ist unsauber geworden. „Nochmal schreiben“ schreibt alles neu.'
      : `${n} Stellen sind unsauber geworden. „Nochmal schreiben“ schreibt alles neu.`;
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
    if (S.pendingModel) { const p = S.pendingModel; S.pendingModel = null; await useModel(p.entry, p.trainedOn, { updated: p.updated }); }
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

  function pngBlob() {
    const page = framed(S.page);
    const scale = Math.max(12, Math.min(40, 2400 / page.width, 30000 / page.height));
    const canvas = toCanvas(page, { scale, color: ink(), lineWidth: LINE_WIDTH, background: '#ffffff' });
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'));
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  async function savePng() {
    if (!S.page) return;
    try { download(await pngBlob(), `handschrift-${stamp()}.png`); }
    catch (e) { console.error(e); toast('Das Bild konnte nicht erstellt werden.'); }
  }

  function saveSvg() {
    if (!S.page) return;
    const svg = toSVG(framed(S.page), { scale: 12, color: ink(), lineWidth: LINE_WIDTH });
    download(new Blob([svg], { type: 'image/svg+xml' }), `handschrift-${stamp()}.svg`);
  }

  async function copyPng() {
    if (!S.page) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob() })]);
      toast('Kopiert.');
    } catch (e) {
      console.error(e);
      toast('Kopieren hat nicht geklappt. „Als Bild speichern“ geht immer.');
    }
  }

  // ---------- settings ----------

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const { bias, size, spacing, ink: inkName } = S.settings;
      store.kvSet('generate', { text: el.text.value, bias, size, spacing, ink: inkName }).catch(() => {});
    }, 300);
  }

  function applySettings() {
    el.bias.value = S.settings.bias;
    el.size.value = S.settings.size;
    el.spacing.value = S.settings.spacing;
    for (const b of el.inks.querySelectorAll('[data-ink]')) b.setAttribute('aria-checked', b.dataset.ink === S.settings.ink ? 'true' : 'false');
  }

  let relayoutFrame = 0;
  const wire = () => {
    el.write.addEventListener('click', () => run(el.text.value));
    el.again.addEventListener('click', () => run(S.lastText || el.text.value));
    el.cancel.addEventListener('click', cancel);
    el.text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(el.text.value); }
    });
    el.text.addEventListener('input', () => { setNote(el.note, ''); save(); });
    el.bias.addEventListener('input', () => { S.settings.bias = Number(el.bias.value); save(); });
    const later = () => { cancelAnimationFrame(relayoutFrame); relayoutFrame = requestAnimationFrame(relayout); };
    el.size.addEventListener('input', () => { S.settings.size = Number(el.size.value); save(); later(); });
    el.spacing.addEventListener('input', () => { S.settings.spacing = Number(el.spacing.value); save(); later(); });
    el.inks.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ink]');
      if (!b) return;
      S.settings.ink = b.dataset.ink; applySettings(); save(); redrawAll();
    });
    el.png.addEventListener('click', savePng);
    el.svg.addEventListener('click', saveSvg);
    el.copy.addEventListener('click', copyPng);
    el.copy.hidden = !(typeof ClipboardItem !== 'undefined' && navigator.clipboard && navigator.clipboard.write);
    el.signin.addEventListener('click', () => deps.signIn());
    el.retry.addEventListener('click', () => refresh());
    // The writer scrolling by hand ends the automatic following.
    for (const type of ['wheel', 'touchmove']) el.view.addEventListener(type, () => { S.follow = false; }, { passive: true });
    let lastW = 0;
    new ResizeObserver(() => {
      const w = el.paper.clientWidth;
      if (w === lastW) return;
      lastW = w;
      redrawAll();
    }).observe(el.paper);
    window.addEventListener('resize', redrawAll);
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
          size: num(saved.size, 9, 30, DEFAULTS.size),
          spacing: num(saved.spacing, 5, 9, DEFAULTS.spacing),
          ink: INKS[saved.ink] ? saved.ink : DEFAULTS.ink,
        };
        el.text.value = S.settings.text;
      } else if (window.innerWidth < 600) S.settings.size = 12;
    } catch (_) { /* no stored settings: defaults */ }
    applySettings();
    wire();
    syncUi();
  }

  function show() {
    S.visible = true;
    S.follow = true;
    if (S.page) redrawAll();
    const stale = S.stale || hf.userName() !== S.authUser || Date.now() - S.lastCheck > RECHECK_MS || el.card.hidden === false;
    if (stale && !S.syncing) refresh();
  }

  function hide() { S.visible = false; }

  return {
    init, show, hide, refresh,
    info: () => ms.info(),
    /** For tests and the diagnostics page. */
    debug: () => ({ phase: S.phase, page: S.page, seed: S.seed, sha: S.sha, settings: S.settings, text: S.lastText, bad: S.bad, settled: S.settled, total: S.total, done: S.done }),
  };
}
