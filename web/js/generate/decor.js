// What a person draws by hand around the written words of a document page:
// underlines, strike-throughs, rules, box frames, bullets, check boxes, ticks,
// arrows, and the highlighter.  No DOM in here.
//
// Every line comes from one generator (handLine): a slow, low wobble, a small
// slope and bow, ends that overshoot or stop short a little, and the speed of a
// hand (slow at the ends, quick in the middle).  The result is ordinary ink:
// Float32Array [x, y, penUp, ...] in mm, so every pen draws it in its own look
// (render.js derives a pen's pressure from the distance between points).  All
// sizes are in u = the x-height of the writing it belongs to (mm).
import { makeRandom } from '../engine/engine.js';

// ---------- colours ----------

// Ink colours per scheme [on light paper, on dark paper].  On light paper deep
// enough to read as ink (contrast to white >= 4.5 except Orange and Grau, which
// are meant to be lighter); on dark paper the same hues raised so that they keep
// the contrast of the scheme's own inks.  'schwarz' is the darkest ink on light
// paper and the scheme's white on dark paper.
export const INK_COLORS = Object.freeze({
  rot: ['#C42A2A', '#FF8A80'],
  blau: ['#1F4FC9', '#9DB8FF'],
  gruen: ['#1D7A3A', '#7FD8A0'],
  schwarz: ['#15171A', '#ECEEF2'],
  orange: ['#D2600A', '#FFB570'],
  lila: ['#7A3CB8', '#CDA8FF'],
  grau: ['#6B7280', '#A9B0BC'],
});
export const COLOR_NAMES = Object.keys(INK_COLORS);

// Highlighters: [colour, opacity] on light paper (multiplied, so the ruling and
// the ink show through as with a real marker) and on dark paper (screen-blended:
// a dark-paper band must lighten, not darken).  On the dark paper #1B1F26 a band
// light enough to glow takes the light ink's contrast away, so these stop at about
// 3.2 (yellow) to 5 (pink) for the ink #C9D4FF; yellow leans to gold, which reads
// as a marker there, where a paler yellow read as olive.
export const MARKER_COLORS = Object.freeze({
  gelb: { light: ['#FFE135', 0.55], dark: ['#F2C800', 0.48] },
  gruen: { light: ['#7DEB6A', 0.5], dark: ['#7CF05A', 0.4] },
  rosa: { light: ['#FF8CC6', 0.5], dark: ['#FF6FC0', 0.4] },
  blau: { light: ['#7CCBFF', 0.5], dark: ['#5EC0FF', 0.4] },
  orange: { light: ['#FFAE4D', 0.55], dark: ['#FF9A3C', 0.42] },
});
export const MARKER_NAMES = Object.keys(MARKER_COLORS);

/** The hex colour of ink `name` (null: the document's own ink, `fallback`). */
export function inkColor(name, dark, fallback) {
  const c = name && INK_COLORS[name];
  return c ? c[dark ? 1 : 0] : fallback;
}

/** { color, alpha, blend } of highlighter `name` on light or dark paper. */
export function markerColor(name, dark) {
  const m = MARKER_COLORS[name] || MARKER_COLORS.gelb;
  const [color, alpha] = dark ? m.dark : m.light;
  return { color, alpha, blend: dark ? 'Screen' : 'Multiply' };
}

// ---------- the hand ----------

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** The random numbers of one drawn element: from the document seed and the
 *  element's place (block, serial), never from what comes before it. */
export function decorRandom(seed, block, serial) {
  let h = (seed >>> 0) ^ 0x27D4EB2F ^ Math.imul(block + 1, 0x9E3779B1) ^ Math.imul(serial + 1, 0x85EBCA77);
  h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12; h = Math.imul(h, 0x297A2D39); h ^= h >>> 15;
  return makeRandom(h >>> 0);
}

// The middle of a drawn line moves this many x-heights per point: about twice
// the speed of writing (render.js: V_REF 0.12), so Füller and Bleistift draw it
// a little lighter in the middle and firmer where the hand starts and stops.
const STEP_U = 0.26;
const EASE = 0.7;               // 0 = even speed, 1 = standing still at the ends

/**
 * A line drawn by hand from (x0, y0) to (x1, y1), as [[x, y], ...] (mm).
 * o.ends: sd of the overshoot (+) / stop short (-) at each end (u);
 * o.slope: sd of the turn of the whole line (degrees); o.wobble, o.bow: scale
 * the slow sideways wobble and the bow (1 = a casual line); o.limit: the most the
 * line may leave its straight course sideways (u).  A turn in degrees moves the
 * far end of a long line a lot (0.9 degrees over 150 mm is 2.4 mm), so a line
 * that must stay clear of letters is held by its distance instead.
 */
export function handLine(rng, x0, y0, x1, y1, u, { ends = 0.22, slope = 0.45, wobble = 1, bow = 1, ease = EASE, limit = Infinity } = {}) {
  const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
  if (L < 1e-6) return [[x0, y0]];
  const tx = dx / L, ty = dy / L, nx = -ty, ny = tx;
  const e0 = clamp(rng.normal() * ends, -2 * ends, 2 * ends) * u;
  const e1 = clamp(rng.normal() * ends, -2 * ends, 2 * ends) * u;
  const len = Math.max(0.2 * L, L + e0 + e1);
  const turn = Math.tan(clamp(rng.normal(), -2, 2) * slope * DEG);
  const sag = clamp(rng.normal(), -2, 2) * bow * (0.03 * u + 0.002 * L);
  // two slow waves: one about as long as the line (or 30 u), one of a few letters
  const lam1 = (0.7 + 0.8 * rng.uniform()) * Math.max(L, 30 * u), ph1 = 2 * Math.PI * rng.uniform();
  const lam2 = (5 + 5 * rng.uniform()) * u, ph2 = 2 * Math.PI * rng.uniform();
  const a1 = wobble * (0.025 * u + 0.001 * L), a2 = wobble * 0.018 * u;
  const n = Math.max(3, Math.ceil((len * (1 + ease)) / (STEP_U * u)));
  const ds = [], offs = [];
  let most = 0;
  for (let i = 0; i <= n; i++) {
    const t = i / n, s = t - (ease * Math.sin(2 * Math.PI * t)) / (2 * Math.PI);    // slow, quick, slow
    const d = s * len - e0;
    const off = turn * d + 4 * sag * s * (1 - s) + a1 * (Math.sin((2 * Math.PI * d) / lam1 + ph1) - Math.sin(ph1)) + a2 * (Math.sin((2 * Math.PI * d) / lam2 + ph2) - Math.sin(ph2));
    ds.push(d); offs.push(off); most = Math.max(most, Math.abs(off));
  }
  const k = most > limit * u ? (limit * u) / most : 1;
  return ds.map((d, i) => [x0 + tx * d + nx * offs[i] * k, y0 + ty * d + ny * offs[i] * k]);
}

/** [[x, y], ...] -> one ink stroke. */
export function toStroke(pts) {
  const q = new Float32Array(3 * pts.length);
  pts.forEach(([x, y], i) => { q[3 * i] = x; q[3 * i + 1] = y; });
  q[q.length - 1] = 1;
  return q;
}

/** Several strokes as one ink array (the pen lifts between them). */
export function joinStrokes(list) {
  const q = new Float32Array(list.reduce((n, s) => n + s.length, 0));
  let at = 0;
  for (const s of list) { q.set(s, at); at += s.length; }
  return q;
}

// ---------- the elements (each returns an array of strokes) ----------

// Heights relative to the baseline, in u: chosen by looking at proof pages.
export const UNDER_Y = 0.42;       // under the letters, through the descenders
export const UNDER2_GAP = 0.5;     // the second line of a double underline
export const STRIKE_Y = -0.6;      // through the middle of the small letters
export const MID_Y = -0.65;        // arrows and bullets sit at mid-height
export const BAND = [0.5, -1.8];  // highlighter: from under the baseline to above the small letters
// How far an underline may stray from its course (u): from 0.42 u under the baseline
// it never comes closer than 0.26 u, so it stays under the letters at any length.
const UNDER_LIMIT = 0.16, STRIKE_LIMIT = 0.25;

/** Underline under x0..x1 at baseline y. */
export function underline(rng, x0, x1, y, u) {
  return [toStroke(handLine(rng, x0, y + UNDER_Y * u, x1, y + UNDER_Y * u, u, { limit: UNDER_LIMIT }))];
}

/** Two lines under a title, the second a little shorter and started a little later. */
export function doubleUnderline(rng, x0, x1, y, u) {
  const y1 = y + UNDER_Y * u, y2 = y1 + UNDER2_GAP * u;
  const w = x1 - x0;
  return [
    toStroke(handLine(rng, x0, y1, x1, y1, u, { limit: UNDER_LIMIT })),
    toStroke(handLine(rng, x0 + clamp(0.03 * w, 0.2 * u, 1.2 * u), y2, x1 - clamp(0.06 * w, 0.4 * u, 2.5 * u), y2, u, { limit: UNDER_LIMIT })),
  ];
}

/** A line through x0..x1, rising a little (struck out quickly, left to right). */
export function strike(rng, x0, x1, y, u) {
  const rise = clamp(0.012 * (x1 - x0), 0.03 * u, 0.25 * u);
  return [toStroke(handLine(rng, x0 - 0.15 * u, y + STRIKE_Y * u + rise, x1 + 0.15 * u, y + STRIKE_Y * u - rise, u, { slope: 0.8, limit: STRIKE_LIMIT }))];
}

/** A rule across x0..x1 at height y. */
export function rule(rng, x0, x1, y, u) {
  return [toStroke(handLine(rng, x0, y, x1, y, u, { ends: 0.5, slope: 0.25, bow: 1.8, wobble: 1.5 }))];
}

// A line drawn along a ruler ends a little past its mark more often than short of
// it (the pen runs over the crossing): ends in u, mean, sd and range.
const RULER_END = [0.1, 0.14, -0.12, 0.45];

/** A table's grid line from (x0, y0) to (x1, y1), drawn along a ruler: straight, in
 *  one stroke, its ends a little past or short of their marks, the faint waver of a
 *  pen held against the edge. */
export function rulerLine(rng, x0, y0, x1, y1, u) {
  const L = Math.hypot(x1 - x0, y1 - y0);
  if (L < 1e-6) return [toStroke([[x0, y0]])];
  const tx = (x1 - x0) / L, ty = (y1 - y0) / L;
  const end = () => clamp(RULER_END[0] + RULER_END[1] * rng.normal(), RULER_END[2], RULER_END[3]) * u;
  const e0 = end(), e1 = end();
  return [toStroke(handLine(rng, x0 - tx * e0, y0 - ty * e0, x1 + tx * e1, y1 + ty * e1, u, { ends: 0, slope: 0.05, wobble: 0.25, bow: 0.15, ease: 0.45, limit: 0.12 }))];
}

/** A frame: four lines (top, right, bottom, left) whose corners do not quite close;
 *  the first one starts with the small hook of a pen set down while moving. */
export function frame(rng, x0, y0, x1, y1, u) {
  const o = { ends: 0.3, slope: 0.35, wobble: 1.8, bow: 1.6 };
  const j = () => clamp(rng.normal() * 0.18, -0.4, 0.4) * u;
  const top = handLine(rng, x0 + j(), y0 + j(), x1 + j(), y0 + j(), u, o), [hx, hy] = top[0];
  const hook = [[hx - (0.15 + 0.1 * rng.uniform()) * u, hy + (0.3 + 0.15 * rng.uniform()) * u], [hx - 0.12 * u, hy + 0.08 * u]];
  return [
    toStroke([...hook, ...top]),
    toStroke(handLine(rng, x1 + j(), y0 + j(), x1 + j(), y1 + j(), u, o)),
    toStroke(handLine(rng, x0 + j(), y1 + j(), x1 + j(), y1 + j(), u, o)),
    toStroke(handLine(rng, x0 + j(), y0 + j(), x0 + j(), y1 + j(), u, o)),
  ];
}

/** A list bullet at x (its left edge) on baseline y: a small firm dot on level 1,
 *  a short dash below.  Returns { strokes, width }. */
export function bullet(rng, x, y, u, level = 1) {
  const cy = y + MID_Y * u + clamp(rng.normal() * 0.05, -0.1, 0.1) * u;
  if (level === 2) {
    const w = (0.9 + 0.12 * rng.uniform()) * u;
    return { strokes: [toStroke(handLine(rng, x, cy, x + w, cy - 0.04 * u, u, { ends: 0.05, slope: 3, wobble: 0.3, ease: 0.5 }))], width: w };
  }
  // a dot: the pen turns a little spiral inwards, slowly, so it fills and every pen draws it firm
  const r = (level === 1 ? 0.4 : 0.3) * u, pts = [], a0 = 2 * Math.PI * rng.uniform(), n = 22;
  for (let i = 0; i <= n; i++) {
    const a = a0 + (i / n) * 3.2 * Math.PI, rr = r * (1 - 0.8 * (i / n));
    pts.push([x + r + rr * Math.cos(a), cy + rr * 0.9 * Math.sin(a)]);
  }
  return { strokes: [toStroke(pts)], width: 2 * r };
}

// A check box about as tall as a capital of the writing (which is written about
// 1.13 page x-heights high at bias 0.4), so it reads as drawn next to it: 1.9 u
// looked like a printed glyph on the proof pages.
export const CHECK_SIZE = 2.8;

/** The corners of the check box at x on baseline y, as a hand draws it: sides a
 *  little unequal, the whole turned by a degree or two.  [tl, tr, br, bl]. */
function boxCorners(rng, x, y, u) {
  const s = CHECK_SIZE * u, b = y + 0.08 * u;
  const w = s * (1 + clamp(rng.normal() * 0.05, -0.08, 0.08)), h = s * (1 + clamp(rng.normal() * 0.05, -0.08, 0.08));
  const a = clamp(rng.normal() * 1.2, -3, 3) * DEG, c = Math.cos(a), sn = Math.sin(a);
  const cx = x + s / 2, cy = b - s / 2;
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([dx, dy]) => [cx + c * dx - sn * dy, cy + sn * dx + c * dy]);
}

/** An empty check box with its left edge at x on baseline y: two strokes, left side
 *  and bottom in one, top and right side in the other, their corners crossing a
 *  little.  { strokes, width }. */
export function checkBox(rng, x, y, u) {
  const [tl, tr, br, bl] = boxCorners(rng, x, y, u), o = { ends: 0.04, slope: 1.2, wobble: 0.9, bow: 1.4, ease: 0.5 };
  const over = () => (0.25 + 0.3 * rng.uniform()) * u;
  const seg = (p, q, from = 0) => handLine(rng, p[0], p[1], q[0], q[1], u, o).slice(from);
  const a = [tl[0] + 0.05 * u, tl[1] - over()], e = [br[0] + over(), br[1] + 0.06 * u];
  const c = [tl[0] - over(), tl[1] + 0.05 * u], f = [br[0] - 0.04 * u, br[1] + 0.5 * over()];
  return {
    strokes: [toStroke([...seg(a, bl), ...seg(bl, e, 1)]), toStroke([...seg(c, tr), ...seg(tr, f, 1)])],
    width: CHECK_SIZE * u,
  };
}

/** A tick in the check box at x on baseline y: down into the box, then up and out
 *  well past its top right corner, in one stroke. */
export function tick(rng, x, y, u) {
  const s = CHECK_SIZE * u, b = y + 0.08 * u;
  const j = () => clamp(rng.normal() * 0.06, -0.12, 0.12) * u;
  const a = [x + 0.12 * s + j(), b - 0.5 * s + j()], m = [x + 0.4 * s + j(), b - 0.04 * s + j()], e = [x + 1.35 * s + j(), b - 1.45 * s + j()];
  const down = handLine(rng, a[0], a[1], m[0], m[1], u, { ends: 0.03, slope: 2, wobble: 0.2, ease: 0.4 });
  const up = handLine(rng, m[0], m[1], e[0], e[1], u, { ends: 0.15, slope: 2, wobble: 0.4, ease: 0.5 });
  return [toStroke([...down, ...up.slice(1)])];
}

// Arrows: the shaft in x-heights (the layout reserves it plus a word gap each side).
export const ARROW_LENGTH = { right: 4.4, left: 4.4, both: 5.0, double: 4.6 };
const HEAD = 1.25, HEAD_ANGLE = 28;

/** An arrow of kind 'right' | 'left' | 'both' | 'double' from x0 to x1 at mid-height above baseline y. */
export function arrow(rng, kind, x0, x1, y, u) {
  const ym = y + MID_Y * u + clamp(rng.normal() * 0.05, -0.1, 0.1) * u;
  const out = [];
  const shaftO = { ends: 0.08, slope: 0.8, wobble: 0.5 };
  const head = (tx, ty, dir, size) => {
    const ang = (HEAD_ANGLE + rng.normal() * 3) * DEG, h = size * u * (0.92 + 0.16 * rng.uniform());
    for (const side of [-1, 1]) {
      const bx = tx - dir * h * Math.cos(ang), by = ty + side * h * Math.sin(ang);
      out.push(toStroke(handLine(rng, bx, by, tx + dir * 0.05 * u, ty, u, { ends: 0.04, slope: 2, wobble: 0.2, ease: 0.45 })));
    }
  };
  if (kind === 'double') {
    const d = 0.2 * u;
    out.push(toStroke(handLine(rng, x0, ym - d, x1 - 0.35 * u, ym - d, u, shaftO)));
    out.push(toStroke(handLine(rng, x0, ym + d, x1 - 0.35 * u, ym + d, u, shaftO)));
    head(x1, ym, 1, HEAD * 1.15);
    return out;
  }
  out.push(toStroke(handLine(rng, x0, ym, x1, ym, u, shaftO)));
  if (kind === 'right' || kind === 'both') head(x1, ym, 1, HEAD);
  if (kind === 'left' || kind === 'both') head(x0, ym, -1, HEAD);
  return out;
}

/**
 * A highlighter pass along x0..x1 over baseline y: the outline of a broad band
 * (Float32Array [x, y, ...] mm, closed), with a chisel tip's slanted ends and
 * slightly uneven edges.
 */
export function markerBand(rng, x0, x1, y, u) {
  const top = y + BAND[1] * u, bot = y + BAND[0] * u, h = bot - top;
  const slant = clamp(0.3 + 0.12 * rng.normal(), 0.1, 0.5) * h;          // the tip is held at an angle
  // both corners of each end lie beyond the run, the ends a little uneven
  const a = x0 - slant / 2 - (0.1 + 0.2 * rng.uniform()) * u, b = x1 + slant / 2 + (0.05 + 0.2 * rng.uniform()) * u;
  const L = b - a, turn = Math.tan(clamp(rng.normal(), -2, 2) * 0.35 * DEG);
  const wave = (ph, lam, amp) => (x) => amp * Math.sin((2 * Math.PI * (x - a)) / lam + ph);
  const lam = (0.8 + 0.6 * rng.uniform()) * Math.max(L, 20 * u);
  const wt = wave(2 * Math.PI * rng.uniform(), lam, 0.05 * u), wb = wave(2 * Math.PI * rng.uniform(), lam * 0.8, 0.06 * u);
  const fine = wave(2 * Math.PI * rng.uniform(), 3.5 * u, 0.025 * u);
  // a parallelogram: the top edge shifted right of the bottom one, the ends slightly bulging
  const n = Math.max(4, Math.ceil(L / (0.8 * u))), out = [];
  const yt = (x) => top + turn * (x - a) + wt(x) + fine(x), yb = (x) => bot + turn * (x - a) + wb(x) - fine(x + u);
  const end = (x0, y0, x1, y1, side) => { for (const t of [0.3, 0.7]) out.push([x0 + (x1 - x0) * t + side * 0.12 * h * Math.sin(Math.PI * t), y0 + (y1 - y0) * t]); };
  for (let i = 0; i <= n; i++) { const x = a + slant / 2 + ((L - 0) * i) / n; out.push([x, yt(x)]); }
  end(b + slant / 2, yt(b + slant / 2), b - slant / 2, yb(b - slant / 2), 1);
  for (let i = n; i >= 0; i--) { const x = a - slant / 2 + (L * i) / n; out.push([x, yb(x)]); }
  end(a - slant / 2, yb(a - slant / 2), a + slant / 2, yt(a + slant / 2), -1);
  const q = new Float32Array(2 * out.length);
  out.forEach(([x, yy], i) => { q[2 * i] = x; q[2 * i + 1] = yy; });
  return q;
}
