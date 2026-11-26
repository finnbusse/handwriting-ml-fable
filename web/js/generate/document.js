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
import { splitPieces, straighten, toXh, levelledWords, wordLevel, strokeRanges, strokeSize, sizeScale, MAX_PIECE_CHARS, LEVEL_KEEP, SHORT_PIECE_CHARS } from './layout.js';
import * as decor from './decor.js';

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
  if (text && typeof text === 'object' && Array.isArray(text.blocks)) return planRich(text, normalize);
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
  if (plan.rich) return layoutRich(plan, written, settings, { gapXh, sizeByBias, typical });
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

// ---------- documents with structure: headings, lists, boxes, styles ----------
//
// planDocument(doc) takes the document model of markup.js ({ format, blocks: [{ type,
// level, marker, align, box, lines: [[span]] }], notes }) and returns a plan with
// rich: true; layoutDocument then lays it out with layoutRich below.  A document of
// plain paragraphs gives the same pieces, seeds and positions as its text would.

const BLOCK_TYPES = ['paragraph', 'heading', 'item', 'rule', 'pagebreak', 'blank'];
const MARKERS = ['bullet', 'number', 'check', 'checked'];
const ARROWS = ['right', 'left', 'both', 'double'];
const PARTS = ['center', 'right'];
const partOf = (t) => ({ ...(t.part ? { part: t.part } : {}), ...(t.body ? { body: true } : {}) });
const ARROW_TEXT = { right: '->', left: '<-', both: '<->', double: '=>' };
// list markers in the PDF's text layer, in WinAnsi so that they copy as typed
const MARKER_TEXT = { bullet: '-', check: '[ ]', checked: '[x]' };
// A run of words in one style this long (characters, inner spaces included) gets
// piece borders of its own, so its decoration lands exactly even where a piece
// cannot be cut into words.  Shorter runs stay inside a piece: a piece of 3
// characters or fewer writes badly (layout.js: SHORT_PIECE_CHARS).
export const STYLED_RUN_CHARS = 4;

function cleanStyle(sp) {
  const s = {};
  if (sp.bold) s.bold = true;
  if (sp.underline) s.underline = true;
  if (sp.strike) s.strike = true;
  if (sp.mark) s.mark = decor.MARKER_NAMES.includes(sp.mark) ? sp.mark : 'gelb';
  if (sp.color && decor.COLOR_NAMES.includes(sp.color)) s.color = sp.color;
  return s;
}
const styleKey = (s) => `${s.bold ? 'b' : ''}${s.underline ? 'u' : ''}${s.strike ? 's' : ''}|${s.mark || ''}|${s.color || ''}`;
const WORDISH = /[\p{L}\p{N}]/u;

/** The style most of a word's letters have. */
function dominant(chars, ids) {
  const n = new Map();
  chars.forEach((c, i) => { if (WORDISH.test(c)) n.set(ids[i], (n.get(ids[i]) || 0) + 1); });
  let best = ids[0], bn = 0;
  for (const [id, k] of n) if (k > bn) { best = id; bn = k; }
  return best;
}

function planRich(doc, normalize) {
  const styles = [{}], ids = new Map([[styleKey({}), 0]]);
  const sid = (sp) => { const s = cleanStyle(sp); const k = styleKey(s); if (!ids.has(k)) { ids.set(k, styles.length); styles.push(s); } return ids.get(k); };
  // A space carries what both its neighbours carry: an underline goes on under it, a colour does not matter.
  const between = (a, b) => { const x = styles[a], y = styles[b]; return sid({ underline: x.underline && y.underline, strike: x.strike && y.strike, mark: x.mark === y.mark ? x.mark : null, color: x.color === y.color ? x.color : null }); };
  const blocks = [], lines = [], paragraphs = [], pieces = [];
  const stats = { runs: 0, longRuns: 0, longOnBorders: 0, shortRuns: 0, shortInPieces: 0 };
  for (const [bi, b0] of (doc.blocks || []).entries()) {
    const b = b0 && typeof b0 === 'object' ? b0 : {};
    const type = BLOCK_TYPES.includes(b.type) ? b.type : 'paragraph';
    const blk = {
      type, level: Math.min(3, Math.max(1, Math.round(Number(b.level) || 1))),
      marker: type === 'item' ? (MARKERS.includes(b.marker) ? b.marker : 'bullet') : null,
      align: b.align === 'center' || b.align === 'right' ? b.align : 'left',
      box: Number.isFinite(b.box) ? b.box : null, lines: [],
    };
    blocks.push(blk);
    const rows = ['rule', 'pagebreak', 'blank'].includes(type) ? [null] : (Array.isArray(b.lines) && b.lines.length ? b.lines : [[]]);
    for (const spans of rows) {
      const k = lines.length;
      const line = { block: bi, kind: spans === null ? type : 'text', chars: [], sty: [], items: [] };
      blk.lines.push(k); lines.push(line); paragraphs.push([]);
      if (spans === null) continue;
      // words (split at spaces and arrows) with the style of every character
      // (and the part of the line it stands in: a part border is a word border)
      const toks = [];
      let cur = null, prevPart = '';
      for (const sp of Array.isArray(spans) ? spans : []) {
        if (!sp || typeof sp !== 'object') continue;
        const part = PARTS.includes(sp.part) ? { part: sp.part } : {};
        if (sp.body && type === 'heading') part.body = true;
        const pk = `${part.part || ''}|${part.body ? 1 : 0}`;
        if (pk !== prevPart) { cur = null; prevPart = pk; if (pk !== '|0') line.parts = true; }
        if (sp.arrow) { cur = null; toks.push({ arrow: ARROWS.includes(sp.arrow) ? sp.arrow : 'right', s: sid(sp), ...part }); continue; }
        const s = sid(sp);
        for (const ch of String(sp.text ?? '')) {
          if (/\s/u.test(ch)) { cur = null; continue; }
          if (!cur) { cur = { typed: '', cs: [], ...part }; toks.push(cur); }
          cur.typed += ch; cur.cs.push(s);
        }
      }
      const items = [];
      for (const t of toks) {
        if (t.arrow) { items.push(t); continue; }
        const parts = normalize(t.typed).split(' ').filter(Boolean);
        if (!parts.length) continue;
        // each typed character's own normal form tells which written characters it became
        const per = [];
        [...t.typed].forEach((ch, i) => { for (const _ of normalize(ch).replaceAll(' ', '')) per.push(t.cs[i]); });
        const n = [...parts.join('')].length;
        const cs = per.length === n ? per : new Array(n).fill(dominant([...t.typed], t.cs));
        let at = 0;
        for (const p of parts) { const m = [...p].length; items.push({ text: p, typed: parts.length === 1 ? t.typed : p, cs: cs.slice(at, at + m), part: t.part, body: t.body }); at += m; }
      }
      items.forEach((it, i) => {
        if (i > 0) { const p = items[i - 1]; line.chars.push(' '); line.sty.push(between(p.arrow ? p.s : p.cs[p.cs.length - 1], it.arrow ? it.s : it.cs[0])); }
        it.at = line.chars.length;
        if (it.arrow) { line.chars.push('→'); line.sty.push(it.s); } else { line.chars.push(...it.text); line.sty.push(...it.cs); it.dom = dominant([...it.text], it.cs); }
      });
      // pieces: an arrow and a long styled run are piece borders, but a stretch of 3
      // characters or fewer joins its neighbour, across an arrow too ("A -> B" is the
      // piece "A B"): the layout cuts the written piece there again
      const seg = [], arrowsBefore = [];
      for (const it of items) if (it.arrow) (arrowsBefore[seg.length] ||= []).push(it); else seg.push(it);
      // A part border is a piece border as an arrow is, a part of 3 characters or
      // fewer ("7b") written with its neighbour and cut off again by the layout.
      const border = new Array(seg.length + 1).fill(false), runs = [];
      const partStart = seg.map((w, i) => i > 0 && (w.part !== seg[i - 1].part || w.body !== seg[i - 1].body));
      for (let i = 1; i < seg.length; i++) if (arrowsBefore[i] || partStart[i]) border[i] = true;
      for (let i = 0; i < seg.length;) {
        let j = i;
        while (j + 1 < seg.length && seg[j + 1].dom === seg[i].dom && !arrowsBefore[j + 1] && !partStart[j + 1]) j++;
        if (seg[i].dom !== 0) {
          const len = seg.slice(i, j + 1).reduce((s, w) => s + [...w.text].length, 0) + j - i;
          runs.push([i, j + 1, len >= STYLED_RUN_CHARS]);
          if (len >= STYLED_RUN_CHARS) { border[i] = true; border[j + 1] = true; }
        }
        i = j + 1;
      }
      const chunks = [];
      seg.forEach((w, i) => { if (i === 0 || border[i]) chunks.push([]); chunks[chunks.length - 1].push(w); });
      const clen = (c) => c.reduce((s, w) => s + [...w.text].length, 0) + c.length - 1;
      // a chunk of 3 characters or fewer joins the next one (the last one the one before)
      for (let c = 0; c < chunks.length && chunks.length > 1;) {
        if (clen(chunks[c]) > SHORT_PIECE_CHARS) { c++; continue; }
        if (c + 1 < chunks.length) chunks.splice(c, 2, [...chunks[c], ...chunks[c + 1]]);
        else { chunks.splice(c - 1, 2, [...chunks[c - 1], ...chunks[c]]); break; }
      }
      // the label of a numbered item ("1.", "a)") is written with its text but placed on its own
      const label = blk.marker === 'number' && blk.lines.length === 1 && seg.length > 1;
      const starts = new Set(), where = [];
      let wi = 0;
      for (const chunk of chunks) {
        for (const t of splitPieces(chunk.map((w) => w.text).join(' '), MAX_PIECE_CHARS)[0]) {
          const n = t.split(' ').length, ws = seg.slice(wi, wi + n), pc = { index: pieces.length, text: t, para: k, typed: ws.map((w) => w.typed), block: bi, at: ws[0].at };
          const cuts = [];
          for (let j = 1; j < n; j++) if (arrowsBefore[wi + j] || partStart[wi + j] || (label && wi + j === 1)) cuts.push(j);
          if (cuts.length) { pc.ats = ws.map((w) => w.at); pc.cuts = cuts; }
          starts.add(wi);
          ws.forEach((_, j) => { where[wi + j] = [pieces.length, j]; });
          pieces.push(pc);
          paragraphs[k].push(pc.index);
          wi += n;
        }
      }
      starts.add(seg.length);
      for (const [i, j, long] of runs) {
        const on = starts.has(i) && starts.has(j);
        stats.runs++;
        if (long) { stats.longRuns++; if (on) stats.longOnBorders++; } else { stats.shortRuns++; if (!on) stats.shortInPieces++; }
      }
      // the line's items in order: arrows, and the words of a piece between them
      let open = null;
      for (let i = 0; i <= seg.length; i++) {
        if (arrowsBefore[i]) { open = null; for (const a of arrowsBefore[i]) line.items.push({ arrow: a.arrow, at: a.at, s: a.s, ...partOf(a) }); }
        if (i === seg.length) break;
        const [pi, j] = where[i];
        if (open && open.piece === pi && !(label && i === 1) && !partStart[i]) open.to = j + 1;
        else { open = { piece: pi, from: j, to: j + 1, ...partOf(seg[i]) }; if (label && i === 0) open.label = true; line.items.push(open); }
      }
    }
  }
  // Trailing empty lines and page breaks write nothing.
  const empty = (l) => l.kind === 'blank' || l.kind === 'pagebreak' || (l.kind === 'text' && !l.items.length && blocks[l.block].type !== 'item');
  while (lines.length && empty(lines[lines.length - 1])) { lines.pop(); paragraphs.pop(); }
  for (const blk of blocks) blk.lines = blk.lines.filter((k) => k < lines.length);
  return { rich: true, format: doc.format || 'markdown', paragraphs, pieces, lines, blocks, styles, stats, notes: Array.isArray(doc.notes) ? doc.notes.slice() : [] };
}

// Block geometry in x-heights of the page, chosen by looking at proof pages.
export const H1_SCALE = 1.45;            // a title is written this much larger
export const INDENT = 4.2;               // one list level
export const BULLET_ADVANCE = 2.6;       // bullet to text
export const CHECK_ADVANCE = 4.8;        // check box (decor.js: CHECK_SIZE 2.8) to text
export const BOX_PAD = [1.6, 0.6];       // frame to text: sideways, and the least above / below the ink
// A frame runs this share of the line pitch above its first and below its last
// row, measured from 0.7 x-heights over the baseline (the middle of the writing),
// so the room inside is even above and below whatever the letters reach.
export const BOX_REACH = 0.65;
const BOX_MID = 0.7;
// ... but never further than this share of the pitch from the baselines of its first
// and last rows: a quarter line past the ruling of the empty line around the box,
// so the frame stays clear of the writing beyond it.
const BOX_ROOM = 1.25;
const LABEL_SIT_MAX = 6;                 // xh: a list label written up to a ruled line (5.6 xh) off is set back on it
const ALIGN_JITTER = 0.25;               // mm: a centred line is centred by eye
// The parts of a line (left, centre, right) share a row when this many letter widths
// stay clear between them; else each takes rows of its own.
export const PART_GAP = 3;
// A title that shares its row with a date is written smaller, step by step down to
// body size, when it would not fit centred at its full size: on a notebook page date
// and title belong on one line, and a long title is simply written less large.
export const TITLE_FIT = [1.3, 1.15, 1];
const ARROW_SALT = 0x68E31DA4, MARK_SALT = 0x1B873593;
const NARROW = new Set([...'iljtfrI1.,:;!|\'']), WIDE = new Set([...'mwMW']);
const charWeight = (c) => (c === ' ' ? 1.6 : NARROW.has(c) ? 0.55 : WIDE.has(c) ? 1.5 : /\p{Lu}/u.test(c) ? 1.2 : 1);

/** Lay out a structured plan (planRich).  Same return shape as layoutDocument, plus
 *  rich: true, blocks, styles, notes, stats, and per page styles (one per stroke),
 *  bands, arrows and frames; see SPEC 2.5.3. */
function layoutRich(plan, written, settings, { gapXh, sizeByBias, typical }) {
  const s = normalizeSettings(settings);
  const g = paperGeometry(s.paper, s.size);
  const typ = typical !== undefined && typical !== null ? typical : typicalSize(written);
  const unit = g.xh * sizeScale(sizeByBias, s.bias);
  const gapMm = (z) => g.xh * Math.min(1.6 * gapXh[0], Math.max(0.6 * gapXh[0], gapXh[0] + gapXh[1] * z));
  const normal = (salt, a, b) => makeRandom(pieceSeed((s.seed ^ LAYOUT_SALT ^ salt) >>> 0, a, b)).normal();
  const jitter = (z) => Math.max(-JITTER_MAX, Math.min(JITTER_MAX, JITTER * z));
  const stats = { guessed: 0, inWord: 0, cut: 0, uncut: 0 };

  // 1. rows: every line of every block cut into rows of the text width
  const rows = [];
  let placed = 0, stop = false, prevBox = null;
  const space = (n) => {
    let have = 0;
    for (let i = rows.length - 1; i >= 0 && rows[i].kind === 'blank'; i--) have++;
    for (; have < n && rows.length; have++) rows.push({ kind: 'blank', block: -1, box: null });
  };
  const lastText = () => { for (let i = rows.length - 1; i >= 0; i--) if (rows[i].kind !== 'blank') return rows[i]; return null; };

  // gr: one part of a line in parts ({ part, body, items }), laid out as a line of its own
  const flowLine = (k, blk, bi, first, gr = null) => {
    const line = plan.lines[k];
    const head = blk.type === 'heading' && !(gr && gr.body), align = gr ? gr.part : blk.align;
    const f0 = head && blk.level === 1 ? (gr && gr.scale) || H1_SCALE : 1, u = g.xh * f0;
    const part = gr ? { part: gr.part, body: gr.body } : {};
    const pad = blk.box !== null ? BOX_PAD[0] * g.xh : 0;
    const L = g.left + pad + (blk.type === 'item' ? (blk.level - 1) * INDENT * g.xh : 0), R = g.right - pad;
    let row = null, right = null, rowLeft = L, fixed = null;
    const finish = () => {
      if (align === 'left' || !row.items.length) return;
      let lo = Infinity, hi = -Infinity;
      for (const it of row.items) { lo = Math.min(lo, it.x); hi = Math.max(hi, it.x + it.wide); }
      const z = Math.max(-ALIGN_JITTER, Math.min(ALIGN_JITTER, 0.12 * normal(MARK_SALT, k, rows.length)));
      const shift = align === 'center' ? (L + R) / 2 - (lo + hi) / 2 + z : R - Math.abs(z) - hi;
      for (const it of row.items) it.x += shift;
    };
    const newRow = () => {
      if (row) finish();
      // a title written large needs two ruled lines a row, or its rows run into each other
      if (row && f0 > 1) rows.push({ kind: 'blank', block: bi, box: blk.box });
      row = { kind: 'text', block: bi, k, box: blk.box, size: f0, heading: head ? blk.level : 0, keep: blk.type === 'heading', L, R, items: [] };
      rows.push(row); right = null;
    };
    newRow();
    if (blk.type === 'item') {
      if (first && blk.marker !== 'number') {
        const x = L + jitter(normal(MARK_SALT, k, 0));
        const adv = (blk.marker === 'bullet' ? BULLET_ADVANCE : CHECK_ADVANCE) * g.xh;
        row.items.push({ kind: 'marker', marker: blk.marker, level: blk.level, x, wide: blk.marker === 'bullet' ? 0.4 * g.xh : decor.CHECK_SIZE * g.xh, at0: -1, at1: -1 });
        fixed = x + adv;
      }
      if (blk.hang !== undefined) rowLeft = blk.hang; else if (blk.marker !== 'number') blk.hang = rowLeft = (fixed ?? L + BULLET_ADVANCE * g.xh);
    }
    const startAt = (z, wide) => { const x = fixed !== null ? fixed : rowLeft + jitter(z); fixed = null; return Math.min(x, R - wide); };
    // A numbered item hangs after its label: at its list's text column when the label
    // stands apart, else where the first word after the label starts.
    const numberHang = () => {
      if (blk.marker !== 'number' || blk.hang !== undefined) return;
      const words = row.items.filter((it) => it.kind === 'word');
      const lab = words[0];
      if (!lab) return;
      if (lab.label && column.has(bi)) { blk.hang = Math.max(column.get(bi), lab.x + lab.wide + 0.5 * gapMm(0)); return; }
      const n = [...plan.pieces[lab.index].text.split(' ')[0]].length;
      if (lab.at1 > lab.at0 + n) blk.hang = charX(lab, lab.at0 + n + 1, false);     // the label inside a piece written as one
      else blk.hang = words[1] ? words[1].x : lab.x + lab.wide + gapMm(0);
    };
    const overflow = () => {
      numberHang();
      newRow();
      rowLeft = blk.hang !== undefined ? blk.hang : L;
    };
    for (const it of gr ? gr.items : line.items) {
      if (it.arrow) {
        const wide = decor.ARROW_LENGTH[it.arrow] * u;
        let start = right === null ? null : right + gapMm(normal(ARROW_SALT, k, it.at)) * f0;
        if (start !== null && start + wide > R) { overflow(); start = null; }
        if (start === null) start = startAt(normal(ARROW_SALT, k, it.at + 1), wide);
        row.items.push({ kind: 'arrow', arrow: it.arrow, s: it.s, at0: it.at, at1: it.at + 1, x: start, wide, k, ...part });
        right = start + wide;
        continue;
      }
      const index = it.piece, pc = written[index], pl = plan.pieces[index];
      if (!pc) { stop = true; break; }
      const z = makeRandom(pieceSeed(s.seed ^ LAYOUT_SALT, index, 0)).normal();
      const even = sizeCorrection(pc.estimate, typ);
      const scale = unit * even * f0;
      let prevEnd = null;
      const typed = pl.typed;
      const typedOf = (un) => (!typed ? un.w.text : typed.slice(un.from, un.to).join(' '));
      const all = unitsOf(index), last = all[all.length - 1].to;
      const to = it.to ?? last;
      for (const un of all) {
        if (un.from < (it.from ?? 0) || un.from >= to) continue;
        const w = un.w, wi = un.from, isLabel = !!it.label && un.from === 0 && un.to === 1;
        const gap = prevEnd === null ? gapMm(z) * f0 : g.xh * even * f0 * Math.min(1.8 * gapXh[0], Math.max(0.5 * gapXh[0], w.x0 - prevEnd));
        prevEnd = w.x1;
        let f = scale * w.size, wide = (w.x1 - w.x0) * f;
        const avail = R - (blk.hang !== undefined ? blk.hang : L);
        if (wide > avail) { f *= avail / wide; wide = avail; }
        let start = right === null ? null : right + gap;
        if (start !== null && start + wide > R) { overflow(); start = null; }
        if (start === null) start = startAt(makeRandom(pieceSeed(s.seed ^ LAYOUT_SALT, index, wi + 1)).normal(), wide);
        const n = [...w.text].length, at = pl.ats ? pl.ats[un.from] : pl.at + [...pl.text.split(' ').slice(0, un.from).join(' ')].length + (un.from ? 1 : 0);
        row.items.push({ kind: 'word', w, wi, index, f, x: start, wide, at0: at, at1: at + n, chars: line.chars.slice(at, at + n), typed: typedOf(un), ok: pc.ok, k, label: isLabel, ...part });
        right = start + wide;
        // the text after a label starts at its list's column
        if (isLabel && column.has(bi) && first) { numberHang(); right = null; fixed = blk.hang; }
      }
      if (to === last) { evens[index] = even; placed++; }
    }
    if (first) numberHang();
    finish();
    row.last = true;
  };
  const evens = [];

  // A line in parts: every part laid out on rows of its own, as a line of its
  // alignment; when each took one row and they keep PART_GAP letter widths apart, they
  // share one row, else they stay on their rows in reading order, a title written
  // large an empty line apart from its neighbours.  A centred part is never moved off
  // the middle to make room: titles pushed aside by 5-18 mm read as "after the date",
  // not as centred.  A level-1 title that does not fit at its full size is tried at
  // the sizes of TITLE_FIT first (this hand writes "Die Weimarer Republik" 112 mm wide
  // at full size, the date 32 mm, on 175 mm of text width: it shares the row at 1.15);
  // one that fits at none of them takes rows of its own at full size.
  // Shown only once all of the line is written, so that nothing moves when its last
  // piece arrives.
  const flowParts = (k, blk, bi) => {
    const groups = [];
    for (const it of plan.lines[k].items) {
      const part = it.part || 'left', body = !!it.body, last = groups[groups.length - 1];
      if (last && last.part === part && last.body === body) last.items.push(it); else groups.push({ part, body, items: [it] });
    }
    const r0 = rows.length, placed0 = placed;
    // every part laid out at the given title size; null when the line is not written
    // yet or has one part only (its rows then stand as laid out)
    const lay = (scale) => {
      rows.length = r0; placed = placed0;
      const made = groups.map((gr) => { const a = rows.length; flowLine(k, blk, bi, true, { ...gr, scale }); return rows.slice(a); });
      if (stop || made.length < 2) return null;
      const parts = made.map((rs, i) => {
        const its = rs.flatMap((r) => r.items || []);
        return { part: groups[i].part, rows: rs, items: its, size: rs[0].size, lo: Math.min(...its.map((it) => it.x)), hi: Math.max(...its.map((it) => it.x + it.wide)) };
      });
      // a letter width of the writing at body size: the parts' own words
      let wide = 0, chars = 0;
      for (const p of parts) for (const it of p.items) if (it.kind === 'word') { wide += it.wide / p.size; chars += it.at1 - it.at0; }
      const gap = PART_GAP * (chars ? wide / chars : g.xh);
      return { parts, fits: parts.every((p, i) => p.rows.length === 1 && (!i || parts[i - 1].hi + gap <= p.lo + 1e-9)) };
    };
    let res = lay(H1_SCALE);
    if (stop) { rows.length = r0; placed = placed0; return; }
    if (!res) return;
    if (!res.fits && blk.type === 'heading' && blk.level === 1 && groups.some((gr) => !gr.body)) {
      for (const scale of TITLE_FIT) { const r = lay(scale); if (r && r.fits) { res = r; break; } }
      if (!res.fits) res = lay(H1_SCALE);
    }
    const { parts, fits } = res;
    rows.length = r0;
    if (fits) {
      const first = parts[0].rows[0];
      const items = parts.flatMap((p) => p.items.map((it) => ({ ...it, sz: p.size })));
      rows.push({ ...first, size: Math.max(...parts.map((p) => p.size)), heading: blk.type === 'heading' ? blk.level : 0, items, parts: true, last: true });
      return;
    }
    parts.forEach((p, i) => {
      if (i && (p.size > 1 || parts[i - 1].size > 1)) rows.push({ kind: 'blank', block: bi, box: blk.box });
      rows.push(...p.rows);
    });
  };

  // What of a written piece is placed on its own: its words, or, where the network
  // wrote it as one, the whole piece cut again only where the plan needs a border
  // (an arrow, a list label) at the clearest gap in the ink near where the letters
  // should end.
  const unitCache = new Map();
  function unitsOf(index) {
    if (unitCache.has(index)) return unitCache.get(index);
    const pc = written[index], pl = plan.pieces[index], n = pl.text.split(' ').length;
    let out;
    if (pc.words.length === n) out = pc.words.map((w, i) => ({ w, from: i, to: i + 1 }));
    else {
      out = [{ w: pc.words[0], from: 0, to: n }];
      for (const c of pl.cuts || []) {
        const last = out[out.length - 1], parts = cutWord(last.w, c - last.from);
        if (parts) out.splice(out.length - 1, 1, { w: parts[0], from: last.from, to: c }, { w: parts[1], from: c, to: n });
        else stats.uncut++;
      }
    }
    // A number label ("3.") sits on the line by the lowest point of its digits: the
    // network often writes it low or high, and sitLine reads the inner turns of a 3
    // or a 5 as letter bottoms (on proof pages it set "3." 2.7 xh too low).
    if (pl.cuts && plan.blocks[pl.block].marker === 'number' && out[0].to === 1 && /^\d+[.)]?$/u.test(out[0].w.text)) {
      const w = out[0].w, p = w.points, size = strokeSize(p);
      let low = -Infinity;
      for (const [a, e] of strokeRanges(p)) {
        let len = 0, y = -Infinity;
        for (let i = a; i < e; i++) { if (i > a) len += Math.hypot(p[3 * i] - p[3 * i - 3], p[3 * i + 1] - p[3 * i - 2]); y = Math.max(y, p[3 * i + 1]); }
        if (len >= 0.3 * size) low = Math.max(low, y);                  // not the full stop
      }
      if (Number.isFinite(low) && Math.abs(low - w.level) <= LABEL_SIT_MAX) out[0] = { ...out[0], w: { ...w, level: low } };
    }
    unitCache.set(index, out);
    return out;
  }
  function cutWord(w, k) {
    const words = w.text.split(' '), before = words.slice(0, k).join(' ');
    if (!before || k >= words.length) return null;
    let wb = 0, total = 0;
    [...w.text].forEach((c, i) => { total += charWeight(c); if (i < [...before].length) wb += charWeight(c); });
    const est = w.x0 + ((w.x1 - w.x0) * (wb + 0.5 * charWeight(' '))) / total;
    const p = w.points, ranges = strokeRanges(p), ext = ranges.map(([a, e]) => { let lo = Infinity, hi = -Infinity; for (let i = a; i < e; i++) { lo = Math.min(lo, p[3 * i]); hi = Math.max(hi, p[3 * i]); } return [lo, hi]; });
    let cut = est, score = -Infinity, reach = ext.length ? ext[0][1] : 0;
    for (let i = 1; i < ext.length; i++) {
      if (ext[i][0] > reach) { const lo = reach, hi = ext[i][0], d = Math.abs((lo + hi) / 2 - est), sc = hi - lo - 0.5 * d; if (d < 3 && hi - lo > 0.2 && sc > score) { score = sc; cut = (lo + hi) / 2; } }
      reach = Math.max(reach, ext[i][1]);
    }
    const sides = [[], []];
    ranges.forEach(([a, e], i) => sides[(ext[i][0] + ext[i][1]) / 2 < cut ? 0 : 1].push(p.subarray(3 * a, 3 * e)));
    if (!sides[0].length || !sides[1].length) return null;
    stats.cut++;
    return [[before, sides[0]], [words.slice(k).join(' '), sides[1]]].map(([text, list]) => {
      const q = decor.joinStrokes(list);
      let x0 = Infinity, x1 = -Infinity;
      for (let i = 0; i < q.length; i += 3) { x0 = Math.min(x0, q[i]); x1 = Math.max(x1, q[i]); }
      return { ...w, text, points: q, x0, x1 };
    });
  }

  // A numbered list puts its text in one column: after its widest label (one per
  // run of items and level).
  const column = new Map();
  {
    let run = [];
    const flush = () => {
      const byLevel = new Map();
      for (const bi of run) { const b = plan.blocks[bi]; if (b.marker === 'number') { if (!byLevel.has(b.level)) byLevel.set(b.level, []); byLevel.get(b.level).push(bi); } }
      for (const [level, list] of byLevel) {
        let widest = -Infinity;
        for (const bi of list) {
          const it = plan.lines[plan.blocks[bi].lines[0]]?.items[0];
          if (!it || !it.label || !written[it.piece]) continue;
          const un = unitsOf(it.piece)[0];
          if (un.to !== 1) continue;
          widest = Math.max(widest, (un.w.x1 - un.w.x0) * unit * sizeCorrection(written[it.piece].estimate, typ) * un.w.size);
        }
        if (!Number.isFinite(widest)) continue;
        const pad = plan.blocks[list[0]].box !== null ? BOX_PAD[0] * g.xh : 0;
        const at = g.left + pad + (level - 1) * INDENT * g.xh + widest + gapMm(0);
        for (const bi of list) column.set(bi, at);
      }
      run = [];
    };
    plan.blocks.forEach((b, bi) => {
      if (b.type === 'item' && (!run.length || plan.blocks[run[0]].box === b.box)) run.push(bi);
      else if (b.type !== 'blank') { flush(); if (b.type === 'item') run.push(bi); }
    });
    flush();
  }

  for (let bi = 0; bi < plan.blocks.length && !stop; bi++) {
    const blk0 = plan.blocks[bi], blk = { ...blk0 };
    if (blk.box !== prevBox) { if (blk.type !== 'blank') space(1); prevBox = blk.box; }        // a box stands apart, an empty line typed there is enough
    const last = lastText(), lastBlk = last && plan.blocks[last.block];
    if (lastBlk && lastBlk.type === 'heading' && lastBlk.level === 1 && blk.type !== 'blank') space(1);       // a title stands apart from what follows
    if (blk.type === 'heading' && (blk.level === 1 || (blk.level === 2 && !(lastBlk && lastBlk.type === 'heading')))) space(1);
    blk.lines.forEach((k, li) => {
      if (stop) return;
      const line = plan.lines[k];
      if (line.kind === 'pagebreak') rows.push({ kind: 'break', block: bi, box: null });
      else if (line.kind === 'rule') rows.push({ kind: 'rule', block: bi, box: blk.box, size: 1, items: [] });
      else if (line.kind === 'blank' || (!line.items.length && blk.type !== 'item')) rows.push({ kind: 'blank', block: bi, box: blk.box });
      else if (line.parts) flowParts(k, blk, bi);
      else flowLine(k, blk, bi, li === 0);
    });
  }

  // 2. pages: a blank row never opens a page; a heading keeps its next row; a box
  //    that fits on a page is not split
  const nLines = g.baselines.length, pagesRows = [];
  let cur = null, line = 0, chainUntil = -1;
  const chainEnd = (r) => {
    let e = r;
    for (;;) {
      if (rows[e].box !== null && rows[e].kind !== 'break') while (e + 1 < rows.length && rows[e + 1].box === rows[e].box) e++;
      if (!rows[e].keep) return e;
      let n = e + 1;
      while (n < rows.length && rows[n].kind === 'blank') n++;
      if (n >= rows.length || rows[n].kind === 'break') return e;
      e = n;
    }
  };
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (row.kind === 'break') { cur = null; continue; }
    if (r > chainUntil && row.kind !== 'blank' && (row.keep || row.box !== null)) {
      let e = chainEnd(r);
      if (e - r + 1 > nLines && row.keep) { e = r; while (rows[e].keep && e + 1 < rows.length) e++; }
      if (e - r + 1 <= nLines) { if (cur && line + (e - r + 1) > nLines) cur = null; chainUntil = e; }
    }
    if (row.kind === 'blank' && !cur) continue;
    if (!cur) { cur = []; pagesRows.push(cur); line = 0; }
    row.page = pagesRows.length - 1; row.line = line; cur.push(row);
    if (++line >= nLines) cur = null;
  }

  // 3. ink: words in mm, their strokes split where the ink style changes, then
  //    everything drawn around them
  const styleAt = (k, off) => plan.styles[plan.lines[k].sty[off]] || {};
  const inkKey = (st, row, it) => `${st.color || ''}|${st.bold || (row.heading && !it.body) ? 1 : 0}`;
  function gaps(it) {
    const p = it.w.points, X = (i) => (p[3 * i] - it.w.x0) * it.f + it.x, ext = [];
    for (const [a, e] of strokeRanges(p)) { let lo = Infinity, hi = -Infinity; for (let i = a; i < e; i++) { lo = Math.min(lo, X(i)); hi = Math.max(hi, X(i)); } ext.push([lo, hi]); }
    const out = [];
    let reach = ext.length ? ext[0][1] : 0;
    for (let i = 1; i < ext.length; i++) { if (ext[i][0] > reach) out.push([reach, ext[i][0]]); reach = Math.max(reach, ext[i][1]); }
    return out;
  }
  /** x (mm) of the border before character `off` of a row's stream, inside item
   *  `it`.  At a word border inside a piece written as one: the clearest gap in the
   *  ink nearby, its left edge where a run ends, its right edge where one starts. */
  function charX(it, off, count = true) {
    if (off <= it.at0) return it.x;
    if (off >= it.at1) return it.x + it.wide;
    if (it.kind !== 'word') return it.x + (it.wide * (off - it.at0)) / (it.at1 - it.at0);
    let before = 0, total = 0;
    it.chars.forEach((c, i) => { const w = charWeight(c); total += w; if (i < off - it.at0) before += w; });
    const est = it.x + (it.wide * before) / total;
    const sp = it.chars[off - it.at0] === ' ' ? 'end' : it.chars[off - it.at0 - 1] === ' ' ? 'start' : null;
    if (count) stats[sp ? 'guessed' : 'inWord']++;
    if (!sp) return est;
    let best = null, score = -Infinity;
    for (const [lo, hi] of gaps(it)) {
      const d = Math.abs((lo + hi) / 2 - est), sc = hi - lo - 0.5 * d;
      if (d < 3 * g.xh && hi - lo > 0.2 * g.xh && sc > score) { best = [lo, hi]; score = sc; }
    }
    if (!best) return est;
    return sp === 'start' ? best[1] : best[0];
  }

  const pages = pagesRows.map(() => ({ strokes: [], words: [], styles: [], bands: [], arrows: [], markers: [], frames: [] }));
  const decoStrokes = pages.map(() => []), decoStyles = pages.map(() => []);
  const serial = new Map();
  const rngFor = (bi) => { const n = serial.get(bi) || 0; serial.set(bi, n + 1); return decor.decorRandom(s.seed, bi, n); };
  const addDeco = (p, list, style) => { for (const q of list) { decoStrokes[p].push(q); decoStyles[p].push(style); } };
  const pieces = [];
  for (const row of rows) {
    if (row.page === undefined || row.kind === 'blank') continue;
    // the parts of a row may differ in size (a title between body text): sz per item
    const P = pages[row.page], y = g.baselines[row.line], uOf = (it) => g.xh * (it.sz || row.size || 1);
    if (row.kind === 'rule') {
      const pad = row.box !== null ? BOX_PAD[0] * g.xh : 0;
      addDeco(row.page, decor.rule(rngFor(row.block), g.left + pad, g.right - pad, y - 0.5 * g.xh, g.xh), { color: null, bold: false, kind: 'rule' });
      continue;
    }
    for (const it of row.items) {
      if (it.kind === 'marker') {
        const rng = rngFor(row.block), sty = { color: null, bold: false, kind: it.marker === 'bullet' ? 'bullet' : 'check' };
        if (it.marker === 'bullet') addDeco(row.page, decor.bullet(rng, it.x, y, g.xh, it.level).strokes, sty);
        else {
          addDeco(row.page, decor.checkBox(rng, it.x, y, g.xh).strokes, sty);
          if (it.marker === 'checked') addDeco(row.page, decor.tick(rng, it.x, y, g.xh), { ...sty, kind: 'tick' });
        }
        const t = MARKER_TEXT[it.marker];
        P.markers.push({ text: t, typed: t, line: row.line, x: it.x, width: it.wide, baseline: y, block: row.block });
        continue;
      }
      if (it.kind === 'arrow') {
        const st = plan.styles[it.s] || {};
        addDeco(row.page, decor.arrow(rngFor(row.block), it.arrow, it.x, it.x + it.wide, y, uOf(it)), { color: st.color || null, bold: !!st.bold, kind: 'arrow' });
        P.arrows.push({ text: ARROW_TEXT[it.arrow], typed: ARROW_TEXT[it.arrow], line: row.line, x: it.x, width: it.wide, baseline: y, block: row.block });
        continue;
      }
      const { w, f } = it, p = w.points, q = new Float32Array(p.length);
      let y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < p.length; i += 3) {
        q[i] = (p[i] - w.x0) * f + it.x;
        q[i + 1] = (p[i + 1] - w.level) * f + y;
        q[i + 2] = p[i + 2];
        if (q[i + 1] < y0) y0 = q[i + 1];
        if (q[i + 1] > y1) y1 = q[i + 1];
      }
      if (q.length) q[q.length - 1] = 1;
      it.q = q; it.y0 = y0; it.y1 = y1;
      // the ink style of every character; strokes go by their middle
      const keys = it.chars.map((c, i) => inkKey(styleAt(it.k, it.at0 + i), row, it));
      for (let i = 0; i < keys.length; i++) if (it.chars[i] === ' ') keys[i] = keys[i - 1];
      const from = P.strokes.length;
      const changes = [];
      for (let i = 1; i < keys.length; i++) if (keys[i] !== keys[i - 1] && it.chars[i] !== ' ') changes.push(i);
      const styleOf = (key) => { const [c, b] = key.split('|'); return { color: c || null, bold: b === '1', kind: 'word' }; };
      if (!changes.length) { P.strokes.push(q); P.styles.push(styleOf(keys[0])); } else {
        const cuts = changes.map((i) => (it.chars[i - 1] === ' ' ? (charX(it, it.at0 + i - 1) + charX(it, it.at0 + i)) / 2 : charX(it, it.at0 + i)));
        let part = null, partKey = null;
        for (const [a, e] of strokeRanges(q)) {
          let lo = Infinity, hi = -Infinity;
          for (let i = a; i < e; i++) { lo = Math.min(lo, q[3 * i]); hi = Math.max(hi, q[3 * i]); }
          let c = 0;
          while (c < cuts.length && (lo + hi) / 2 > cuts[c]) c++;
          const key = keys[c ? changes[c - 1] : 0];
          if (key !== partKey) { if (part) { P.strokes.push(decor.joinStrokes(part)); P.styles.push(styleOf(partKey)); } part = []; partKey = key; }
          part.push(q.subarray(3 * a, 3 * e));
        }
        if (part) { P.strokes.push(decor.joinStrokes(part)); P.styles.push(styleOf(partKey)); }
      }
      const blk = plan.blocks[row.block];
      P.words.push({
        text: w.text, typed: it.typed, piece: it.index, word: it.wi, line: row.line, x: it.x, width: it.wide, baseline: y, box: [it.x, y0, it.x + it.wide, y1], ok: it.ok,
        block: row.block, frame: blk.box, size: it.sz || row.size, style: plan.styles[dominant(it.chars, it.chars.map((_, i) => plan.lines[it.k].sty[it.at0 + i]))], strokes: [from, P.strokes.length],
        ...(it.label ? { label: true } : {}),
      });
      if (pieces[it.index] === undefined) pieces[it.index] = { page: row.page, line: row.line, scale: evens[it.index] };
    }
    // decorations of the row's runs
    const seq = row.items.filter((it) => it.kind !== 'marker');
    const runs = (attr) => {
      const out = [];
      let cur = null, prev = null;
      for (const it of seq) {
        if (cur && prev && prev.part !== it.part) { out.push(cur); cur = null; }        // a run ends with its part
        if (cur && prev) for (let o = prev.at1; o < it.at0; o++) if ((styleAt(row.k, o)[attr] || null) !== cur.v) { out.push(cur); cur = null; break; }
        for (let o = it.at0; o < it.at1; o++) {
          const v = styleAt(row.k, o)[attr] || null;
          if (cur && v === cur.v) { cur.b = [it, o + 1]; continue; }
          if (cur) { out.push(cur); cur = null; }
          if (v) cur = { a: [it, o], b: [it, o + 1], v, color: styleAt(row.k, o).color || null };
        }
        prev = it;
      }
      if (cur) out.push(cur);
      return out.map((r) => ({ ...r, x0: charX(r.a[0], r.a[1]), x1: charX(r.b[0], r.b[1]) }));
    };
    if (!seq.length) continue;
    for (const r of runs('mark')) P.bands.push({ color: r.v, points: decor.markerBand(rngFor(row.block), r.x0, r.x1, y, uOf(r.a[0])), line: row.line, block: row.block });
    // a heading's line goes under its heading part only; the other parts are text
    const head = seq.filter((it) => !it.body);
    if ((row.heading === 1 || row.heading === 2) && head.length) {
      const lo = Math.min(...head.map((it) => it.x)), hi = Math.max(...head.map((it) => it.x + it.wide));
      addDeco(row.page, (row.heading === 1 && row.last ? decor.doubleUnderline : decor.underline)(rngFor(row.block), lo, hi, y, uOf(head[0])), { color: null, bold: false, kind: 'underline' });
    }
    if (!(row.heading === 1 || row.heading === 2) || row.parts) for (const r of runs('underline')) if (!row.heading || r.a[0].body) addDeco(row.page, decor.underline(rngFor(row.block), r.x0, r.x1, y, uOf(r.a[0])), { color: r.color, bold: false, kind: 'underline' });
    for (const r of runs('strike')) addDeco(row.page, decor.strike(rngFor(row.block), r.x0, r.x1, y, uOf(r.a[0])), { color: r.color, bold: false, kind: 'strike' });
  }

  // frames: one per box and page, around the ink of its rows
  pagesRows.forEach((list, p) => {
    const boxes = new Map();
    for (const row of list) if (row.box !== null && row.kind !== 'blank') { if (!boxes.has(row.box)) boxes.set(row.box, []); boxes.get(row.box).push(row); }
    for (const [box, rs] of boxes) {
      let top = Infinity, bot = -Infinity, right = -Infinity, inkTop = Infinity, inkBot = -Infinity;
      for (const row of rs) {
        const y = g.baselines[row.line] - BOX_MID * g.xh * (row.size || 1);
        top = Math.min(top, y - BOX_REACH * g.pitch); bot = Math.max(bot, y + BOX_REACH * g.pitch);
        for (const it of row.items) { right = Math.max(right, it.x + it.wide); if (it.q) { inkTop = Math.min(inkTop, it.y0); inkBot = Math.max(inkBot, it.y1); } }
        if (row.kind === 'rule') right = g.right - BOX_PAD[0] * g.xh;
      }
      // while a text is written a box's row can be there before any of its pieces: no frame yet
      if (right === -Infinity) continue;
      // as much room above the ink as below it, within the empty lines around the box
      // (a tall capital would otherwise leave the room above 0.9 mm, below 3.6 mm)
      if (inkTop <= inkBot) {
        const pad = Math.max(BOX_PAD[1] * g.xh, inkTop - top, bot - inkBot), y0 = g.baselines[rs[0].line], y1 = g.baselines[rs[rs.length - 1].line];
        top = Math.max(inkTop - pad, y0 - BOX_ROOM * g.pitch); bot = Math.min(inkBot + pad, y1 + BOX_ROOM * g.pitch);
      }
      const rect = [g.left, top, Math.min(g.right, right + BOX_PAD[0] * g.xh), bot];
      pages[p].frames.push({ box, rect });
      addDeco(p, decor.frame(decor.decorRandom(s.seed, 100000 + box, p), ...rect, g.xh), { color: null, bold: false, kind: 'frame' });
    }
  });
  pages.forEach((P, p) => { P.strokes.push(...decoStrokes[p]); P.styles.push(...decoStyles[p]); });
  return {
    settings: s, page: { ...PAGE }, geometry: g, typical: typ, total: plan.pieces.length, placed, complete: placed === plan.pieces.length, pages, pieces,
    rich: true, blocks: plan.blocks, styles: plan.styles, notes: plan.notes, stats: { ...plan.stats, ...stats },
  };
}
