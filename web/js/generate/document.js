// The page mode ("Seite"): a typed text written onto A4 pages.  No DOM in here.
//
//   const plan = planDocument(text, model.normalize);
//   for every piece i: result = await engine.writePiece({ text: plan.pieces[i].text, bias, seed: pieceSeed(seed, i) })
//                      written[i] = preparePiece(result, xhModel)
//   const doc = layoutDocument(plan, written, settings, { gapXh, sizeByBias });   // also while pieces are missing
//   render.js drawDocumentPage() and pdf.js documentToPDF() both read `doc`.
//
// Everything in a document is in millimetres, y pointing down, (0, 0) the top
// left corner of the page.  Ink arrives in xh units (layout.js) and is scaled here.
import { makeRandom } from '../engine/engine.js';
import { splitPieces, straighten, toXh, levelledWords, wordLevel, strokeRanges, strokeSize, sizeScale, MAX_PIECE_CHARS, LEVEL_KEEP } from './layout.js';

// ---------- paper ----------

export const PAGE = Object.freeze({ width: 210, height: 297 });     // A4 portrait, mm
export const MARGIN = Object.freeze({ left: 20, right: 15 });
export const DOC_PAPERS = ['liniert', 'kariert', 'blanko'];
// Rulings as in a notebook app.  Liniert / Blanko: a baseline every 8 mm from 24 mm
// on, the last one at least 12 mm above the bottom edge (33 lines).  Kariert: a 5 mm
// grid centred on the page, the writing on every second grid line (26 lines).
export const LINE_PITCH = 8, FIRST_LINE = 24, BOTTOM_ROOM = 12, GRID = 5;
// x-height / baseline distance, chosen by looking at written pages and counting
// neighbouring lines whose ink touches.  Within a piece this hand's highest point
// is a median 3.5 xh above the baseline, its deepest 1.5 xh below: 0.30 (the
// first guess) ran lines into each other; on one lined page of prose 0.25 touched
// on 16 of 36 line pairs, 0.21 on 12 of 31, 0.18 on 4 of 28.
export const SIZES = Object.freeze({ klein: 0.16, mittel: 0.18, gross: 0.21 });
export const DOC_SIZES = Object.keys(SIZES);
export const RULE_WIDTH = 0.16;          // mm: a hairline that still prints

/** Where the writing goes on a page of this paper: baselines (mm from the top),
 *  the x-height, and the ruling to draw ({ ys, xs, tone: 'rule' | 'faint' }). */
export function paperGeometry(paper, size = 'mittel') {
  const kind = DOC_PAPERS.includes(paper) ? paper : 'liniert';
  const share = SIZES[size] ?? SIZES.mittel;
  const last = PAGE.height - BOTTOM_ROOM;
  const baselines = [], ys = [], xs = [];
  let pitch = LINE_PITCH;
  if (kind === 'kariert') {
    pitch = 2 * GRID;
    const y0 = (PAGE.height - GRID * Math.floor(PAGE.height / GRID)) / 2;     // 1 mm: the grid sits centred
    for (let y = y0; y <= PAGE.height + 1e-9; y += GRID) ys.push(round3(y));
    for (let x = 0; x <= PAGE.width + 1e-9; x += GRID) xs.push(round3(x));
    const first = ys.find((y) => y >= FIRST_LINE - 1e-9);
    for (let y = first; y <= last + 1e-9; y += pitch) baselines.push(round3(y));
  } else {
    for (let y = FIRST_LINE; y <= last + 1e-9; y += pitch) baselines.push(y);
    if (kind === 'liniert') ys.push(...baselines);
  }
  return {
    paper: kind, size: share === SIZES[size] ? size : 'mittel', pitch, xh: round3(share * pitch), baselines,
    left: MARGIN.left, right: PAGE.width - MARGIN.right,
    ruling: { ys, xs, tone: kind === 'kariert' ? 'faint' : 'rule', width: RULE_WIDTH },
  };
}
const round3 = (v) => Math.round(v * 1000) / 1000;

// ---------- text -> pieces, seeds ----------

/** Deterministic 32-bit seed of piece `index` of a document, independent of how
 *  many workers write and in which order; `version` counts the rewrites. */
export function pieceSeed(docSeed, index, version = 0) {
  let h = (docSeed >>> 0) ^ Math.imul(index + 1, 0x9E3779B1) ^ Math.imul(version + 1, 0x7FEB352D);
  h ^= h >>> 16; h = Math.imul(h, 0x85EBCA6B);
  h ^= h >>> 13; h = Math.imul(h, 0xC2B2AE35);
  h ^= h >>> 16;
  return h >>> 0;
}
const LAYOUT_SALT = 0x5BD1E995;      // the layout's own random numbers, apart from the network's

/** Text -> { paragraphs: [[pieceIndex, ...], ...], pieces: [{ index, text, para, typed }] }.
 *  One newline (\n, \r\n or a lone \r) starts a new line, an empty line stays one
 *  empty line (an empty paragraph).  `normalize` is the model's (model.normalize /
 *  createNormalizer); typed[] holds the piece's words as typed, for the PDF's text
 *  layer ("„Süße“" stays that, the network writes '"Süße"'). */
export function planDocument(text, normalize = (t) => t) {
  // Word by word, so that every written word keeps its typed form.
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n').map((line) => {
    const words = [];
    for (const typed of line.split(/\s+/u).filter(Boolean)) {
      const parts = normalize(typed).split(' ').filter(Boolean);
      for (const w of parts) words.push([w, parts.length === 1 ? typed : w]);
    }
    return words;
  });
  const pieces = [], paragraphs = [];
  splitPieces(lines.map((words) => words.map(([w]) => w).join(' ')).join('\n'), MAX_PIECE_CHARS).forEach((para, k) => {
    let at = 0;
    paragraphs.push(para.map((t) => {
      const n = t.split(' ').length;
      pieces.push({ index: pieces.length, text: t, para: k, typed: lines[k].slice(at, at + n).map(([, typed]) => typed) });
      at += n;
      return pieces.length - 1;
    }));
  });
  // Trailing empty lines write nothing and would only add blank lines.
  while (paragraphs.length && !paragraphs[paragraphs.length - 1].length) paragraphs.pop();
  return { paragraphs, pieces };
}

// ---------- letter size of a written piece ----------

// Expected pen-down ink length per character (xh), fitted on the writer's real
// lines and words (ridge towards the class means, cross-validated by line).
const INK_PER_CHAR = (() => {
  const t = {};
  const s = '!6.3"4.3#6.9%7.7&8.5\'2.2(4.3)4.6*7.1+4.1,5.5-2.0.1.8/3.4' + '06.912.924.935.144.654.465.173.786.296.6' +
    ':4.6;9.3=5.1?3.9@10.3A7.0B9.5C7.6D12.9E6.3F7.6G10.4H9.5I5.7J8.2K8.2L3.3M9.2N10.2O8.8P9.5Q11.0R9.8S5.8T8.7' +
    'U5.8V6.4W9.1X8.1Y12.3Z4.8[6.3]6.3_5.1a4.7b6.6c2.2d7.6e4.1f7.2g6.1h6.1i1.3j6.0k5.0l2.3m5.6n3.4o3.9p6.3q3.8' +
    'r1.8s1.8t4.0u4.3v1.8w3.3x5.4y7.3z2.9Ä9.7Ö15.1Ü8.4ß7.4ä4.3ö4.8ü3.7€6.0';
  for (const m of s.matchAll(/(.)(\d+\.\d)/gu)) t[m[1]] = Number(m[2]);
  return t;
})();
const classLength = (c) => (/\d/u.test(c) ? 5.0 : /\p{Lu}/u.test(c) ? 8.1 : /\p{L}/u.test(c) ? 3.8 : 4.3);
// log(stroke size) explained by the text: constant, shares of ascender letters,
// capitals, descender letters, capital umlauts, digits, punctuation.
const HEIGHT_W = [1.008, 0.684, 1.73, 1.028, -0.009, 0.476, -0.357];
// Weight of the ink-length measure against the height measure.  Recovering a known
// factor (0.7-1.4) on 322 real pieces of 8-22 characters, 4-fold by line, sd of
// the log error: stroke size 0.220, stroke size over its text 0.183, ink length
// 0.140, this mix 0.136.
const INK_WEIGHT = 0.85;
export const SIZE_ERROR = 0.136;

/** Estimated log letter size of a straightened piece (xh units), up to a constant
 *  that is the same for every piece; NaN when the piece has too few characters. */
export function sizeEstimate(points, text) {
  const chars = [...text].filter((c) => c !== ' ');
  if (chars.length < 3 || points.length < 9) return NaN;
  let ink = 0;
  for (let i = 3; i < points.length; i += 3) if (points[i - 1] <= 0.5) ink += Math.hypot(points[i] - points[i - 3], points[i + 1] - points[i - 2]);
  let expect = 0;
  for (const c of chars) expect += INK_PER_CHAR[c] ?? classLength(c);
  const n = chars.length, share = (re) => chars.filter((c) => re.test(c)).length / n;
  const f = [1, share(/[bdfhklt]/u), share(/\p{Lu}/u), share(/[gjpqyß]/u), share(/[ÄÖÜ]/u), share(/\d/u), share(/[,.;:!?-]/u)];
  const height = Math.log(strokeSize(points)) - f.reduce((s, v, i) => s + v * HEIGHT_W[i], 0);
  return ink > 0 ? INK_WEIGHT * Math.log(ink / expect) + (1 - INK_WEIGHT) * height : NaN;
}

// How far a piece is pulled towards the page's typical size: the share of the
// estimate's spread that is real, cov(estimate, x-height fit) / var(estimate) with
// an independent height measure (hw/prep.py: fit_xheight).  117 pieces of the
// test model (bias 0.4) spread by sd 0.088 and give 0.68; the same 14 texts
// written with 6 seeds each give 0.99 +- 0.15 within a text.  (The error 0.136
// on real lines mostly is the lines' own size: two pieces of one line differ by
// an error of only 0.085.)
export const SIZE_PULL = 0.7;
export const SIZE_CLAMP = [0.8, 1.25];

/** The correction factor for a piece of estimated log size `est` on a page whose
 *  typical estimate is `typical`. */
export function sizeCorrection(est, typical, pull = SIZE_PULL) {
  if (!Number.isFinite(est) || !Number.isFinite(typical) || !pull) return 1;
  return Math.min(SIZE_CLAMP[1], Math.max(SIZE_CLAMP[0], Math.exp(-pull * (est - typical))));
}

// Words inside a piece differ in size too ("Nachricht!" twice as tall as its
// neighbours).  Words of 4 or more characters, measured against their own piece,
// on the 117 test pieces: sd 0.100, cov with the x-height fit / var = 0.46 (229 words).
export const WORD_PULL = 0.46, WORD_MIN_CHARS = 4;
export const WORD_CLAMP = [0.85, 1.18];

/** The correction of a word whose estimate is `rel` above its piece's. */
export function wordCorrection(rel) {
  if (!Number.isFinite(rel)) return 1;
  return Math.min(WORD_CLAMP[1], Math.max(WORD_CLAMP[0], Math.exp(-WORD_PULL * rel)));
}

// The page's typical size is the median of the first pieces of the text only: once
// they are written it stays put, so what is shown never moves while the rest of the
// text arrives, whatever order the workers finish in.  Twelve pieces put the median
// within about 0.03 of the whole document's (sd of the estimate 0.088).
export const TYPICAL_PIECES = 12;

/** The typical estimate: the median of the first `count` written pieces' estimates. */
export function typicalSize(written, count = TYPICAL_PIECES) {
  const v = written.slice(0, count).filter((p) => p && Number.isFinite(p.estimate)).map((p) => p.estimate).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = (v.length - 1) / 2;
  return (v[Math.floor(m)] + v[Math.ceil(m)]) / 2;
}

// A cut whose words fit their texts this badly is wrong (hw/dataset.py: WORD_FIT_MAX).
const WORD_FIT_MAX = 1.2, LOOSE_MIN_GAP = 0.35;

/** levelledWords, and for a piece whose word gaps are unclear (3 of 113 test
 *  pieces) a looser cut: the largest gaps even when the next one is nearly as
 *  large, kept only if every word's width fits its number of characters
 *  (hw/dataset.py: split_words with ambiguous=True).  A piece left whole cannot
 *  wrap and leaves a short line before it. */
function pieceParts(piece) {
  const parts = levelledWords(piece);
  const texts = piece.text.split(/\s+/u).filter(Boolean);
  if (parts.length === texts.length || texts.length < 2) return parts;
  const p = piece.points, ranges = strokeRanges(p);
  const ext = ([s, e]) => { let lo = Infinity, hi = -Infinity; for (let i = s; i < e; i++) { lo = Math.min(lo, p[3 * i]); hi = Math.max(hi, p[3 * i]); } return [lo, hi]; };
  let reach = ext(ranges[0])[1];
  const jumps = [];
  for (let k = 1; k < ranges.length; k++) { const [lo, hi] = ext(ranges[k]); jumps.push([lo - reach, k]); reach = Math.max(reach, hi); }
  const cuts = [...jumps].sort((u, v) => v[0] - u[0]).slice(0, texts.length - 1);
  if (cuts.length < texts.length - 1 || cuts.some(([g]) => g < LOOSE_MIN_GAP)) return parts;
  const bounds = [0, ...cuts.map(([, k]) => ranges[k][0]).sort((a, b) => a - b), p.length / 3];
  const words = texts.map((text, i) => ({ text, ok: piece.ok, points: p.subarray(3 * bounds[i], 3 * bounds[i + 1]) }));
  const widths = words.map((w) => { let lo = Infinity, hi = -Infinity; for (let i = 0; i < w.points.length; i += 3) { lo = Math.min(lo, w.points[i]); hi = Math.max(hi, w.points[i]); } return Math.max(hi - lo, 1e-3); });
  const perChar = widths.map((wd, i) => wd / [...texts[i]].length).sort((a, b) => a - b);
  const med = (perChar[(perChar.length - 1) >> 1] + perChar[perChar.length >> 1]) / 2;
  if (widths.some((wd, i) => Math.abs(Math.log(wd / (med * [...texts[i]].length))) > WORD_FIT_MAX)) return parts;
  const size = strokeSize(p);
  return words.map((word) => ({ word, level: wordLevel(word.points, word.text, size) }));
}

/** The line a word sits on (xh, positive = below the piece's line), from the
 *  bottoms of its letters: the largest group of stroke bottoms within 0.3 xh of
 *  each other, the highest group on a tie (descenders only go down); NaN without
 *  any.  Unlike wordLevel it also answers for words of 1-2 characters. */
export function sitLine(p, size) {
  const ys = [];
  for (const [s, e] of strokeRanges(p)) {
    if (e - s < 3) continue;
    let len = 0;
    for (let i = s + 1; i < e; i++) len += Math.hypot(p[3 * i] - p[3 * i - 3], p[3 * i + 1] - p[3 * i - 2]);
    if (len < 0.3 * size) continue;                 // dots and short dashes
    // local lowest points, wiggles under 0.08 x the stroke size ignored (as layout.js)
    const delta = 0.08 * size;
    let hi = s, down = true;
    for (let i = s + 1; i < e; i++) {
      const y = p[3 * i + 1];
      if (down) { if (y > p[3 * hi + 1]) hi = i; else if (p[3 * hi + 1] - y > delta) { ys.push(p[3 * hi + 1]); down = false; hi = i; } }
      else if (y < p[3 * hi + 1]) hi = i; else if (y - p[3 * hi + 1] > delta) { down = true; hi = i; }
    }
    if (down) ys.push(p[3 * hi + 1]);
  }
  if (!ys.length) return NaN;
  ys.sort((a, b) => a - b);
  let best = null;
  for (let i = 0; i < ys.length; i++) {
    let j = i;
    while (j + 1 < ys.length && ys[j + 1] - ys[i] <= 0.3) j++;
    if (!best || j - i + 1 > best[1] - best[0] + 1) best = [i, j];
  }
  const g = ys.slice(best[0], best[1] + 1);
  return g[(g.length - 1) >> 1] / 2 + g[g.length >> 1] / 2;
}

// wordLevel leaves words of 1-2 characters, and words whose bottoms it finds more
// than 1.5 xh off, where the network put them: on test pages 'es' and 'zu' sat
// 0.8-1.7 mm above the rule, a whole word 2.1 mm.  Such a word is moved onto the
// line by its own letter bottoms instead, up to SIT_MAX.  A word still more than
// SIT_OFF from the line afterwards marks the piece (it is written once more).
export const SIT_MAX = 2.5, SIT_OFF = 0.5;
// A word reaching higher than this (xh) is broken (a capital drawn twice the
// size): capitals reach 3, capital umlaut dots 4 (on 814 test words: p99 4.2, the
// two above 5.0 broken).  A long stroke (over RAISED_LENGTH xh of path) whose
// lowest point stays more than RAISED_HEIGHT above the line is letters written a
// line too high ('bes' over 'nbasen'): on 259 test pieces only that piece has one.
export const TOP_MAX = 5, RAISED_HEIGHT = 1, RAISED_LENGTH = 2.5;

/** What the layout needs of a written piece (engine result in model units ->
 *  straightened, cut into levelled words, with its size estimate).  Done once per
 *  piece; the result goes into written[i].  `flags` lists what the page mode sees
 *  wrong with the piece (a word off the line, a word far too tall); the page mode
 *  writes such a piece once more. */
export function preparePiece(result, xhModel) {
  const piece = straighten(toXh(result, xhModel));
  const estimate = sizeEstimate(piece.points, piece.text);
  const parts = pieceParts(piece);
  const size = strokeSize(piece.points);
  const flags = [];
  const words = parts.map(({ word, level }) => {
    const p = word.points;
    let x0 = Infinity, x1 = -Infinity, top = Infinity;
    for (let i = 0; i < p.length; i += 3) { if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i]; if (p[i + 1] < top) top = p[i + 1]; }
    const sit = /[\p{L}\p{N}]/u.test(word.text) ? sitLine(p, size) : NaN;
    if (level === 0 && Number.isFinite(sit) && Math.abs(sit) > LEVEL_KEEP && Math.abs(sit) <= SIT_MAX) {
      level = sit - Math.min(LEVEL_KEEP, Math.max(-LEVEL_KEEP, sit));
    }
    if (Number.isFinite(sit) && Math.abs(sit - level) > SIT_OFF) flags.push(`neben der Linie: ${word.text}`);
    if (level - top > TOP_MAX) flags.push(`zu hoch: ${word.text}`);
    else if (strokeRanges(p).some(([a, e]) => {
      let len = 0, low = -Infinity;
      for (let i = a; i < e; i++) { if (i > a) len += Math.hypot(p[3 * i] - p[3 * i - 3], p[3 * i + 1] - p[3 * i - 2]); if (p[3 * i + 1] > low) low = p[3 * i + 1]; }
      return len > RAISED_LENGTH && level - low > RAISED_HEIGHT;
    })) flags.push(`über der Linie: ${word.text}`);
    const long = parts.length > 1 && [...word.text].length >= WORD_MIN_CHARS;
    return { text: word.text, points: new Float32Array(p), level, x0, x1, size: long ? wordCorrection(sizeEstimate(p, word.text) - estimate) : 1 };
  });
  return { text: piece.text, ok: piece.ok !== false, problems: result.problems || [], flags, words, estimate };
}

// ---------- layout ----------

export const DEFAULT_SETTINGS = Object.freeze({ paper: 'liniert', size: 'mittel', bias: 0.4, seed: 1, textLayer: true });
const JITTER = 0.2, JITTER_MAX = 0.5;    // mm: line starts vary a little, as by hand

/** Any half-valid settings -> complete ones.  `look` (render.js) rides along for
 *  the renderers; it never changes the layout. */
export function normalizeSettings(o) {
  const v = o && typeof o === 'object' ? o : {};
  return {
    paper: DOC_PAPERS.includes(v.paper) ? v.paper : DEFAULT_SETTINGS.paper,
    size: DOC_SIZES.includes(v.size) ? v.size : DEFAULT_SETTINGS.size,
    bias: Number.isFinite(v.bias) ? v.bias : DEFAULT_SETTINGS.bias,
    seed: Number.isFinite(v.seed) ? v.seed >>> 0 : DEFAULT_SETTINGS.seed,
    textLayer: v.textLayer !== false,
    look: v.look && typeof v.look === 'object' ? { ...v.look } : null,
  };
}

/**
 * Lay out the written pieces of `plan` on A4 pages.  written[i] is preparePiece()'s
 * result for piece i or missing; the layout stops at the first missing piece (the
 * page fills in from the start of the text while the rest is written).
 *
 * o.gapXh: the writer's word gap [mean, sd] in xh (model.json gap_xh);
 * o.sizeByBias: model.json size_by_bias; o.typical: the typical size estimate to
 * even towards, default typicalSize(written).  Keep doc.typical when a piece is
 * rewritten (relayoutDocument), so that nothing before it moves.
 *
 * Returns { settings, page: { width, height }, geometry, typical, total, placed, complete, pages: [{ strokes, words }], pieces }:
 * strokes = one Float32Array [x, y, penUp, ...] in mm per word; words = { text, typed, piece,
 * word, line, x, width, baseline, box: [x0, y0, x1, y1], ok }; pieces[i] = { page,
 * line, scale } for the pieces laid out.
 */
export function layoutDocument(plan, written, settings, { gapXh = [2.9, 0.8], sizeByBias = null, typical } = {}) {
  const s = normalizeSettings(settings);
  const g = paperGeometry(s.paper, s.size);
  const typ = typical !== undefined && typical !== null ? typical : typicalSize(written);
  const unit = g.xh * sizeScale(sizeByBias, s.bias);   // mm per xh of the ink
  const gapMm = (z) => g.xh * Math.min(1.6 * gapXh[0], Math.max(0.6 * gapXh[0], gapXh[0] + gapXh[1] * z));
  const width = g.right - g.left;
  const pages = [], pieces = [];
  let page = null, line = 0, right = null, fresh = true, placed = 0, stop = false;

  const newPage = () => { page = { strokes: [], words: [] }; pages.push(page); line = 0; };
  const advance = () => {           // the next line; an empty one never opens a page
    right = null;
    if (fresh) return;
    line++;
    if (line >= g.baselines.length) { page = null; fresh = true; }
  };
  const lineStart = (index, k) => {
    const z = makeRandom(pieceSeed(s.seed ^ LAYOUT_SALT, index, k + 1)).normal();
    return g.left + Math.max(-JITTER_MAX, Math.min(JITTER_MAX, JITTER * z));
  };

  for (let k = 0; k < plan.paragraphs.length && !stop; k++) {
    if (k > 0) advance();
    for (const index of plan.paragraphs[k]) {
      const pc = written[index];
      if (!pc) { stop = true; break; }
      const z = makeRandom(pieceSeed(s.seed ^ LAYOUT_SALT, index, 0)).normal();
      const even = sizeCorrection(pc.estimate, typ);
      const scale = unit * even;
      let prevEnd = null, first = null;
      const typed = plan.pieces[index] && plan.pieces[index].typed;
      const typedOf = (w, wi) => (!typed ? w.text : typed.length === pc.words.length ? typed[wi] : pc.words.length === 1 ? typed.join(' ') : w.text);
      pc.words.forEach((w, wi) => {
        const gap = prevEnd === null ? gapMm(z) : g.xh * even * Math.min(1.8 * gapXh[0], Math.max(0.5 * gapXh[0], w.x0 - prevEnd));
        prevEnd = w.x1;
        let f = scale * w.size, wide = (w.x1 - w.x0) * f;
        if (wide > width) { f *= width / wide; wide = width; }    // a word longer than a line: smaller, on a line of its own
        let start = right === null ? null : right + gap;
        if (start !== null && start + wide > g.right) { advance(); start = null; }
        if (!page) newPage();
        if (start === null) start = Math.min(lineStart(index, wi), g.right - wide);
        fresh = false;
        const y = g.baselines[line];
        const p = w.points, q = new Float32Array(p.length);
        let y0 = Infinity, y1 = -Infinity;
        for (let i = 0; i < p.length; i += 3) {
          q[i] = (p[i] - w.x0) * f + start;
          q[i + 1] = (p[i + 1] - w.level) * f + y;
          q[i + 2] = p[i + 2];
          if (q[i + 1] < y0) y0 = q[i + 1];
          if (q[i + 1] > y1) y1 = q[i + 1];
        }
        if (q.length) q[q.length - 1] = 1;
        page.strokes.push(q);
        page.words.push({ text: w.text, typed: typedOf(w, wi), piece: index, word: wi, line, x: start, width: wide, baseline: y, box: [start, y0, start + wide, y1], ok: pc.ok });
        if (!first) first = { page: pages.length - 1, line };
        right = start + wide;
      });
      pieces[index] = { page: first ? first.page : pages.length - 1, line: first ? first.line : line, scale: even };
      placed++;
    }
  }
  return { settings: s, page: { ...PAGE }, geometry: g, typical: typ, total: plan.pieces.length, placed, complete: placed === plan.pieces.length, pages, pieces };
}

/** The document again after written[index] was replaced (a rewrite): the same
 *  typical size, so the pieces before it stay exactly where they were. */
export function relayoutDocument(doc, plan, written, o = {}) {
  return layoutDocument(plan, written, doc.settings, { ...o, typical: doc.typical });
}

/** The word under a point (mm) of page `pageIndex`: { word, piece, index } or null.
 *  `reach` (mm) widens every word's box, for a finger. */
export function wordAt(doc, pageIndex, x, y, reach = 2.5) {
  const page = doc.pages[pageIndex];
  if (!page) return null;
  let best = null, bestD = Infinity;
  page.words.forEach((w, i) => {
    const [x0, y0, x1, y1] = w.box;
    const top = Math.min(y0, w.baseline - doc.geometry.xh), bottom = Math.max(y1, w.baseline);
    const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0, dy = y < top ? top - y : y > bottom ? y - bottom : 0;
    const d = Math.hypot(dx, dy);
    if (d <= reach && d < bestD) { best = { word: w, piece: w.piece, index: i }; bestD = d; }
  });
  return best;
}

/** The boxes (mm) of the words of piece `index` on each page: [{ page, box }], for
 *  marking it. */
export function pieceBoxes(doc, index) {
  const out = [];
  doc.pages.forEach((page, p) => {
    for (const w of page.words) {
      if (w.piece !== index) continue;
      const last = out[out.length - 1];
      const top = Math.min(w.box[1], w.baseline - doc.geometry.xh);
      if (last && last.page === p && last.line === w.line) {
        last.box = [Math.min(last.box[0], w.box[0]), Math.min(last.box[1], top), Math.max(last.box[2], w.box[2]), Math.max(last.box[3], w.box[3])];
      } else out.push({ page: p, line: w.line, box: [w.box[0], top, w.box[2], w.box[3]] });
    }
  });
  return out;
}

/** The text of the document as laid out (for the PDF's text layer): per page, the
 *  lines with their words. */
export function pageLines(page) {
  const lines = new Map();
  for (const w of page.words) { if (!lines.has(w.line)) lines.set(w.line, []); lines.get(w.line).push(w); }
  return [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, ws]) => ws);
}
