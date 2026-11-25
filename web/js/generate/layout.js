// Page layout for generated handwriting: a port of hw/page.py and the parts of
// hw/prep.py / hw/dataset.py it relies on.  tests/engine/layout.test.mjs checks
// it against reference results from Python.
//
// An "ink" here is { text, points: Float32Array [x, y, eos, ...], ok } in xh
// units (1.0 = the writer's x-height, y pointing down).

export const MAX_PIECE_CHARS = 27;

const X = (p, i) => p[3 * i], Y = (p, i) => p[3 * i + 1], E = (p, i) => p[3 * i + 2];
const count = (p) => p.length / 3;

/** Text -> paragraphs -> pieces of whole words with at most maxChars characters. */
export function splitPieces(text, maxChars = MAX_PIECE_CHARS) {
  return text.replaceAll('\r', '').split('\n').map((para) => {
    const pieces = [];
    let cur = '';
    for (const word of para.split(/\s+/u).filter(Boolean)) {
      if (cur && [...cur].length + 1 + [...word].length > maxChars) { pieces.push(cur); cur = word; }
      else cur = cur ? `${cur} ${word}` : word;
    }
    if (cur) pieces.push(cur);
    return pieces;
  });
}

/** [start, end) index ranges of the strokes. */
export function strokeRanges(p) {
  const out = [];
  let start = 0;
  const n = count(p);
  for (let i = 0; i < n; i++) if (E(p, i) > 0.5) { out.push([start, i + 1]); start = i + 1; }
  if (start < n) out.push([start, n]);
  return out;
}

function percentile(values, q) {
  const v = [...values].sort((a, b) => a - b);
  if (v.length === 1) return v[0];
  const pos = (q / 100) * (v.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}
const median = (values) => percentile(values, 50);

/** Lowest points (largest y) of one stroke, ignoring wiggles smaller than delta. */
function bottomsOf(p, s, e, delta) {
  const bottoms = [];
  let lo = s, hi = s, dir = 0;
  for (let i = s + 1; i < e; i++) {
    const y = Y(p, i);
    if (dir === 0) {
      if (y > Y(p, hi)) hi = i;
      if (y < Y(p, lo)) lo = i;
      if (Y(p, hi) - Y(p, lo) > delta) {
        if (hi > lo) dir = 1; else { bottoms.push(hi); dir = -1; }
      }
    } else if (dir === 1) {
      if (y > Y(p, hi)) hi = i;
      else if (Y(p, hi) - y > delta) { bottoms.push(hi); dir = -1; lo = i; }
    } else {
      if (y < Y(p, lo)) lo = i;
      else if (y - Y(p, lo) > delta) { dir = 1; hi = i; }
    }
  }
  if (dir === 1) bottoms.push(hi);
  return bottoms;
}

function kdeMode(values, bw) {
  if (values.length === 1) return values[0];
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  let best = -1, bestG = lo;
  for (let k = 0; k < 200; k++) {
    const g = lo + (hi - lo) * (k / 199);
    let d = 0;
    for (const v of values) { const t = (g - v) / bw; d += Math.exp(-0.5 * t * t); }
    if (d > best) { best = d; bestG = g; }
  }
  return bestG;
}

/** Robust baseline y = a*x + b of a written piece (hw/prep.py: baseline, kind "line"). */
export function baseline(p) {
  const ranges = strokeRanges(p);
  const heights = ranges.map(([s, e]) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = s; i < e; i++) { const y = Y(p, i); if (y < lo) lo = y; if (y > hi) hi = y; }
    return hi - lo;
  });
  const size = Math.max(percentile(heights, 90), 1e-6) * 1.3;
  const delta = 0.08 * size, bw = 0.07 * size;
  const bx = [], by = [];
  for (const [s, e] of ranges) {
    if (e - s < 3) continue;
    let len = 0;
    for (let i = s + 1; i < e; i++) len += Math.hypot(X(p, i) - X(p, i - 1), Y(p, i) - Y(p, i - 1));
    if (len < 0.3 * size) continue;                  // dots and short dashes say nothing about the baseline
    for (const i of bottomsOf(p, s, e, delta)) { bx.push(X(p, i)); by.push(Y(p, i)); }
  }
  const n = count(p);
  let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) { const x = X(p, i); if (x < minX) minX = x; if (x > maxX) maxX = x; if (Y(p, i) > maxY) maxY = Y(p, i); }
  if (bx.length === 0) return { a: 0, b: maxY, size };
  let a = 0;
  if (bx.length >= 8 && maxX - minX > 4 * size) {
    const slopes = [];
    for (let i = 0; i < bx.length; i++) for (let j = i + 1; j < bx.length; j++) {
      const dx = bx[j] - bx[i];
      if (Math.abs(dx) > 0.5 * size) slopes.push((by[j] - by[i]) / dx);
    }
    if (slopes.length >= 10) a = median(slopes);
  }
  let b = kdeMode(by.map((y, i) => y - a * bx[i]), bw);
  for (let it = 0; it < 3; it++) {
    const near = [];
    for (let i = 0; i < bx.length; i++) if (Math.abs(by[i] - (a * bx[i] + b)) < 1.5 * bw) near.push(i);
    if (near.length < 2) break;
    let nlo = Infinity, nhi = -Infinity;
    for (const i of near) { if (bx[i] < nlo) nlo = bx[i]; if (bx[i] > nhi) nhi = bx[i]; }
    if (near.length >= 6 && nhi - nlo > 4 * size) {
      let sx = 0, sy = 0, sxx = 0, sxy = 0;                 // least-squares line through the near bottoms
      for (const i of near) { sx += bx[i]; sy += by[i]; }
      const mx = sx / near.length, my = sy / near.length;
      for (const i of near) { sxx += (bx[i] - mx) ** 2; sxy += (bx[i] - mx) * (by[i] - my); }
      a = sxy / sxx;
      b = my - a * mx;
    } else {
      let s = 0;
      for (const i of near) s += by[i] - a * bx[i];
      b = s / near.length;
    }
  }
  a = Math.min(0.2, Math.max(-0.2, a));
  return { a, b, size };
}

/** Put a piece on the baseline y = 0 with its left edge at x = 0. */
export function straighten(ink) {
  const { a, b } = baseline(ink.points);
  const p = new Float32Array(ink.points);
  const n = count(p);
  let minX = Infinity;
  for (let i = 0; i < n; i++) if (X(p, i) < minX) minX = X(p, i);
  for (let i = 0; i < n; i++) { p[3 * i + 1] = p[3 * i + 1] - (a * p[3 * i] + b); p[3 * i] = p[3 * i] - minX; }
  return { ...ink, points: p, baseline: { a, b } };
}

/** Cut a piece into its words at the widest gaps between strokes
 *  (hw/dataset.py: split_words); the whole piece if the gaps are unclear. */
export function pieceWords(ink, minGap = 0.6) {
  const words = ink.text.split(/\s+/u).filter(Boolean);
  if (words.length < 2) return [ink];
  const p = ink.points, ranges = strokeRanges(p);
  const extent = ([s, e]) => { let lo = Infinity, hi = -Infinity; for (let i = s; i < e; i++) { const x = X(p, i); if (x < lo) lo = x; if (x > hi) hi = x; } return [lo, hi]; };
  let reach = extent(ranges[0])[1];
  const jumps = [];
  for (let k = 1; k < ranges.length; k++) {
    const [lo, hi] = extent(ranges[k]);
    jumps.push([lo - reach, k]);
    reach = Math.max(reach, hi);
  }
  const nCut = words.length - 1;
  const ranked = [...jumps].sort((u, v) => (v[0] - u[0]) || (v[1] - u[1]));
  if (ranked.length < nCut || ranked[nCut - 1][0] < minGap) return [ink];
  if (ranked.length > nCut && ranked[nCut][0] > 0.75 * ranked[nCut - 1][0]) return [ink];
  const cuts = ranked.slice(0, nCut).map((r) => r[1]).sort((u, v) => u - v);
  const bounds = [0, ...cuts.map((k) => ranges[k][0]), count(p)];
  return words.map((text, i) => ({ text, ok: ink.ok, points: p.subarray(3 * bounds[i], 3 * bounds[i + 1]) }));
}

/** Set straightened pieces on a page `width` x-heights wide (hw/page.py: layout).
 *  `normal()` supplies standard normal numbers for the spacing between pieces. */
export function layoutPage(paragraphs, { width = 84, lineHeight = 6.5, gap = [2.9, 0.8], margin = 3, top = 5, normal } = {}) {
  let y = top, lines = 1, right = null;
  const strokes = [], placed = [];
  paragraphs.forEach((para, k) => {
    if (k > 0) { y += lineHeight; lines++; right = null; }
    for (const piece of para) {
      let prevEnd = null;
      for (const w of pieceWords(piece)) {
        const p = w.points, n = count(p);
        let x0 = Infinity, x1 = -Infinity;
        for (let i = 0; i < n; i++) { const x = X(p, i); if (x < x0) x0 = x; if (x > x1) x1 = x; }
        let g;
        if (prevEnd === null) g = Math.min(1.6 * gap[0], Math.max(0.6 * gap[0], gap[0] + gap[1] * normal()));
        else g = Math.min(1.8 * gap[0], Math.max(0.5 * gap[0], x0 - prevEnd));
        prevEnd = x1;
        let start = right === null ? margin : right + g;
        if (right !== null && start + (x1 - x0) > width - margin) { y += lineHeight; lines++; start = margin; }
        const q = new Float32Array(p.length);
        for (let i = 0; i < n; i++) { q[3 * i] = p[3 * i] + (start - x0); q[3 * i + 1] = p[3 * i + 1] + y; q[3 * i + 2] = p[3 * i + 2]; }
        if (n) q[3 * (n - 1) + 2] = 1;
        strokes.push(q);
        right = start + (x1 - x0);
        placed.push({ text: w.text, x: start, y, width: x1 - x0, ok: piece.ok !== false });
      }
    }
  });
  return { words: placed, strokes, width, height: y + 3.5, lines };
}

/** Model output (model units) -> ink in xh units. */
export function toXh(result, xhModel) {
  const p = new Float32Array(result.points.length);
  for (let i = 0; i < p.length; i += 3) { p[i] = result.points[i] / xhModel; p[i + 1] = result.points[i + 1] / xhModel; p[i + 2] = result.points[i + 2]; }
  return { text: result.text, ok: result.ok, problems: result.problems, points: p };
}
