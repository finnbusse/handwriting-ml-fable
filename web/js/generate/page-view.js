// The page mode of Schreiben ("Seite", SPEC 2.5.2): a typed text written onto A4
// pages by several engines at once, shown page by page while it is written, a tap
// on a word writes its piece again, and the pages download as one PDF.
//
// document.js lays out (in the worker of pen.js), render.js draws, pdf.js writes the file;
// all three read the same document object, so the pages on the screen are the pages in the
// PDF.  pen.js also gives the order in which the pen puts a page on paper.
// view.js owns the model and the shared controls (Stil, Lesbarkeit) and hands them in.
import {
  planDocument, pieceSeed, preparePiece, layoutDocument, wordAt, pieceBoxes,
  PAGE, DOC_PAPERS, DOC_SIZES,
} from './document.js';
import { lookColors, drawDocumentPage, BOLD } from './render.js';
import { documentToPDF, pdfFileName } from './pdf.js';
import { createEnginePool, poolSize } from './engine-client.js';
import { createLayouts } from './pen.js';
import { parseMarkup, plainText, detectFormat } from './markup.js';
import { unwrapLines } from './unwrap.js';
import { createFormatHelp } from './format-help.js';
import { createEditor } from './editor-tools.js';

// animate: null until the writer sets "Schreiben zeigen" (then: on unless the system asks for less motion)
export const PAGE_DEFAULTS = Object.freeze({ text: '', paper: 'liniert', size: 'mittel', textLayer: true, format: 'auto', unwrap: true, animate: null });
const FORMATS = ['auto', 'markdown', 'latex', 'text'];
const FORMAT_NAMES = { markdown: 'Markdown', latex: 'LaTeX' };
// A region repainted on a page (what a later piece moved or put under the ink) larger than
// this share of the page: the whole page is drawn instead, in one step.
const REGION_MAX = 0.4;
const MAX_PIXELS = 8e6;        // per page canvas
// Drawn pages kept when they scroll away, the ones seen last first: a page dropped is drawn
// again on its way back into view (a Bleistift page: 130 ms in the paint worker).  Three is
// as many as are near the viewport at once anyway, so a document of up to three pages is
// drawn once and scrolling through it draws nothing.
const KEEP_PAGES = 3;
const TAP_MOVE = 10;           // CSS px a tap may move and still count as a tap
const REACH = { touch: 3, pen: 2, mouse: 1.5 };   // mm around a word that still hits it (a finger is wide)
// The pen: points a second when nothing waits, the pace of the quick sheet (view.js BASE_PPS);
// when written pieces wait, fast enough that what waits is CATCHUP_S of writing (three engines
// write about 600 points a second, more than twice the calm pace); once the last piece is
// written, the rest is on the page within FINISH_S.
const PEN_PPS = 260, CATCHUP_S = 2, FINISH_S = 1.8, SPEEDUP_S = 1;
const LOG_MAX = 20000;         // debug: entries of the pen's log kept

const squash = (s) => s.split('\n').map((l) => l.trim().replace(/\s+/gu, ' ')).join('\n').replace(/\n+$/, '');
/** A parsed text with nothing in it but its words and lines: written as the text itself. */
function plainDoc(doc, text) {
  const plainSpan = (sp) => Object.keys(sp).every((k) => k === 'text');
  return doc.blocks.every((b) => (b.type === 'paragraph' || b.type === 'blank') && b.box == null && (!b.align || b.align === 'left') && (b.lines || []).every((l) => l.every(plainSpan)))
    && squash(plainText(doc)) === squash(text.replace(/^\uFEFF/, ''));
}
/** The words a document writes (for the characters the model cannot write). */
const docText = (doc) => doc.blocks.flatMap((b) => (b.lines || []).map((l) => l.map((sp) => sp.text).join(''))).join('\n');

/**
 * deps: { store, model() -> { entry, info, normalizer } | null, look() -> render.js look,
 * bias() -> number, painter (paint-worker.js: draws the pages), onIdle() (called when
 * nothing is being written any more) }
 */
export function createPageView(deps) {
  const { store, model, look, bias, painter } = deps;
  const $ = (id) => document.getElementById(id);
  const el = {
    stage: $('pg-stage'), pages: $('pg-pages'), empty: $('pg-empty'), pick: $('pg-pick'), redo: $('pg-redo'),
    text: $('pg-text'), write: $('pg-write'), cancel: $('pg-cancel'),
    busy: $('pg-busy'), busyText: $('pg-busy-text'), info: $('pg-info'), bar: $('pg-bar'), fill: $('pg-fill'),
    pdf: $('pg-pdf'), share: $('pg-share'), note: $('pg-note'), chars: $('pg-chars'),
    textLayer: $('pg-textlayer'), detected: $('pg-detected'), unwrap: $('pg-unwrap'), animate: $('pg-animate'), now: $('pg-now'),
  };
  const P = {
    settings: { ...PAGE_DEFAULTS },
    visible: false, active: false,
    pool: null, poolSha: null,
    run: null,            // { id, token, text, seed, bias, plan, written, version, info, sizeByBias, start, done, cancelled, pen, prev }
    view: null,           // the run whose document is shown (an update shows the one before until its own is laid out)
    doc: null, order: [], settled: 0, phase: 'idle', rewriting: new Set(), pick: null, follow: true,
    lay: null, laying: false, again: false, waiters: [],   // the layout worker, one request at a time
    G: null, Gtag: '', shown: [], held: null, cur: null,  // the pen: entries in reading order, what each page shows, the stroke on its way
    frames: [],           // per page: { wrap, canvas, id, key, drawn: Map key -> { n, box } of what is on the canvas, seen }
    near: new Set(), done: new Set(), seen: 0, raf: 0, lastStatus: '',
    message: '', notes: [],   // the note line: a message, and what the marks of the text written could not do
  };
  let token = 0, runs = 0;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  // ---------- engines ----------

  function ensurePool(m) {
    const sha = m.entry.manifest.sha256;
    if (P.pool && P.poolSha === sha) return P.pool;
    if (P.pool) P.pool.terminate();
    P.pool = createEnginePool(m.entry.manifest, m.entry.buffer, poolSize());
    P.poolSha = sha;
    return P.pool;
  }

  /** A newer model: the engines go; written pages stay as they are. */
  function modelChanged() {
    if (P.phase === 'writing' || P.rewriting.size) return;
    if (P.pool) { P.pool.terminate(); P.pool = null; P.poolSha = null; }
  }

  const busy = () => P.phase === 'writing' || P.rewriting.size > 0;

  // A piece the layout flags (a word off the line or far too tall, document.js:
  // preparePiece) gets one more attempt, with a seed derived from its own, and the
  // one with fewer flags is kept.  About 1.5 % of pieces (3 of ~200 test pieces).
  const RETRY_SALT = 0x2545F491;
  async function writeChecked(pool, r, i, seed, first) {
    const job = { text: r.plan.pieces[i].text, bias: r.bias };
    const w = preparePiece(await pool.writePiece({ ...job, first, seed }), r.info.xhModel);
    if (!w.flags.length) return w;
    r.retried = (r.retried || 0) + 1;
    try {
      const again = preparePiece(await pool.writePiece({ ...job, first: true, seed: (seed ^ RETRY_SALT) >>> 0 }), r.info.xhModel);
      return again.flags.length < w.flags.length ? again : w;
    } catch (_) { return w; }          // cancelled or failed: the first attempt stands
  }

  // ---------- layout ----------

  const docSettings = () => ({
    paper: P.settings.paper, size: P.settings.size, textLayer: P.settings.textLayer,
    bias: P.run ? P.run.bias : bias(), seed: P.run ? P.run.seed : 1,
  });

  const layouts = () => P.lay || (P.lay = createLayouts());

  /** Nothing written yet: the empty pages of a plan (or one page), laid out here. */
  function emptyLayout(plan = { paragraphs: [], pieces: [] }) {
    P.doc = layoutDocument(plan, [], docSettings());
    P.order = []; P.settled = 0; P.G = null;
    P.done.clear();
  }

  /** The pieces written so far laid out again with the current paper and size: in the
   *  layout worker (pen.js), one request at a time; asked for again meanwhile, it runs once
   *  more afterwards with what has come in. */
  function relayout() {
    P.stale = false;
    const r = P.run;
    if (!r) { emptyLayout(); flushWaiters(); return; }
    if (P.laying) { P.again = true; return; }
    P.laying = true;
    layouts().layout(r.id, docSettings()).then((res) => {
      P.laying = false;
      if (res && r === P.run) applyLayout(r, res);
      if (P.again) { P.again = false; relayout(); } else flushWaiters();
    });
  }
  const flushWaiters = () => { if (!P.laying && !P.stale) for (const f of P.waiters.splice(0)) f(); };
  /** Resolves once the document shown holds every piece written so far. */
  const laidOut = () => new Promise((res) => { P.waiters.push(res); if (P.stale && !P.laying) relayout(); else flushWaiters(); });

  function applyLayout(r, res) {
    // an update shows the document before it until its own letter size is fixed
    if (r.prev && P.view !== r && !res.fixed && P.phase === 'writing') return;
    if (P.view !== r) {
      if (P.view) P.view.shown = { doc: P.doc, order: P.order, settled: P.settled };   // to go back to if the update is cancelled
      P.view = r; P.pick = null;
    }
    P.doc = res.doc; P.order = res.order; P.settled = res.settled; P.G = null;
    for (const i of r.redoNext) {
      // a rewritten piece the pen has passed is written by the pen again; one still ahead
      // of it is written in its turn
      const f = r.pen.frontier;
      if (!f || i < f.q) r.pen.redo.set(i, new Set());
      else if (i === f.q) r.pen.frontier = { q: i, k: 0 };
    }
    r.redoNext.clear();
    P.done.clear();
    sync();
    schedule();
  }

  // ---------- drawing ----------

  const dpr = () => window.devicePixelRatio || 1;
  // the column's width, kept from the ResizeObserver: read every frame of the pen, clientWidth
  // would lay the page out each time
  let cssW = 0;
  const cssWidth = () => cssW || (cssW = el.pages.clientWidth);
  const cssPerMm = () => cssWidth() / PAGE.width;
  const lookKey = (l) => [l.pen, l.width, l.scheme, l.ink].join('|');
  /**
   * What a page shows, entry by entry: its highlighter bands, then its strokes (the words'
   * and what is drawn around them), each with a key that is the same for the same ink at the
   * same place in the same style, and a box in device px that holds its ink.  A plain text
   * only ever adds strokes at a page's end; a document also replaces some while it is
   * written (a frame that grows with its box, an underline whose run gets longer, a line in
   * parts that appears at once) and a rewritten piece moves its neighbours and their
   * decorations, so the canvas is compared by keys, not by position.
   */
  function pageItems(page, o) {
    const items = [];
    if (!page) return items;
    const s = o.pw / PAGE.width;
    const pad = 2 * o.look.width * o.doc.geometry.xh * BOLD[o.look.pen] * s + 4;     // the widest pen around the points
    const rect = (x0, y0, x1, y1, d) => [Math.max(0, Math.floor(x0 * s - d)), Math.max(0, Math.floor(y0 * s - d)), Math.min(o.pw, Math.ceil(x1 * s + d)), Math.min(o.ph, Math.ceil(y1 * s + d))];
    const extent = (p, step, d) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < p.length; i += step) { if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i]; if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1]; }
      return rect(x0, y0, x1, y1, d);
    };
    // the exact first, middle and last points: a stroke that moves or changes changes them
    const sig = (p, step) => { const n = p.length, m = step * Math.floor(n / (2 * step)); return `${n}:${p[0]},${p[1]},${p[m]},${p[m + 1]},${p[n - step]},${p[n - step + 1]}`; };
    for (const b of page.bands || []) items.push({ band: b, key: `b${b.color}:${sig(b.points, 2)}`, box: extent(b.points, 2, 2) });
    // the box from the points themselves: a word's laid-out box can be narrower than its ink,
    // and a stroke drawn anew only inside a too small box leaves a seam of old ink around it
    page.strokes.forEach((q, i) => {
      if (!q.length) return;
      const st = page.styles ? page.styles[i] : null;
      items.push({ i, key: `${st ? `${st.color || ''}${st.bold ? '+' : ''}` : ''}:${sig(q, 3)}`, box: extent(q, 3, pad) });
    });
    return items;
  }
  // A page's items for one look and width, kept with the page object: the layout worker hands
  // a page that came out as before back as the same object, and the pen asks every frame.
  const itemCache = new WeakMap();
  function itemsOf(page, o) {
    const tag = `${o.pw}|${o.look.pen}|${o.look.width}`;
    let c = page ? itemCache.get(page) : null;
    if (c && c.tag === tag) return c;
    const list = pageItems(page, o), stroke = new Int32Array(page ? page.strokes.length : 0).fill(-1), band = [];
    list.forEach((it, k) => { if (it.band) band.push(k); else stroke[it.i] = k; });
    c = { tag, list, stroke, band };
    if (page) itemCache.set(page, c);
    return c;
  }

  const meets =(a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  /** Overlapping boxes joined until none overlap (each is drawn anew once). */
  function disjoint(boxes) {
    const out = boxes.filter((b) => b[2] > b[0] && b[3] > b[1]).map((b) => b.slice());
    for (let joined = true; joined;) {
      joined = false;
      for (let a = 0; a < out.length; a++) {
        for (let b = a + 1; b < out.length; b++) {
          if (!meets(out[a], out[b])) continue;
          const x = out[a], y = out[b];
          out[a] = [Math.min(x[0], y[0]), Math.min(x[1], y[1]), Math.max(x[2], y[2]), Math.max(x[3], y[3])];
          out.splice(b, 1); b = a; joined = true;
        }
      }
    }
    return out;
  }

  // Pages near the viewport (one screen height around it) are drawn; P.done holds the pages
  // whose canvas shows the current document and look, so scrolling past drawn pages runs no
  // drawing at all.
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
    let need = false;
    for (const e of entries) {
      const i = P.frames.findIndex((f) => f.wrap === e.target);
      if (i < 0) continue;
      if (e.isIntersecting) { P.near.add(i); P.frames[i].seen = ++P.seen; if (!P.done.has(i)) need = true; } else P.near.delete(i);
    }
    if (need) schedule();
  }, { root: el.stage, rootMargin: '100% 0px' }) : null;

  function frames(n) {
    while (P.frames.length < n) {
      const wrap = document.createElement('div');
      wrap.className = 'pg-page';
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      wrap.append(canvas);
      el.pages.insertBefore(wrap, el.pick);
      const f = { wrap, canvas, id: `page${P.frames.length}`, key: '', drawn: new Map(), seen: 0 };
      painter.attach(f.id, canvas);
      P.frames.push(f);
      if (io) io.observe(wrap); else P.near.add(P.frames.length - 1);
    }
    while (P.frames.length > n) {
      const f = P.frames.pop();
      painter.run([{ op: 'free', id: f.id }]);
      if (io) io.unobserve(f.wrap);
      f.wrap.remove();
      P.near.delete(P.frames.length); P.done.delete(P.frames.length);
      if (P.held && P.held.page >= P.frames.length) P.held = null;
    }
    P.frames.forEach((f, i) => { const t = `Seite ${i + 1} von ${n}`; if (f.label !== t) { f.label = t; f.wrap.setAttribute('aria-label', t); } });
    if (el.empty.parentNode !== P.frames[0].wrap) P.frames[0].wrap.append(el.empty);   // the hint sits in the first page's top margin
  }

  function schedule() {
    if (P.raf || !P.visible) return;
    P.raf = requestAnimationFrame((t) => { P.raf = 0; paint(t); });
  }

  // ---------- the pen ----------
  //
  // With "Schreiben zeigen" the pages show only what the pen has written: the entries of
  // pen.js penOrder (strokes and bands) in reading order, up to the pen's frontier, a place in
  // that order given as the piece an entry belongs to and how many of that piece's entries
  // came before it (so it stays put when a rewrite or a new paper moves things around).  The
  // entry at the frontier is drawn as far as the pen has got (the quick sheet's hold / unhold:
  // the box under it is kept and put back every frame), and nothing is drawn while its pieces
  // can still move (`settled`).  Pieces kept by an update are there at once; a piece written
  // again after the pen went past it is written by the pen once more (`redo`).

  const penOf = () => (P.view ? P.view.pen : null);
  const engaged = (pen) => !!pen && (!!pen.frontier || pen.redo.size > 0);
  const penState = (on, kept = null) => ({ frontier: on ? { q: 0, k: 0 } : null, kept, redo: new Map(), used: on, cur: null, last: 0, end: null, v: 0, log: [] });
  const animateOn = () => (P.settings.animate === null ? !reduced.matches : !!P.settings.animate);

  /** The entries of the document in reading order, with what the pen needs of each. */
  function buildG(o) {
    const N = o.doc.total, rank = new Int32Array(N + 1), G = [];
    o.doc.pages.forEach((page, p) => {
      const ord = P.order[p], c = itemsOf(page, o);
      if (!ord) return;
      for (let j = 0; j < ord.length; j += 4) {
        const i = ord[j], k = i < 0 ? c.band[-1 - i] : c.stroke[i];
        if (k === undefined || k < 0) continue;
        const owner = ord[j + 2];
        G.push({ p, i, k, key: `${p}/${c.list[k].key}`, need: ord[j + 1], owner, pts: ord[j + 3], rank: rank[owner < 0 ? N : owner]++ });
      }
    });
    return G;
  }

  const before = (pen, e) => !pen.frontier || e.owner < pen.frontier.q || (e.owner === pen.frontier.q && e.rank < pen.frontier.k);
  function shownBy(pen, e) {
    if (pen.frontier && e.need > P.settled) return false;
    const rd = pen.redo.get(e.owner);
    if (rd) return rd.has(e.key);
    return (pen.kept && pen.kept[e.owner] === 1) || before(pen, e);
  }
  /** The entry the pen writes next: a rewritten piece first, then the one at the frontier;
   *  null where the next one's pieces are not settled (the pen rests) or nothing is left. */
  function nextEntry(pen) {
    if (pen.redo.size) for (const e of P.G) { const rd = pen.redo.get(e.owner); if (rd && !rd.has(e.key) && (!pen.frontier || e.need <= P.settled)) return e; }
    if (!pen.frontier) return null;
    for (const e of P.G) {
      if (before(pen, e) || pen.redo.has(e.owner) || (pen.kept && pen.kept[e.owner] === 1)) continue;
      return e.need <= P.settled ? e : null;
    }
    return null;
  }
  function pass(pen, e, now) {
    const rd = pen.redo.get(e.owner);
    if (rd) rd.add(e.key); else pen.frontier = { q: e.owner, k: e.rank + 1 };
    if (pen.log.length < LOG_MAX) pen.log.push([e.p, e.i, e.owner, Math.round(now), e.key]);
  }

  /** Moves the pen on by the time since the last frame; returns { e, pos } for the entry on
   *  its way (pos: points written of it), or null. */
  function penTick(pen, now) {
    const dt = pen.last && !P.paused ? Math.min(0.1, Math.max(0, (now - pen.last) / 1000)) : 0;
    pen.last = now;
    // what is written but not yet on the page, in points
    let waiting = 0;
    for (const e of P.G) if (!shownBy(pen, e) && (pen.redo.has(e.owner) || (!pen.frontier || e.need <= P.settled))) waiting += e.pts;
    if (pen.cur) waiting -= pen.cur.pos;
    const finishing = P.phase !== 'writing' && !P.rewriting.size;
    if (!finishing) pen.end = null; else if (pen.end === null) pen.end = now + 1000 * FINISH_S;
    // the pen gathers speed over about a second (after the first pieces, many wait at once),
    // and slows down at once; at the end it writes what the deadline asks
    const want = finishing ? waiting / Math.max(dt, (pen.end - now) / 1000) : waiting / CATCHUP_S;
    pen.v = want > pen.v ? pen.v + (want - pen.v) * Math.min(1, dt / SPEEDUP_S) : want;
    const v = Math.max(PEN_PPS, pen.v, finishing ? want : 0);
    let adv = v * dt;
    for (let e = nextEntry(pen); e && adv > 0; e = nextEntry(pen)) {
      if (!pen.cur || pen.cur.key !== e.key) pen.cur = { key: e.key, pos: 0 };
      const left = e.pts - pen.cur.pos;
      if (adv < left) { pen.cur.pos += adv; break; }
      adv -= left; pen.cur = null;
      pass(pen, e, now);
    }
    for (const [piece, rd] of pen.redo) if (!P.rewriting.has(piece) && !P.G.some((e) => e.owner === piece && !rd.has(e.key))) pen.redo.delete(piece);
    const e = nextEntry(pen);
    if (!e) {
      pen.cur = null;
      // nothing more will come: the pen is done, everything laid out is shown
      if (pen.frontier && finishing && !P.laying && !P.stale && !P.run.redoNext.size) { pen.frontier = null; P.finished = true; }
      return null;
    }
    if (!pen.cur || pen.cur.key !== e.key) pen.cur = { key: e.key, pos: 0 };
    return pen.cur.pos >= 1 ? { e, pos: pen.cur.pos } : null;
  }

  /** The pen stops for this run: what is written is shown at once. */
  function penFinish() {
    const pen = penOf();
    if (!engaged(pen)) return;
    pen.frontier = null; pen.redo.clear(); pen.cur = null;
    P.done.clear();
    sync();
    schedule();
  }

  /** How the pages are drawn now: device px width, look, colours, and the key of all that. */
  function drawing(doc) {
    const w = cssWidth();
    if (!w) return null;
    const l = look();
    const ratio = Math.min(dpr(), Math.sqrt(MAX_PIXELS / (w * w * (PAGE.height / PAGE.width))));
    const pw = Math.round(w * ratio);
    return { doc, pw, ph: Math.round(pw * PAGE.height / PAGE.width), look: l, colors: lookColors(l), key: [pw, lookKey(l), doc.settings.paper, doc.settings.size].join('#') };
  }

  function paint(now = performance.now()) {
    if (!P.visible || !P.active) return;
    if (!P.doc) emptyLayout();
    if (P.stale) relayout();
    const doc = P.doc;
    const n = Math.max(1, doc.pages.length);
    frames(n);
    const o = drawing(doc);
    if (!o) return;
    const l = o.look;
    // the pen: what each page shows (null: all of it), and the entry on its way
    const pen = penOf();
    let cur = null, shown = null;
    if (engaged(pen)) {
      const tag = `${o.pw}|${l.pen}|${l.width}`;
      if (!P.G || P.Gtag !== tag) { P.G = buildG(o); P.Gtag = tag; }
      cur = penTick(pen, now);
    }
    if (engaged(pen)) {
      shown = doc.pages.map((page) => new Uint8Array(itemsOf(page, o).list.length));
      for (const e of P.G) if (shownBy(pen, e)) shown[e.p][e.k] = 1;
      shown.forEach((s, i) => { const was = P.shown[i]; if (!was || was.length !== s.length || was.some((v, k) => v !== s[k])) P.done.delete(i); });
    } else if (P.shown.length) P.done.clear();
    P.shown = shown || [];
    if (P.finished) { P.finished = false; finished(); }
    // a page the pen left with strokes drawn out of their order is drawn once more whole, so
    // that it is exactly the page drawn without the pen (once the pen is done: a whole
    // Bleistift page holds the paint worker for 130 ms, a stall in the writing)
    // (a kept page away from the view too: scrolling to it should draw nothing)
    const far = [];
    if (!engaged(pen) && pen && pen.used && P.phase !== 'writing' && !P.rewriting.size) {
      P.frames.forEach((f, i) => { if (i < n && f.key === o.key && !f.canon) { f.key = ''; P.done.delete(i); if (!P.near.has(i)) far.push(i); } });
    }
    // the pages on the screen first, then the ones about to come into view
    const mid = el.stage.scrollTop + el.stage.clientHeight / 2;
    const away = (i) => { const f = P.frames[i].wrap; return Math.max(0, f.offsetTop - mid, mid - f.offsetTop - f.offsetHeight); };
    const todo = [...P.near].filter((k) => k < n && !P.done.has(k)).sort((a, b) => away(a) - away(b)).concat(far);
    const steps = [];
    // the box under the stroke on its way goes back before anything else is drawn on its page
    const h = P.held;
    const keepHold = h && cur && h.key === cur.e.key && !todo.includes(h.page) && P.frames[h.page] && P.frames[h.page].key === o.key;
    if (h && !keepHold) { if (P.frames[h.page]) steps.push({ op: 'unhold', id: P.frames[h.page].id, keep: false }); P.held = null; }
    for (const i of todo) steps.push(...drawPage(i, o, shown ? shown[i] : null));
    if (cur && P.done.has(cur.e.p) && P.frames[cur.e.p].key === o.key) steps.push(...penSteps(cur, o, keepHold));
    P.cur = cur;
    painter.run(steps);
    keep();
    el.empty.hidden = !!(P.run && doc.placed) || P.phase === 'writing';
    placeMarks();
    placePick();
    if (!cur || !P.followed || P.followed !== cur.e.key) { P.followed = cur && cur.e.key; follow(cur, o); }
    if (engaged(pen) && (cur || nextEntry(pen) || (P.phase !== 'writing' && !P.rewriting.size))) schedule();
  }

  /** The stroke on its way: the box under it kept (or put back, keep), then the stroke as far
   *  as the pen has got; a highlighter band as far along its words. */
  function penSteps({ e, pos }, o, keep) {
    const f = P.frames[e.p], page = o.doc.pages[e.p], it = itemsOf(page, o).list[e.k], b = it.box, scale = o.pw / PAGE.width;
    const steps = [];
    if (keep) steps.push({ op: 'unhold', id: f.id, keep: true });
    else { steps.push({ op: 'hold', id: f.id, x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] }); P.held = { page: e.p, key: e.key }; }
    if (it.band) steps.push({ op: 'sweep', id: f.id, band: it.band, x: (b[0] + (b[2] - b[0]) * Math.min(1, pos / e.pts)) / scale, scale, colors: o.colors });
    else steps.push({ op: 'partial', id: f.id, word: page.strokes[e.i], n: Math.floor(pos), scale, look: o.look, colors: o.colors, xh: o.doc.geometry.xh, style: page.styles ? page.styles[e.i] : null });
    return steps;
  }

  /** The pen is done with the run: everything stays as it is, the following ends. */
  function finished() {
    if (P.phase !== 'writing') unfollow();
    sync();
  }

  /** Bring page i up to date: its new strokes only; where something went or a band came
   *  (ink cannot be taken off a canvas, and a band lies under the ink) that region is drawn
   *  anew, clipped to it, and the new strokes around it; the whole page only for other paper,
   *  pen or size, or when the region is most of the page.  The steps of one page are drawn
   *  together, so the page never shows half a redraw.  vis: the items the pen has written
   *  (null: all).  Returns the steps. */
  function drawPage(i, o, vis = null) {
    const f = P.frames[i];
    const page = o.doc.pages[i];
    const all = itemsOf(page, o).list, items = vis ? all.filter((_, k) => vis[k]) : all;
    const scale = o.pw / PAGE.width, paper = { page: o.doc.page, geometry: o.doc.geometry };
    const pen = { xh: o.doc.geometry.xh, scale, look: o.look, colors: o.colors };
    const ink = (list) => ({ words: list.map((it) => page.strokes[it.i]), ...(page && page.styles ? { styles: list.map((it) => page.styles[it.i]) } : {}) });
    const strokes = (list) => list.filter((it) => !it.band);
    let fresh = f.key !== o.key, added = items, dirty = [];
    if (!fresh) {
      const left = new Map();
      for (const [k, d] of f.drawn) left.set(k, d.n);
      added = [];
      for (const it of items) { const n = left.get(it.key); if (n) left.set(it.key, n - 1); else added.push(it); }
      const gone = [];
      for (const [k, n] of left) if (n) gone.push(f.drawn.get(k).box);
      dirty = disjoint([...gone, ...added.filter((it) => it.band).map((it) => it.box)]);
      // A region grows until it holds all of every stroke and band it meets: a stroke cut
      // by a region's edge is rasterised differently there than when drawn whole (one
      // pixel of a tap-rewrite differed like ink from paper on a 1326 px wide page).
      for (let grew = true; grew;) {
        grew = false;
        for (const d of dirty) {
          for (const { box: q } of items) {
            if (!meets(d, q) || (q[0] >= d[0] && q[1] >= d[1] && q[2] <= d[2] && q[3] <= d[3])) continue;
            d[0] = Math.min(d[0], q[0]); d[1] = Math.min(d[1], q[1]); d[2] = Math.max(d[2], q[2]); d[3] = Math.max(d[3], q[3]);
            grew = true;
          }
        }
        if (grew) dirty = disjoint(dirty);
      }
      if (dirty.reduce((a, b) => a + (b[2] - b[0]) * (b[3] - b[1]), 0) > REGION_MAX * o.pw * o.ph) fresh = true;
      // a plain text redraws its whole page whenever something went, as it always did:
      // a clipped region would change the edge pixels of the ink it cuts
      if (!o.doc.rich && dirty.length) fresh = true;
    }
    const steps = [];
    // canon: the canvas is the page drawn whole (bands, then the strokes in their order)
    if (fresh) {
      steps.push({ op: 'size', id: f.id, w: o.pw, h: o.ph }, { op: 'page', id: f.id, doc: paper, scale, look: o.look, colors: o.colors });
      if (page && page.bands && page.bands.length) { const bands = items.filter((it) => it.band).map((it) => it.band); if (bands.length) steps.push({ op: 'bands', id: f.id, bands, scale, colors: o.colors }); }
      if (page && page.strokes.length) steps.push({ op: 'words', id: f.id, ...ink(strokes(items)), ...pen });
      f.key = o.key;
      f.canon = true; f.top = -1;
    } else {
      // the new strokes first, then every region drawn anew with all it holds, new strokes too
      const more = strokes(added);
      if (more.length) steps.push({ op: 'words', id: f.id, ...ink(more), ...pen });
      for (const d of dirty) {
        const inside = items.filter((it) => meets(d, it.box));
        steps.push({ op: 'region', id: f.id, rect: [d[0], d[1], d[2] - d[0], d[3] - d[1]], doc: paper, bands: inside.filter((it) => it.band).map((it) => it.band), ...ink(strokes(inside)), ...pen });
      }
      if (dirty.length || more.some((it) => it.i < f.top)) f.canon = false;
    }
    for (const it of strokes(added)) f.top = Math.max(f.top, it.i);
    f.drawn = new Map();
    for (const it of items) { const d = f.drawn.get(it.key); if (d) d.n++; else f.drawn.set(it.key, { n: 1, box: it.box }); }
    P.done.add(i);
    return steps;
  }

  /** Pages that scrolled away keep their canvas, KEEP_PAGES in all, the ones seen last
   *  first; the others give their memory back. */
  function keep() {
    const kept = P.frames.map((f, i) => ({ f, i })).filter(({ f }) => f.key);
    if (kept.length <= KEEP_PAGES) return;
    kept.sort((a, b) => (P.near.has(b.i) - P.near.has(a.i)) || b.f.seen - a.f.seen);
    for (const { f, i } of kept.slice(KEEP_PAGES)) {
      if (P.near.has(i)) continue;
      painter.run([{ op: 'free', id: f.id }]);
      f.key = ''; f.drawn = new Map();
      P.done.delete(i);
      if (P.held && P.held.page === i) P.held = null;
    }
  }

  // The piece picked for rewriting is marked by boxes laid over the page, blended so that
  // the ink stays on top: picking a word redraws nothing.
  let marksKey = '';
  function placeMarks() {
    const boxes = P.pick && P.doc ? pieceBoxes(P.doc, P.pick.piece) : [];
    const key = JSON.stringify(boxes);
    if (key === marksKey) return;
    marksKey = key;
    for (const m of el.pages.querySelectorAll('.pg-mark')) m.remove();
    const pad = P.doc ? 0.12 * P.doc.geometry.pitch : 0;
    for (const { page, box: [x0, y0, x1, y1] } of boxes) {
      const f = P.frames[page];
      if (!f) continue;
      const m = document.createElement('div');
      m.className = 'pg-mark';
      m.style.cssText = `left:${(100 * (x0 - pad)) / PAGE.width}%;top:${(100 * (y0 - pad)) / PAGE.height}%;width:${(100 * (x1 - x0 + 2 * pad)) / PAGE.width}%;height:${(100 * (y1 - y0 + 2 * pad)) / PAGE.height}%`;
      f.wrap.append(m);
    }
  }

  /** Redraw everything (look, width or theme changed). */
  function redraw() { P.done.clear(); schedule(); }

  // The writer scrolling by hand ends the following; listened for only while it is on, so
  // that scrolling finished pages runs no script at all.
  function unfollow() { P.follow = false; for (const t of ['wheel', 'touchmove']) el.stage.removeEventListener(t, unfollow); }
  function followOn() { P.follow = true; for (const t of ['wheel', 'touchmove']) el.stage.addEventListener(t, unfollow, { passive: true }); }

  /** Keep the line being written in view while writing (with the pen: the pen's line, also
   *  when it is above the view, as after an update), until the writer scrolls. */
  function follow(cur, o) {
    if (!P.follow || !P.doc || !P.doc.pages.length) return;
    let pi, mm;
    if (cur) { pi = cur.e.p; mm = itemsOf(P.doc.pages[pi], o).list[cur.e.k].box[3] / (o.pw / PAGE.width); }
    else if (P.phase === 'writing' && !engaged(penOf())) {
      pi = P.doc.pages.length - 1;
      const page = P.doc.pages[pi], last = page.words[page.words.length - 1];
      if (!last) return;
      mm = last.baseline;
    } else return;
    const f = P.frames[pi];
    if (!f) return;
    const y = f.wrap.offsetTop + mm * cssPerMm();
    const room = 3 * P.doc.geometry.pitch * cssPerMm();
    const top = el.stage.scrollTop, bottom = top + el.stage.clientHeight;
    const behavior = reduced.matches ? 'auto' : 'smooth';
    if (y + room > bottom) el.stage.scrollTo({ top: y + room - el.stage.clientHeight, behavior });
    else if (cur && y - room < top) el.stage.scrollTo({ top: Math.max(0, y - room), behavior });
  }

  // ---------- tap to rewrite ----------

  /** The "Neu schreiben" bar sits next to the marked piece, under or over it, where
   *  it hides the least of the other words (the margins are often free). */
  function placePick() {
    const pick = P.pick && P.doc ? pieceBoxes(P.doc, P.pick.piece) : [];
    if (!pick.length) { el.pick.hidden = true; return; }
    const b = pick[pick.length - 1];
    const f = P.frames[b.page];
    if (!f) { el.pick.hidden = true; return; }
    const k = cssPerMm();
    el.pick.hidden = false;
    const writing = P.rewriting.has(P.pick.piece);
    el.redo.disabled = writing;
    el.redo.querySelector('span').textContent = writing ? 'schreibt …' : 'Neu schreiben';
    el.redo.classList.toggle('writing', writing);
    const bw = el.pick.offsetWidth / k, bh = el.pick.offsetHeight / k;     // mm
    const pad = 0.12 * P.doc.geometry.pitch, gap = 1.5;
    const others = P.doc.pages[b.page].words.filter((w) => w.piece !== P.pick.piece).map((w) => w.box);
    const clampX = (x) => Math.max(1, Math.min(PAGE.width - bw - 1, x));
    const xs = [clampX((b.box[0] + b.box[2]) / 2 - bw / 2), clampX(b.box[0]), clampX(b.box[2] - bw), 1, PAGE.width - bw - 1];
    const ys = [b.box[3] + pad + gap, b.box[1] - pad - gap - bh].filter((y) => y >= 1 && y + bh <= PAGE.height - 1);
    let best = null;
    for (const y of ys.length ? ys : [b.box[3] + pad + gap]) {
      for (const x of xs) {
        let hidden = 0;
        for (const o of others) hidden += Math.max(0, Math.min(x + bw, o[2]) - Math.max(x, o[0])) * Math.max(0, Math.min(y + bh, o[3]) - Math.max(y, o[1]));
        const away = Math.abs(x + bw / 2 - (b.box[0] + b.box[2]) / 2) / PAGE.width;     // nearer the piece wins a tie
        if (!best || hidden + away < best.score) best = { x, y, score: hidden + away };
      }
    }
    el.pick.style.transform = `translate(${Math.round(best.x * k)}px, ${Math.round(f.wrap.offsetTop + best.y * k)}px)`;
  }

  function choose(piece) {
    P.pick = piece === null || (P.pick && P.pick.piece === piece) ? null : { piece };
    schedule();
  }

  function onTap(e, f) {
    if (!P.doc || !P.run || P.view !== P.run) return;
    const i = P.frames.indexOf(f);
    const r = f.wrap.getBoundingClientRect();
    const k = r.width / PAGE.width;
    const hit = wordAt(P.doc, i, (e.clientX - r.left) / k, (e.clientY - r.top) / k, REACH[e.pointerType] || REACH.mouse);
    choose(hit ? hit.piece : null);
  }

  async function rewrite() {
    const r = P.run;
    if (!P.pick || !r) return;
    const i = P.pick.piece;
    if (P.rewriting.has(i)) return;
    const m = model();
    if (!m) return;
    // A piece of another model would not match its neighbours (size, xh unit).
    if (m.entry.manifest.sha256 !== r.sha) { note('Inzwischen ist ein anderes Modell geladen. Bitte schreib den Text neu.'); return; }
    const pool = ensurePool(m);
    const ver = (r.version[i] || 0) + 1;
    r.version[i] = ver;
    P.rewriting.add(i);
    sync();
    try {
      const w = await writeChecked(pool, r, i, pieceSeed(r.seed, i, ver), true);
      if (r === P.run && r.version[i] === ver) {
        r.written[i] = w; r.done = r.written.filter(Boolean).length;
        layouts().piece(r.id, i, w);
        if (animateOn()) r.redoNext.add(i);       // the pen writes the new ink, once it is laid out
        relayout();
      }
    } catch (e) {
      if (!e || !e.cancelled) { console.error(e); note('Das Neuschreiben hat nicht geklappt. Bitte versuch es noch einmal.'); }
      if (r.version[i] === ver) r.version[i] = ver - 1;
    }
    P.rewriting.delete(i);
    sync();
    schedule();
    idleCheck();
  }

  // ---------- writing ----------

  // The note line holds a message (an error, "Abgebrochen", a cut paste) and after it what
  // the marks of the text written could not do; either goes without the other.
  // A note is one short sentence; the format it names already stands beside the button.
  const sentence = (s) => { const t = s.replace(/^(Markdown|LaTeX): /, ''); return t.charAt(0).toUpperCase() + t.slice(1) + (/[.…]$/.test(t) ? '' : '.'); };
  const showNote = () => {
    const text = [P.message, ...P.notes].filter(Boolean).map(sentence).join(' ');
    el.note.textContent = text; el.note.hidden = !text;
  };
  const note = (text) => { P.message = text || ''; showNote(); };
  const charsNote = (list) => {
    const set = [...new Set(list)];
    el.chars.textContent = set.length ? `Diese Zeichen kann ich nicht schreiben und lasse sie weg: ${set.slice(0, 8).map((c) => `„${c}“`).join(', ')}${set.length > 8 ? ' …' : ''}` : '';
    el.chars.hidden = !set.length;
  };

  /** What a typed text is written as: the text itself when it has no marks (exactly as
   *  before there were marks) or the choice is 'text', else the document of its marks.
   *  today: what {datum} and \today write. */
  function source(typed, today = new Date()) {
    // The line breaks of a narrower source column come out first (unwrap.js).  Not in a
    // LaTeX text: there a line break is a space already, and a comment ends at one.
    const latex = P.settings.format === 'latex' || (P.settings.format === 'auto' && detectFormat(typed) === 'latex');
    const { text, joined } = P.settings.unwrap && !latex ? unwrapLines(typed) : { text: typed, joined: 0 };
    const flowed = joined ? ['Kopierte Zeilenumbrüche zusammengeführt'] : [];
    if (P.settings.format === 'text') return { text, format: 'text', notes: flowed };
    const doc = parseMarkup(text, P.settings.format, { today });
    const notes = [...flowed, ...doc.notes];
    return plainDoc(doc, text) ? { text, format: 'text', notes } : { text, doc, format: doc.format, notes };
  }

  // a run from the click to its last piece; a second click meanwhile does nothing
  let running = false;
  async function write() {
    if (running) return;
    running = true;
    try { await run(); } finally { running = false; }
  }

  async function run() {
    const m = model();
    if (!m || P.phase === 'writing') return;
    const fresh = (Math.random() * 2 ** 32) >>> 0;      // the seed of a new document, drawn at the click
    const text = textNow();
    const src = source(text);
    P.notes = src.notes;
    note('');
    // only what is written is checked, not the marks around it
    charsNote(m.normalizer.unsupported(src.doc ? docText(src.doc) : src.text));
    await new Promise((res) => setTimeout(res));      // the parse and the plan in tasks of their own
    const plan = planDocument(src.doc || src.text, m.normalizer.normalize);
    if (!plan.pieces.length) {
      note(text.trim() ? 'In diesem Text steht nichts, was ich schreiben kann.' : 'Bitte tippe oder füge zuerst einen Text ein.');
      if (!text.trim()) el.text.focus();
      return;
    }
    const mine = ++token;
    const pool = ensurePool(m);
    if (matchMedia('(pointer: coarse)').matches) el.text.blur();      // the keyboard away: the pages are the thing to watch
    P.pick = null;
    P.rewriting.clear();
    // An update ("Aktualisieren": the text changed since the document shown) keeps the ink of
    // every piece the new plan holds as before: the same text, the n-th of its equal texts,
    // written by the same model with the same Lesbarkeit.  Only the others are written.
    const prev = P.run, sha = m.entry.manifest.sha256;
    const map = plan.pieces.map(() => -1);
    if (updating() && prev.sha === sha && prev.bias === bias()) {
      const old = new Map(), seen = new Map();
      prev.plan.pieces.forEach((p, j) => { if (!old.has(p.text)) old.set(p.text, []); old.get(p.text).push(j); });
      plan.pieces.forEach((p, i) => {
        const n = seen.get(p.text) || 0, j = (old.get(p.text) || [])[n];
        seen.set(p.text, n + 1);
        if (j !== undefined && prev.written[j]) map[i] = j;
      });
    }
    const kept = map.filter((j) => j >= 0).length;
    const on = animateOn();
    P.run = {
      id: ++runs, token: mine, sha, text, format: P.settings.format, doc: src.doc || null,
      seed: kept ? prev.seed : fresh, bias: bias(), plan,
      written: map.map((j) => (j >= 0 ? prev.written[j] : undefined)), version: map.map((j) => (j >= 0 ? prev.version[j] || 0 : 0)), info: m.info,
      sizeByBias: m.entry.manifest.size_by_bias || null, start: performance.now(), done: kept, cancelled: false, workers: pool.size,
      kept, asked: 0, prev: kept ? prev : null, redoNext: new Set(),
      pen: penState(on, kept ? Uint8Array.from(map, (j) => (j >= 0 ? 1 : 0)) : null),
    };
    const r = P.run;
    P.phase = 'writing'; followOn();
    sync();
    // the rest in a task of its own: the parse and the plan of a five-page document take
    // 24 and 21 ms the first time (CPU slowed 4x), and with what follows they held the page
    // for 71-86 ms in one task
    await new Promise((res) => setTimeout(res));
    if (!kept) {
      // a new document: its empty pages at once, the pen at the top
      P.view = r;
      emptyLayout(plan);
      el.stage.scrollTop = 0;
    }
    schedule();
    layouts().start(r.id, plan, { gapXh: m.info.gapXh, sizeByBias: r.sizeByBias }, kept ? { from: prev.id, map } : {});
    if (prev && !kept) layouts().drop(prev.id);
    relayout();
    const jobs = [];
    plan.pieces.forEach((p, i) => {
      if (map[i] >= 0 || r.cancelled) return;
      r.asked++;
      jobs.push(writeChecked(pool, r, i, pieceSeed(r.seed, i, 0), false).then((w) => {
        if (r !== P.run || r.version[i]) return;            // replaced meanwhile by a rewrite
        r.written[i] = w;
        r.done = r.written.filter(Boolean).length;
        layouts().piece(r.id, i, w);
        // laid out once per frame, not once per piece, and in the layout worker: a five-page
        // document takes 14-23 ms (Node) to lay out, and 3-4 engines often finish within the
        // same frame
        P.stale = true;
        sync();
        schedule();
      }));
    });
    const outcome = await Promise.allSettled(jobs);
    if (mine !== token) return;
    const failed = outcome.find((o) => o.status === 'rejected' && !(o.reason && o.reason.cancelled));
    if (r.prev && (failed || r.cancelled)) {
      // an update that did not finish: the document before it stays as it was
      if (failed) { console.error(failed.reason); pool.terminate(); if (P.pool === pool) { P.pool = null; P.poolSha = null; } }
      note(failed ? 'Beim Aktualisieren ist etwas schiefgegangen. Die Seiten bleiben, wie sie waren.' : 'Abgebrochen. Die Seiten bleiben, wie sie waren.');
      layouts().drop(r.id);
      P.run = r.prev;
      if (P.view !== r.prev) {
        P.view = r.prev; P.pick = null;
        if (r.prev.shown) { ({ doc: P.doc, order: P.order, settled: P.settled } = r.prev.shown); P.G = null; P.done.clear(); }
      }
      P.phase = 'idle';
      unfollow();
      P.stale = true;
      relayout();
      sync();
      schedule();
      idleCheck();
      return;
    }
    if (failed) {
      // A piece failed twice (the pool already retried it and replaced dead engines):
      // stop, and start the next run with fresh engines.
      console.error(failed.reason);
      pool.terminate();
      if (P.pool === pool) { P.pool = null; P.poolSha = null; }
      note('Beim Schreiben ist etwas schiefgegangen. Was bis dahin geschrieben ist, bleibt stehen.');
    } else if (r.cancelled) {
      const kept = P.doc && P.doc.placed ? ' Was schon geschrieben ist, bleibt stehen.' : '';
      note(`${r.dropped ? 'Abgebrochen, auch das Neuschreiben.' : 'Abgebrochen.'}${kept}`);
    }
    if (r.prev) { layouts().drop(r.prev.id); r.prev = null; }
    r.ms = performance.now() - r.start;
    P.phase = 'idle';
    if (!engaged(r.pen)) unfollow();         // with the pen, the view follows it to its end
    relayout();
    sync();
    schedule();
    save();
    idleCheck();
  }

  function cancel() {
    if (!busy()) return;
    if (P.run) { P.run.cancelled = true; if (P.rewriting.size) P.run.dropped = true; }
    if (P.pool) P.pool.cancel();
  }

  function idleCheck() { if (!busy() && deps.onIdle) deps.onIdle(); }

  // ---------- status ----------

  const textNow = () => String(el.text.value || '').replace(/\r\n?/g, '\n');
  /** A document is shown and its text has changed since: "Aktualisieren" writes what changed. */
  const updating = () => !!(P.run && P.view === P.run && P.doc && P.doc.placed > 0 && (textNow() !== P.run.text || P.settings.format !== P.run.format));

  function sync() {
    const writing = P.phase === 'writing';
    const r = P.run, doc = P.doc;
    el.write.hidden = writing; el.cancel.hidden = !writing;
    el.write.disabled = writing || !model();
    if (!writing) el.write.textContent = updating() ? 'Aktualisieren' : 'Schreiben';
    const pen = penOf();
    if (el.now) el.now.hidden = !(engaged(pen) && pen.frontier);
    const pages = doc ? doc.pages.length : 0;
    const canSave = !writing && pages > 0 && !!r && doc.placed > 0;
    el.pdf.disabled = !canSave; el.share.disabled = !canSave;
    el.busy.hidden = !writing;
    el.bar.hidden = !writing;
    let info = '';
    if (writing) {
      const total = r.plan.pieces.length;
      // [text, shown on a phone too]: the narrow form keeps to one line beside the tools
      const parts = [['schreibt … ', false], [`${r.done} von ${total}`, true]];
      if (pages > 1) parts.push([` · Seite ${pages}`, false]);
      // the rate is measured: only once every engine has finished a piece does it mean anything
      if (r.done >= Math.min(total, r.workers) && r.done < total) {
        const s = ((performance.now() - r.start) / r.done) * (total - r.done) / 1000;
        if (s < 50) parts.push([' · noch unter 1 Min.', true]);
        else parts.push([' · noch ', true], ['etwa ', false], [`${Math.max(1, Math.round(s / 60))} Min.`, true]);
      }
      el.busyText.replaceChildren(...parts.map(([t, short]) => { const e = document.createElement('span'); e.textContent = t; if (!short) e.className = 'pg-long'; return e; }));
      el.fill.style.width = `${(100 * r.done) / total}%`;
    } else if (r && doc && doc.placed) {
      info = `${pages === 1 ? '1 Seite' : `${pages} Seiten`} · Ein Wort antippen, um es neu schreiben zu lassen.`;
    }
    el.info.textContent = info;
    el.info.hidden = !info;
    if (deps.onStatus) deps.onStatus(writing || !!info);
    placePick();
  }

  // ---------- PDF ----------

  function title() {
    const r = P.run, d = r && r.doc;
    // a document: its first heading (the title of a header line, not its date), else its first line
    const head = d && d.blocks.find((b) => b.type === 'heading');
    const text = head ? head.lines[0].filter((sp) => !sp.body).map((sp) => sp.text).join('') : d ? plainText(d) : (r && r.text) || '';
    const line = text.split('\n').map((s) => s.trim()).find(Boolean) || 'Handschrift';
    const chars = [...line];                          // by characters: never half an emoji
    return chars.length > 60 ? `${chars.slice(0, 59).join('')}…` : line;
  }

  async function pdfFile() {
    await laidOut();             // the last piece may still be on its way back from the layout
    const date = new Date();
    const blob = await documentToPDF(P.doc, { look: look(), title: title(), date, textLayer: P.settings.textLayer });
    return { blob, name: pdfFileName(date) };
  }

  async function downloadPdf() {
    if (!P.doc || !P.doc.placed || P.phase === 'writing') return;
    try {
      const { blob, name } = await pdfFile();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch (e) { console.error(e); if (deps.toast) deps.toast('Das PDF konnte nicht erstellt werden.'); }
  }

  async function sharePdf() {
    if (!P.doc || !P.doc.placed || P.phase === 'writing') return;
    try {
      const { blob, name } = await pdfFile();
      await navigator.share({ files: [new File([blob], name, { type: 'application/pdf' })], title: title() });
    } catch (e) { if (e && e.name !== 'AbortError') { console.error(e); if (deps.toast) deps.toast('Teilen hat nicht geklappt. Herunterladen geht immer.'); } }
  }

  const canShareFiles = () => {
    try { return !!(navigator.canShare && navigator.share && navigator.canShare({ files: [new File(['%PDF'], 'x.pdf', { type: 'application/pdf' })] })); } catch (_) { return false; }
  };

  // ---------- settings ----------

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const { paper, size, textLayer, format, unwrap, animate } = P.settings;
      store.kvSet('page', { text: el.text.value, paper, size, textLayer, format, unwrap, ...(animate === null ? {} : { animate }) }).catch(() => {});
    }, 300);
  }

  /** paper / size: the written pieces are laid out again, nothing is written. */
  function set(key, value) {
    if (key === 'paper' && DOC_PAPERS.includes(value)) P.settings.paper = value;
    else if (key === 'size' && DOC_SIZES.includes(value)) P.settings.size = value;
    else return;
    save();
    relayout();
    sync();
    schedule();
  }

  function autosize() {
    if (!P.visible || !P.active) return;
    el.text.style.height = 'auto';
    el.text.style.height = `${el.text.scrollHeight + 2}px`;
  }

  // Beside the counter: the format the text will be read as ("Markdown", "LaTeX"; nothing
  // for a plain text or the choice 'text'), read again a moment after typing stops.
  let detectTimer = null;
  function detect() {
    clearTimeout(detectTimer);
    if (!el.detected) return;
    const text = String(el.text.value || '');
    const f = text.trim() ? source(text).format : 'text';
    el.detected.textContent = FORMAT_NAMES[f] || '';
  }
  // a long text waits longer: one parse of 40 000 characters takes 42 ms (Node)
  const detectSoon = () => { clearTimeout(detectTimer); detectTimer = setTimeout(detect, el.text.value.length > 5000 ? 1000 : 250); };

  async function init() {
    try {
      const v = await store.kvGet('page', null);
      if (v && typeof v === 'object') {
        if (typeof v.text === 'string') el.text.value = v.text;
        if (DOC_PAPERS.includes(v.paper)) P.settings.paper = v.paper;
        if (DOC_SIZES.includes(v.size)) P.settings.size = v.size;
        P.settings.textLayer = v.textLayer !== false;
        if (FORMATS.includes(v.format)) P.settings.format = v.format;
        P.settings.unwrap = v.unwrap !== false;
        if (typeof v.animate === 'boolean') P.settings.animate = v.animate;
      }
    } catch (_) { /* defaults */ }
    const editor = createEditor({ text: el.text, root: $('gen'), format: () => (P.settings.format === 'auto' ? detectFormat(el.text.value) : P.settings.format) });
    const help = createFormatHelp({
      text: el.text,
      getFormat: () => P.settings.format,
      setFormat: (f) => { if (FORMATS.includes(f)) { P.settings.format = f; save(); detect(); editor.refresh(); sync(); } },
      onText: () => { autosize(); save(); detect(); sync(); },
    });
    help.refresh();
    detect();
    el.textLayer.checked = P.settings.textLayer;
    if (el.unwrap) el.unwrap.checked = P.settings.unwrap;
    // "Schreiben zeigen": off (or the system's wish for less motion) shows each piece whole as
    // it comes, as before; switched off while the pen writes, the rest is there at once
    el.animate.checked = animateOn();
    reduced.addEventListener('change', () => { if (P.settings.animate === null) el.animate.checked = animateOn(); });
    el.animate.addEventListener('change', () => { P.settings.animate = el.animate.checked; save(); if (!el.animate.checked) penFinish(); });
    el.now.addEventListener('click', penFinish);
    el.share.hidden = !canShareFiles();
    el.write.addEventListener('click', write);
    el.cancel.addEventListener('click', cancel);
    el.text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); write(); } });
    // maxlength cuts a long paste without a word: say so
    el.text.addEventListener('input', () => { note(el.text.maxLength > 0 && el.text.value.length >= el.text.maxLength ? `Der Text ist auf ${el.text.maxLength.toLocaleString('de-DE')} Zeichen gekürzt.` : ''); autosize(); save(); detectSoon(); sync(); });
    el.pdf.addEventListener('click', downloadPdf);
    el.share.addEventListener('click', sharePdf);
    el.redo.addEventListener('click', rewrite);
    el.textLayer.addEventListener('change', () => { P.settings.textLayer = el.textLayer.checked; save(); });
    if (el.unwrap) el.unwrap.addEventListener('change', () => { P.settings.unwrap = el.unwrap.checked; save(); detect(); });
    // A tap is a short press that hardly moves (a scroll with the finger is not a tap).
    let down = null;
    el.pages.addEventListener('pointerdown', (e) => {
      const f = P.frames.find((x) => x.wrap.contains(e.target));
      down = f && e.isPrimary ? { f, x: e.clientX, y: e.clientY } : null;
    });
    el.pages.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > TAP_MOVE) { down = null; return; }
      const f = down.f; down = null;
      onTap(e, f);
    });
    el.pages.addEventListener('pointercancel', () => { down = null; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && P.pick && P.active) choose(null); });
    let lastW = 0;
    new ResizeObserver(() => { const w = cssW = el.pages.clientWidth; if (w !== lastW) { lastW = w; redraw(); } }).observe(el.pages);
    sync();
  }

    /** Page i drawn whole on the main thread at the size of its canvas (tests: what an
   *  incremental drawing must equal); shown: only what the pen has written so far, and
   *  the box of the stroke on its way ([x0, y0, x1, y1] device px) as c.pen. */
  function snapshot(i, { shown = false } = {}) {
    const f = P.frames[i], w = cssWidth();
    if (!f || !P.doc || !w) return null;
    const ratio = Math.min(dpr(), Math.sqrt(MAX_PIXELS / (w * w * (PAGE.height / PAGE.width))));
    const pw = Math.round(w * ratio), l = look();
    const c = Object.assign(document.createElement('canvas'), { width: pw, height: Math.round(pw * PAGE.height / PAGE.width) });
    let doc = P.doc;
    const vis = shown && P.shown[i];
    if (vis && doc.pages[i]) {
      const page = doc.pages[i], list = itemsOf(page, { doc, pw, ph: c.height, look: l }).list.filter((_, k) => vis[k]);
      const st = list.filter((it) => !it.band);
      const part = { ...page, bands: list.filter((it) => it.band).map((it) => it.band), strokes: st.map((it) => page.strokes[it.i]), ...(page.styles ? { styles: st.map((it) => page.styles[it.i]) } : {}) };
      doc = { ...doc, pages: doc.pages.map((p, k) => (k === i ? part : p)) };
    }
    drawDocumentPage(c.getContext('2d'), doc, i, { scale: pw / PAGE.width, look: l, colors: lookColors(l) });
    if (P.cur && P.cur.e.p === i) c.pen = itemsOf(P.doc.pages[i], { doc: P.doc, pw, ph: c.height, look: l }).list[P.cur.e.k].box;
    return c;
  }

  return {
    init, set, redraw, modelChanged, busy, cancel, autosize, sync,
    /** Drop the mark and its "Neu schreiben" bar (Stil opened over the page). */
    unpick() { if (P.pick) choose(null); },
    get settings() { return { ...P.settings }; },
    /** The page mode is the one in use (shown when the tab is shown). */
    activate(on) { P.active = on; if (on) { autosize(); redraw(); } },
    show() { P.visible = true; if (P.phase === 'writing' || (engaged(penOf()) && penOf().frontier)) followOn(); autosize(); redraw(); },
    hide() { P.visible = false; },
    debug: () => {
      const r = P.run, d = P.doc;
      return {
        phase: running && P.phase === 'idle' ? 'starting' : P.phase, rewriting: [...P.rewriting], pick: P.pick ? P.pick.piece : null,
        seed: r ? r.seed : null, total: r ? r.plan.pieces.length : 0, done: r ? r.done : 0, workers: r ? r.workers : 0, ms: r ? r.ms : null, retried: r ? r.retried || 0 : 0,
        versions: r ? r.plan.pieces.map((_, i) => r.version[i] || 0) : [], settings: { ...P.settings }, pieces: r ? r.plan.pieces.map((p) => p.text) : [],
        pages: d ? d.pages.length : 0, placed: d ? d.placed : 0,
        words: d ? d.pages.flatMap((p, pi) => p.words.map((w) => ({ page: pi, text: w.text, piece: w.piece, line: w.line, x: w.x, baseline: w.baseline, box: w.box, ...(d.rich ? { block: w.block, frame: w.frame, size: w.size, style: w.style, strokes: w.strokes } : {}) }))) : [],
        ink: r ? r.written.map((w) => (w ? w.words.map((x) => Array.from(x.points.slice(0, 12)).map((v) => Math.round(v * 1000))) : null)) : [],
        drawn: P.frames.map((f) => !!f.key),
        format: r ? (r.doc ? r.doc.format : 'text') : null,
        // the pen: its log ([page, stroke (a band: -1 - index) when written, piece, ms, key]), and
        // its order now ([page, stroke, piece, need, shown, key]); asked: pieces given to the engines in this run
        pen: (() => {
          const pen = penOf();
          return {
            engaged: engaged(pen), used: !!(pen && pen.used), frontier: pen && pen.frontier ? { ...pen.frontier } : null, settled: P.settled,
            log: pen ? pen.log.slice() : [], cur: P.cur ? [P.cur.e.p, P.cur.e.i, Math.floor(P.cur.pos)] : null,
            order: d && pen && drawing(d) ? buildG(drawing(d)).map((e) => [e.p, e.i, e.owner, e.need, shownBy(pen, e) ? 1 : 0, e.key]) : [],
            showing: P.view === r, asked: r ? r.asked : 0, kept: r ? r.kept : 0, label: el.write.textContent, now: !el.now.hidden,
            canon: P.frames.map((f) => !!f.canon),
          };
        })(),
        /** Tests: the pen stands still (on) or goes on, so that a page can be read as it is. */
        pause: (on) => { P.paused = !!on; schedule(); },
        /** Tests: page i drawn whole with only what the pen has written (snapshot below). */
        shownSnapshot: (i) => snapshot(i, { shown: true }),
        /** Tests: the run's pieces laid out from scratch here, as JSON of the pages' words, and
         *  the document shown the same way (an update must equal a document written anew). */
        scratch: () => {
          if (!r || !d) return null;
          const fresh = layoutDocument(r.plan, r.written, docSettings(), { gapXh: r.info.gapXh, sizeByBias: r.sizeByBias });
          const words = (x) => JSON.stringify(x.pages.map((p) => [p.words, p.strokes.map((q) => Array.from(q.slice(0, 6)))]));
          return { same: words(fresh) === words(d), pages: fresh.pages.length };
        },
        rich: d && d.rich ? {
          blocks: d.blocks.map((b) => ({ type: b.type, level: b.level, marker: b.marker, box: b.box })),
          pages: d.pages.map((p) => ({
            strokes: p.styles.map((st, i) => { const q = p.strokes[i]; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (let k = 0; k < q.length; k += 3) { x0 = Math.min(x0, q[k]); x1 = Math.max(x1, q[k]); y0 = Math.min(y0, q[k + 1]); y1 = Math.max(y1, q[k + 1]); } return { ...st, box: [x0, y0, x1, y1] }; }),
            bands: p.bands.map((b) => { const xs = b.points.filter((_, k) => k % 2 === 0), ys = b.points.filter((_, k) => k % 2); return { color: b.color, line: b.line, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] }; }),
            frames: p.frames, markers: p.markers, arrows: p.arrows,
          })),
        } : null,
      };
    },
    snapshot,
  };
}
