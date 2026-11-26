// The pen of the page mode (SPEC 2.5.2): the order in which a person would put a laid-out
// document on paper, how much of the text the layout can no longer move, and, run as a
// worker, the layout itself, off the main thread.
//
//   const layouts = createLayouts();
//   layouts.start(id, plan, { gapXh, sizeByBias }, { from, map });   // map[i]: piece i of run `from`, or -1
//   layouts.piece(id, i, written);
//   const { doc, order, settled } = await layouts.layout(id, settings);
//
// A five-page document with lists, boxes and a table (218 pieces) takes 14-23 ms to lay out
// in Node and 85-90 ms on the page with the CPU slowed 4x, once per frame while pieces
// arrive: here it runs beside the page (written so at CPU / 4: no task over 50 ms on the
// page; laid out on the page as before, 40 tasks over 50 ms).  A page that came out as before is not sent again (the page keeps
// its object), the strokes of the others are handed over, not copied.
import { layoutDocument, typicalSize, TYPICAL_PIECES } from './document.js';

/** A stroke's or band's extent: [x0, y0, x1, y1] (mm). */
export function extent(p, step) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += step) { if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i]; if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1]; }
  return [x0, y0, x1, y1];
}
// How far a box reaches out of a rect (mm, 0: inside), to tell which frame or grid a stroke
// belongs to: a frame's first line starts with a hook, the ends of a line overshoot.
const outside = (b, r) => Math.max(0, r[0] - b[0], b[2] - r[2], r[1] - b[1], b[3] - r[3]);
const nearest = (list, rect, b) => { let best = null, d = 4; for (const x of list) { const o = outside(b, rect(x)); if (o < d) { d = o; best = x; } } return best; };

// A highlighter goes over a word faster than the word was written: one point of the pen's
// pace per this many x-heights of the band (writing moves about 0.12 x-heights a point).
const BAND_STEP = 0.35;

/**
 * The pen's order of a laid-out document: per page a Float64Array of entries, four numbers
 * each: stroke index (a band: -1 - its index), need, owner, points.  need: how many pieces
 * from the start of the text must be settled (settledPieces) before the entry may be drawn,
 * never less than the entry before it; owner: the piece it belongs to (a decoration: the
 * word it follows, a mark before its text: that text).
 *
 * In reading order, row by row: what stands before the words (a bullet, a check box and its
 * tick, an arrow, a rule) at its place, a line under or through words (underline, strike,
 * highlighter) right after the last of them, a frame after its last row, a table's grid
 * before its cells, one cell after the other.  A line under the last row written so far
 * waits for the rest of its line: the run may still go on there.
 */
export function penOrder(doc, plan) {
  const B = doc.geometry.baselines;
  const near = (y) => { let best = 0; for (let l = 1; l < B.length; l++) if (Math.abs(B[l] - y) < Math.abs(B[best] - y)) best = l; return best; };
  let last = null;                                  // the last row with words: [page, line]
  doc.pages.forEach((p, pi) => { for (const w of p.words) if (!last || pi > last[0] || w.line > last[1]) last = [pi, w.line]; });
  const lineEnd = (piece) => { const list = plan.paragraphs[plan.pieces[piece].para] || []; return list[list.length - 1]; };
  let need = 0;
  return doc.pages.map((page, pi) => {
    // a table is written cell by cell, row by row: a cell's rows go before the next cell
    const cellRows = new Map();                     // page line -> [first line of its table row, column xs]
    for (const t of page.tables || []) for (const rs of t.rows) for (const l of rs) cellRows.set(l, [rs[0], t.xs]);
    const cellOf = (line, x) => { const c = cellRows.get(line); if (!c) return [line, 0]; let k = 1; while (k < c[1].length - 1 && x >= c[1][k]) k++; return [c[0], k]; };
    const rowMax = new Map(), ofWord = new Int32Array(page.strokes.length).fill(-1);
    page.words.forEach((w, wi) => {
      rowMax.set(w.line, Math.max(rowMax.has(w.line) ? rowMax.get(w.line) : -1, w.piece));
      const [a, b] = doc.rich ? w.strokes : [wi, wi + 1];
      for (let s = a; s < b; s++) ofWord[s] = wi;
    });
    const complete = (line) => !rowMax.has(line) || doc.complete || pi < last[0] || (pi === last[0] && line < last[1]) || lineEnd(rowMax.get(line)) === rowMax.get(line);
    const rowNeed = (line) => (complete(line) ? (rowMax.has(line) ? rowMax.get(line) + 1 : 0) : Infinity);
    const maxIn = (test) => { let m = -1; for (const w of page.words) if (test(w)) m = Math.max(m, w.piece); return m + 1; };
    const list = [];
    page.strokes.forEach((q, s) => {
      if (!q.length) return;
      const pts = q.length / 3, wi = ofWord[s];
      if (wi >= 0) { const w = page.words[wi]; list.push({ i: s, line: w.line, cell: cellOf(w.line, w.x), x: w.x, r: 0, piece: w.piece, own: w.piece + 1, pts }); return; }
      const kind = page.styles ? page.styles[s].kind : 'word', bx = extent(q, 3), cy = (bx[1] + bx[3]) / 2;
      if (kind === 'grid') {
        const t = nearest(page.tables || [], (tb) => [tb.xs[0], tb.ys[0], tb.xs[tb.xs.length - 1], tb.ys[tb.ys.length - 1]], bx);
        const line = t ? t.rows[0][0] : near(bx[1]);
        list.push({ i: s, line, cell: [line, -1], x: -Infinity, r: -1, own: t ? maxIn((w) => w.block === t.block) : 0, pts });
      } else if (kind === 'frame') {
        const f = nearest(page.frames || [], (fr) => fr.rect, bx);
        let line = near(bx[3]);
        if (f) B.forEach((b, l) => { if (b < f.rect[3]) line = l; });
        list.push({ i: s, line, cell: [line, Infinity], x: Infinity, r: 2, after: true, own: f ? maxIn((w) => w.box[0] > f.rect[0] && w.box[2] < f.rect[2] && w.box[1] > f.rect[1] && w.box[3] < f.rect[3]) : 0, pts });
      } else if (kind === 'underline' || kind === 'strike') {
        const line = near(cy);
        list.push({ i: s, line, cell: cellOf(line, bx[0]), x: bx[2], r: 1, after: true, own: rowNeed(line), pts });
      } else {                                      // bullet, check box, tick, arrow, rule
        const line = near(cy);
        // a check box's two strokes and its tick in the order drawn, at the place of the box
        const mk = kind === 'check' || kind === 'tick' ? (page.markers || []).find((m) => m.line === line && Math.abs(m.x - bx[0]) < 2 * doc.geometry.xh) : null;
        list.push({ i: s, line, cell: cellOf(line, bx[0]), x: mk ? mk.x : bx[0], r: kind === 'tick' ? 0.5 : 0, own: 0, pts });
      }
    });
    (page.bands || []).forEach((bd, b) => {
      const bx = extent(bd.points, 2);
      list.push({ i: -1 - b, line: bd.line, cell: cellOf(bd.line, bx[0]), x: bx[2], r: 1, after: true, own: rowNeed(bd.line), pts: Math.max(8, Math.round((bx[2] - bx[0]) / (BAND_STEP * doc.geometry.xh))) });
    });
    list.sort((a, b) => a.cell[0] - b.cell[0] || a.cell[1] - b.cell[1] || a.line - b.line || a.x - b.x || a.r - b.r || (a.i < 0 ? 1e6 - a.i : a.i) - (b.i < 0 ? 1e6 - b.i : b.i));
    // a decoration belongs to the word it follows, a mark before its text to that text
    const owner = list.map((e) => e.piece ?? -1);
    for (let j = 0, prev = -1; j < list.length; j++) { if (list[j].piece !== undefined) prev = list[j].piece; else if (list[j].after) owner[j] = prev; }
    for (let j = list.length - 1, next = -1; j >= 0; j--) { if (list[j].piece !== undefined) next = list[j].piece; else if (owner[j] < 0) owner[j] = next; }
    for (let j = 0, prev = -1; j < list.length; j++) { if (owner[j] >= 0) prev = owner[j]; else owner[j] = prev; }
    const out = new Float64Array(4 * list.length);
    list.forEach((e, j) => {
      need = Math.max(need, e.own);
      out.set([e.i, need, owner[j], e.pts], 4 * j);
    });
    return out;
  });
}

/**
 * How many pieces from the start of the text the layout can no longer move: the first
 * piece not yet written, held back to the start of every unit whose place depends on all
 * of it while some of it is missing (a box: it moves to the next page when it no longer
 * fits; a heading: it keeps the row after it; a numbered list: its text column follows
 * its widest label; a centred or right-aligned line: it is shifted once it is filled; a
 * table and a line in parts: shown only whole).  0 until the typical letter size is fixed
 * (document.js: TYPICAL_PIECES): until then every piece shown may still change its size.
 */
export function settledPieces(plan, written, fixed) {
  const N = plan.pieces.length;
  let f = 0;
  while (f < N && written[f]) f++;
  if (!fixed) return 0;
  if (!plan.rich || f === N) return f;
  const groups = [];
  const span = (ks) => { let a = Infinity, b = -1; for (const k of ks) for (const i of plan.paragraphs[k] || []) { a = Math.min(a, i); b = Math.max(b, i + 1); } return b < 0 ? null : [a, b]; };
  const join = (list) => { const s = list.filter(Boolean); return s.length ? [Math.min(...s.map((x) => x[0])), Math.max(...s.map((x) => x[1]))] : null; };
  const blockSpan = plan.blocks.map((b) => span(b.lines));
  const add = (g) => { if (g) groups.push(g); };
  // boxes: consecutive blocks of one box
  for (let bi = 0; bi < plan.blocks.length;) {
    const box = plan.blocks[bi].box;
    let e = bi + 1;
    if (box !== null) while (e < plan.blocks.length && plan.blocks[e].box === box) e++;
    if (box !== null) add(join(blockSpan.slice(bi, e)));
    bi = e;
  }
  // tables, lines in parts, centred and right-aligned lines
  plan.blocks.forEach((b, bi) => {
    if (b.type === 'table') add(blockSpan[bi]);
    else for (const k of b.lines) if (plan.lines[k].parts || b.align !== 'left') add(span([k]));
  });
  // numbered lists: the run of items document.js gives one text column
  let run = [];
  const flush = () => { if (run.some((bi) => plan.blocks[bi].marker === 'number')) add(join(run.map((bi) => blockSpan[bi]))); run = []; };
  plan.blocks.forEach((b, bi) => {
    if (b.type === 'item' && (!run.length || plan.blocks[run[0]].box === b.box)) run.push(bi);
    else if (b.type !== 'blank') { flush(); if (b.type === 'item') run.push(bi); }
  });
  flush();
  // headings, from the last: with the unit of the block after them
  for (let bi = plan.blocks.length - 1; bi >= 0; bi--) {
    if (plan.blocks[bi].type !== 'heading' || !blockSpan[bi]) continue;
    let nb = bi + 1;
    while (nb < plan.blocks.length && plan.blocks[nb].type === 'blank') nb++;
    const own = blockSpan[bi], next = nb < plan.blocks.length ? blockSpan[nb] : null;
    let end = own[1];
    if (next) { end = Math.max(end, next[0] + 1); for (const g of groups) if (g[0] <= next[0] && next[0] < g[1]) end = Math.max(end, g[1]); }
    groups.push([own[0], end]);
  }
  let R = f;
  for (let moved = true; moved;) {
    moved = false;
    for (const [a, b] of groups) if (b > f && a < R) { R = a; moved = true; }
  }
  return R;
}

/** One run's layout state: the plan, what is written, the typical size once fixed. */
const newRun = (plan, opts, written = []) => ({ plan, opts, written, typical: undefined, sent: [] });

/** Lay out a run (the typical size fixed as page-view.js always did: once the first
 *  TYPICAL_PIECES pieces are there, then kept, so a rewrite moves nothing before it). */
function layoutRun(r, settings) {
  if (r.typical === undefined) {
    const need = Math.min(TYPICAL_PIECES, r.plan.pieces.length);
    let have = 0;
    for (let i = 0; i < need; i++) if (r.written[i]) have++;
    if (have === need) r.typical = typicalSize(r.written);
  }
  const doc = layoutDocument(r.plan, r.written, settings, { ...r.opts, typical: r.typical });
  const fixed = r.typical !== undefined;
  return { doc, order: penOrder(doc, r.plan), settled: settledPieces(r.plan, r.written, fixed), fixed };
}

const sig = (p, step) => { const n = p.length, m = step * Math.floor(n / (2 * step)); return `${n}:${p[0]},${p[1]},${p[m]},${p[m + 1]},${p[n - step]},${p[n - step + 1]}`; };
const fingerprint = (page) => JSON.stringify([page.words, page.styles, page.arrows, page.markers, page.frames, page.tables, (page.bands || []).map((b) => [b.color, b.line, b.block, sig(b.points, 2)])]) + page.strokes.map((q) => sig(q, 3)).join(';');

/** The worker's answer: the pages that changed since the last answer for this run, the
 *  others as { same: true }; the strokes' buffers to hand over. */
function pack(r, { doc, order, settled, fixed }) {
  const transfer = new Set();
  const pages = doc.pages.map((page, k) => {
    const fp = fingerprint(page);
    if (r.sent[k] === fp) return { same: true };
    r.sent[k] = fp;
    for (const q of page.strokes) if (q.byteOffset === 0 && q.byteLength === q.buffer.byteLength) transfer.add(q.buffer);
    return page;
  });
  r.sent.length = doc.pages.length;
  for (const o of order) transfer.add(o.buffer);
  return { msg: { doc: { ...doc, pages: null }, pages, order, settled, fixed, typical: r.typical }, transfer: [...transfer] };
}

/** The page's side: a worker where module workers run, else the same work here. */
export function createLayouts() {
  const runs = new Map();          // id -> the run here too: the fallback, and the kept pieces of an update
  const last = new Map();          // id -> the pages of the last answer
  const waiting = new Map();
  let worker = null, seq = 0;
  const local = (id, settings) => layoutRun(runs.get(id), settings);
  const fallback = () => {          // no worker (any more): what was asked of it is done here
    if (worker) { worker.terminate(); worker = null; }
    for (const [s, w] of waiting) { waiting.delete(s); w.resolve(local(w.id, w.settings)); }
  };
  try {
    worker = new Worker(new URL('./pen.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data, w = waiting.get(m.seq);
      if (!w) return;
      waiting.delete(m.seq);
      if (m.gone) { w.resolve(null); return; }
      const prev = last.get(m.id) || [];
      const pages = m.pages.map((p, k) => (p.same ? prev[k] : p));
      last.set(m.id, pages);
      const r = runs.get(m.id);
      if (r && m.typical !== undefined) r.typical = m.typical;
      w.resolve({ doc: { ...m.doc, pages }, order: m.order, settled: m.settled, fixed: m.fixed });
    };
    worker.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); fallback(); };
  } catch (_) { worker = null; }
  return {
    get offThread() { return !!worker; },
    /** A new run; from / map: the pieces it takes over from run `from` (map[i] its index there, or -1). */
    start(id, plan, opts, { from = null, map = null } = {}) {
      const src = from !== null ? runs.get(from) : null;
      const written = src && map ? map.map((j) => (j >= 0 ? src.written[j] : undefined)) : [];
      runs.set(id, newRun(plan, opts, written));
      last.delete(id);
      if (worker) worker.postMessage({ op: 'start', id, plan, opts, from: src ? from : null, map: src ? map : null });
    },
    piece(id, i, w) {
      const r = runs.get(id);
      if (!r) return;
      r.written[i] = w;
      if (worker) worker.postMessage({ op: 'piece', id, i, w });
    },
    written: (id) => (runs.get(id) || { written: [] }).written,
    layout(id, settings) {
      if (!runs.has(id)) return Promise.resolve(null);
      if (!worker) return Promise.resolve(local(id, settings));
      return new Promise((resolve) => { const s = ++seq; waiting.set(s, { resolve, id, settings }); worker.postMessage({ op: 'layout', id, seq: s, settings }); });
    },
    drop(id) { runs.delete(id); last.delete(id); if (worker) worker.postMessage({ op: 'drop', id }); },
  };
}

// As a worker: the runs' layout state; every message one task.
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  const runs = new Map();
  self.onmessage = (e) => {
    const m = e.data;
    if (m.op === 'start') {
      const src = m.from !== null ? runs.get(m.from) : null;
      runs.set(m.id, newRun(m.plan, m.opts, src && m.map ? m.map.map((j) => (j >= 0 ? src.written[j] : undefined)) : []));
    } else if (m.op === 'piece') { const r = runs.get(m.id); if (r) r.written[m.i] = m.w; }
    else if (m.op === 'drop') runs.delete(m.id);
    else if (m.op === 'layout') {
      const r = runs.get(m.id);
      if (!r) { self.postMessage({ id: m.id, seq: m.seq, gone: true }); return; }
      const { msg, transfer } = pack(r, layoutRun(r, m.settings));
      self.postMessage({ id: m.id, seq: m.seq, ...msg }, transfer);
    }
  };
}
