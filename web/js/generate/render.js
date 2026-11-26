// Drawing and exporting handwriting.  A page is what layout.js produces:
// { strokes: Float32Array[] ([x, y, eos, ...] in xh units), width, height }.
//
// The look ("Stil") is the same as on the capture sheet (capture/ink.js): pen, stroke
// width, paper, colours.  Widths here are in x-heights, so they scale with the size of
// the writing.  Generated strokes carry no pressure: their points are equidistant in
// time, so the speed between two points stands in for it (slow = firm), and ink.js
// smooths it exactly as it smooths a real pen's pressure.  Everything below is a pure
// function of the page and the look: the same page always gives the same pixels.
import {
  schemeColors, createInk, smoothPressure, fuellerWidth, pencilLevel, pencilColor, hexRgb, TONES,
} from '../capture/ink.js';

export const PENS = ['fineliner', 'fueller', 'bleistift'];
// Stroke widths in x-heights: the capture widths (0.75 .. 3 CSS px) on its writing of
// about 6 px x-height, slightly evened out.  Index i matches capture/ink.js WIDTHS[i].
export const WIDTHS = [0.14, 0.19, 0.25, 0.32, 0.42];
export const PAPERS = ['blanko', 'liniert', 'kariert'];
export const SCHEMES = ['dark_on_light', 'light_on_dark'];
// Tinte per sheet scheme.  'blue' is the capture sheet's ink in both schemes.
export const INKS = {
  dark_on_light: { blueblack: ['#1B2A49', 'Blauschwarz'], black: ['#15171A', 'Schwarz'], blue: ['#2141B8', 'Königsblau'] },
  light_on_dark: { blueblack: ['#AEBBDD', 'Taubenblau'], black: ['#ECEEF2', 'Weiß'], blue: ['#C9D4FF', 'Hellblau'] },
};
export const DEFAULT_LOOK = Object.freeze({ pen: 'fineliner', width: 0.32, paper: 'blanko', scheme: 'dark_on_light', ink: 'blueblack' });

const STEP_MS = 4;          // time between two generated points, for ink.js's pressure smoothing
const V_REF = 0.12;         // median distance between two generated points, x-heights
const SUB_XH = 0.05;        // longest straight piece when a curve is cut up for the pressure pens
const MIN_PX = 0.6;         // thinnest line drawn, device px

/** Any stored or half-valid object -> a complete look. */
export function normalizeLook(o) {
  const v = o && typeof o === 'object' ? o : {};
  return {
    pen: PENS.includes(v.pen) ? v.pen : DEFAULT_LOOK.pen,
    width: WIDTHS.includes(v.width) ? v.width : DEFAULT_LOOK.width,
    paper: PAPERS.includes(v.paper) ? v.paper : DEFAULT_LOOK.paper,
    scheme: SCHEMES.includes(v.scheme) ? v.scheme : DEFAULT_LOOK.scheme,
    ink: v.ink in INKS.dark_on_light ? v.ink : DEFAULT_LOOK.ink,
  };
}

/** The capture sheet's options (capture/ink.js normalize()) as a Schreiben look. */
export function lookFromCapture(d, captureWidths) {
  const i = captureWidths.indexOf(d.width);
  return normalizeLook({
    pen: d.pen, width: WIDTHS[i < 0 ? 1 : i], paper: d.paper === 'linie' ? 'liniert' : d.paper, scheme: d.scheme, ink: 'blue',
  });
}

const FALLBACK = {
  dark_on_light: { scheme: 'dark_on_light', dark: false, paper: '#FFFFFF', ink: '#2141B8', graphite: '#2B2E34', rule: '#9DB0CB', faint: '#DFE5EE' },
  light_on_dark: { scheme: 'light_on_dark', dark: true, paper: '#1B1F26', ink: '#C9D4FF', graphite: '#E9ECF1', rule: '#52637F', faint: '#2F3746' },
};

/** Sheet colours for a look, with its ink: { paper, ink, graphite, rule, faint, dark }. */
export function lookColors(look) {
  const l = normalizeLook(look);
  const base = typeof document !== 'undefined' && typeof getComputedStyle === 'function' ? schemeColors(l.scheme) : FALLBACK[l.scheme];
  return Object.assign({}, base, { ink: INKS[l.scheme][l.ink][0] });
}

/** The colour the strokes have (the graphite for Bleistift). */
export const strokeColor = (look, colors) => (look.pen === 'bleistift' ? colors.graphite : colors.ink);

/** Split a point array into strokes: arrays of [x, y]. */
export function toPolylines(points) {
  const out = [];
  let cur = [];
  for (let i = 0; i < points.length; i += 3) {
    cur.push([points[i], points[i + 1]]);
    if (points[i + 2] > 0.5) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---------- the pressure pens: speed -> pressure ----------

/** Pressure-like value at each point of a stroke: 0.5 at the usual speed, firmer when slower. */
function speedPressure(line) {
  const n = line.length, p = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const v = Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]) / V_REF;
    p[i] = 0.15 + 0.7 / (1 + v * Math.sqrt(v));
  }
  p[0] = n > 1 ? p[1] : 0.5;
  return p;
}

/**
 * One stroke as ink.js samples ({x, y, t, p} in xh), following the same smooth curve the
 * Fineliner draws (quadratic pieces through the midpoints), cut into short straight pieces
 * so that width and tone can change along it.
 */
function penSamples(line) {
  const pr = speedPressure(line);
  const s = { x: [], y: [], t: [], p: [] };
  const push = (x, y, t, p) => { s.x.push(x); s.y.push(y); s.t.push(t); s.p.push(p); };
  const n = line.length;
  push(line[0][0], line[0][1], 0, pr[0]);
  if (n === 1) return s;
  let ax = line[0][0], ay = line[0][1], at = 0, ap = pr[0];
  for (let i = 1; i < n - 1; i++) {
    const cx = line[i][0], cy = line[i][1], cp = pr[i], ct = i * STEP_MS;
    const bx = (cx + line[i + 1][0]) / 2, by = (cy + line[i + 1][1]) / 2;
    const bp = (cp + pr[i + 1]) / 2, bt = (i + 0.5) * STEP_MS;
    const k = Math.max(1, Math.min(16, Math.ceil((Math.hypot(cx - ax, cy - ay) + Math.hypot(bx - cx, by - cy)) / SUB_XH)));
    for (let j = 1; j <= k; j++) {
      const u = j / k, a = (1 - u) * (1 - u), b = 2 * u * (1 - u), c = u * u;
      push(a * ax + b * cx + c * bx, a * ay + b * cy + c * by, a * at + b * ct + c * bt, a * ap + b * cp + c * bp);
    }
    ax = bx; ay = by; at = bt; ap = bp;
  }
  const L = line[n - 1], lt = (n - 1) * STEP_MS, lp = pr[n - 1];
  const k = Math.max(1, Math.min(16, Math.ceil(Math.hypot(L[0] - ax, L[1] - ay) / SUB_XH)));
  for (let j = 1; j <= k; j++) {
    const u = j / k;
    push(ax + (L[0] - ax) * u, ay + (L[1] - ay) * u, at + (lt - at) * u, ap + (lp - ap) * u);
  }
  return s;
}

const sampleCache = new WeakMap();
/** ink.js samples for every stroke of a word (cached per word array: they never change). */
function wordSamples(points) {
  let out = sampleCache.get(points);
  if (!out) { out = toPolylines(points).map(penSamples); sampleCache.set(points, out); }
  return out;
}

// ---------- drawing ----------

/** Trace one stroke as a smooth curve through the midpoints of its segments. */
function trace(ctx, line, scale, ox, oy) {
  const px = (p) => p[0] * scale + ox, py = (p) => p[1] * scale + oy;
  if (line.length === 1) {
    ctx.moveTo(px(line[0]), py(line[0]));
    ctx.lineTo(px(line[0]) + 0.01, py(line[0]));
    return;
  }
  ctx.moveTo(px(line[0]), py(line[0]));
  for (let i = 1; i < line.length - 1; i++) {
    const mx = (px(line[i]) + px(line[i + 1])) / 2, my = (py(line[i]) + py(line[i + 1])) / 2;
    ctx.quadraticCurveTo(px(line[i]), py(line[i]), mx, my);
  }
  const last = line[line.length - 1];
  ctx.lineTo(px(last), py(last));
}

const inks = new WeakMap();   // one ink.js renderer per 2D context (it keeps its grain patterns)

/**
 * Draw one word array (an entry of page.strokes) onto a 2D context whose transform is the
 * identity.  o = { scale (device px per x-height), look, colors }.  Each word is drawn on
 * its own, so drawing word by word and drawing a whole page give the same pixels.
 */
export function drawWord(ctx, points, { scale, look, colors, offsetX = 0, offsetY = 0 }) {
  const l = look;
  if (l.pen === 'fineliner') {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = colors.ink;
    ctx.lineWidth = Math.max(l.width * scale, MIN_PX);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const line of toPolylines(points)) trace(ctx, line, scale, offsetX, offsetY);
    ctx.stroke();
    ctx.restore();
    return;
  }
  let ink = inks.get(ctx);
  if (!ink) { ink = createInk(ctx); inks.set(ctx, ink); }
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY);
  ink.configure({ pen: l.pen, width: Math.max(l.width, MIN_PX / scale) }, colors, scale);
  for (const s of wordSamples(points)) ink.draw(s, 0);
  ctx.restore();
}

/** Draw several word arrays, one after the other. */
export function drawWords(ctx, words, o) { for (const w of words) drawWord(ctx, w, o); }

/** Draw only the first `count` points of a word array (for the writing animation). */
export function drawPartial(ctx, points, count, o) {
  const n = Math.min(count, points.length / 3);
  if (n <= 0) return;
  const part = points.slice(0, 3 * n);
  part[3 * (n - 1) + 2] = 1;
  drawWord(ctx, part, o);
}

/**
 * The paper's lines in xh units for a sheet `width` x `height` x-heights.
 * Liniert: one line under every line of text.  Kariert: squares of half a line, so the
 * baselines sit on grid lines, the vertical ones starting at the left margin.
 */
export function guideLines(paper, { width, height, spacing, top = 5, margin = 3 }) {
  const ys = [], xs = [];
  if (paper === 'blanko') return { ys, xs };
  const step = paper === 'kariert' ? spacing / 2 : spacing;
  for (let y = top - step * Math.floor(top / step); y <= height; y += step) ys.push(y);
  if (paper === 'kariert') for (let x = margin - step * Math.floor(margin / step); x <= width; x += step) xs.push(x);
  return { ys, xs };
}

/**
 * Paper colour and lines onto a context with the identity transform, `w` x `h` device px.
 * g = { scale, spacing, top, margin, lineWidth (device px) }.  Lines on whole device
 * pixels when they are whole pixels wide, so they stay crisp.
 */
export function drawSheet(ctx, w, h, look, colors, g) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = colors.paper; ctx.fillRect(0, 0, w, h);
  const { ys, xs } = guideLines(look.paper, { width: w / g.scale, height: h / g.scale, spacing: g.spacing, top: g.top, margin: g.margin });
  if (ys.length || xs.length) {
    const lw = g.lineWidth, whole = Math.abs(lw - Math.round(lw)) < 1e-6;
    const at = (v) => (whole ? Math.round(v * g.scale - lw / 2) + lw / 2 : v * g.scale);
    ctx.lineWidth = lw; ctx.lineCap = 'butt';
    ctx.strokeStyle = look.paper === 'liniert' ? colors.rule : colors.faint;
    ctx.beginPath();
    for (const y of ys) { ctx.moveTo(0, at(y)); ctx.lineTo(w, at(y)); }
    for (const x of xs) { ctx.moveTo(at(x), 0); ctx.lineTo(at(x), h); }
    ctx.stroke();
  }
  ctx.restore();
}

// ---------- export ----------

const fmt = (v) => (Math.round(v * 100) / 100).toString();

/** Bézier path data of one stroke (the same curve trace() draws). */
function pathData(line, scale) {
  const p = line.map(([x, y]) => [x * scale, y * scale]);
  let d = `M${fmt(p[0][0])} ${fmt(p[0][1])}`;
  if (p.length === 1) return `${d}l0.01 0`;
  for (let i = 1; i < p.length - 1; i++) {
    d += `Q${fmt(p[i][0])} ${fmt(p[i][1])} ${fmt((p[i][0] + p[i + 1][0]) / 2)} ${fmt((p[i][1] + p[i + 1][1]) / 2)}`;
  }
  return `${d}L${fmt(p[p.length - 1][0])} ${fmt(p[p.length - 1][1])}`;
}

export const FUELLER_LEVELS = 12;     // Füller: width steps between 0.4x and 1.6x

/**
 * Füller / Bleistift: the short straight pieces of every stroke (word arrays in xh
 * units), grouped by width or tone level: [{ key, runs: [{ dot, pts: [[x, y], ...] }] }],
 * keys ascending.  A run with `dot` starts a stroke (exporters mark it with a tiny
 * segment so that a one-point stroke still shows).  SVG and PDF export share this.
 */
export function penGroups(strokes, look) {
  const groups = new Map();    // level -> runs
  for (const points of strokes) {
    for (const s of wordSamples(points)) {
      let pe = 0, prev = null, run = null;
      for (let i = 0; i < s.x.length; i++) {
        pe = smoothPressure(pe, s, i);
        const key = look.pen === 'fueller' ? Math.round(Math.min(1, pe) * FUELLER_LEVELS) : pencilLevel(pe);
        if (!groups.has(key)) groups.set(key, []);
        if (i === 0) { run = { dot: true, pts: [[s.x[0], s.y[0]]] }; groups.get(key).push(run); }
        else if (key === prev) run.pts.push([s.x[i], s.y[i]]);
        else { run = { dot: false, pts: [[s.x[i - 1], s.y[i - 1]], [s.x[i], s.y[i]]] }; groups.get(key).push(run); }
        prev = key;
      }
    }
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([key, runs]) => ({ key, runs }));
}

/** Füller / Bleistift as SVG path data per level. */
function svgPenGroups(page, look, scale) {
  return penGroups(page.strokes, look).map(({ key, runs }) => ({
    key,
    d: runs.map(({ dot, pts }) => `M${fmt(pts[0][0] * scale)} ${fmt(pts[0][1] * scale)}${dot ? 'l0.01 0' : ''}` +
      pts.slice(1).map(([x, y]) => `L${fmt(x * scale)} ${fmt(y * scale)}`).join('')).join(''),
  }));
}

/**
 * The page as a standalone SVG document.  paper: true draws the paper and its lines as
 * vectors.  Fineliner is exact (one path per word, the same curves as on screen); Füller
 * is the same pieces as on screen with the width in 13 steps; Bleistift is the same pieces
 * in the eight graphite tones of the screen, with an SVG noise filter for the grain.
 */
export function toSVG(page, { scale = 12, look = DEFAULT_LOOK, paper = false, guideWidth = 1, spacing = 6.5, top = 5, margin = 3 } = {}) {
  const l = normalizeLook(look);
  const colors = lookColors(l);
  const w = page.width * scale, h = page.height * scale;
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(w)} ${fmt(h)}" width="${fmt(w)}" height="${fmt(h)}">`;
  if (paper) {
    out += `<rect width="100%" height="100%" fill="${colors.paper}"/>`;
    const { ys, xs } = guideLines(l.paper, { width: page.width, height: page.height, spacing, top, margin });
    if (ys.length || xs.length) {
      const d = ys.map((y) => `M0 ${fmt(y * scale)}H${fmt(w)}`).join('') + xs.map((x) => `M${fmt(x * scale)} 0V${fmt(h)}`).join('');
      out += `<path d="${d}" fill="none" stroke="${l.paper === 'liniert' ? colors.rule : colors.faint}" stroke-width="${fmt(guideWidth)}"/>`;
    }
  }
  const lw = l.width * scale;
  if (l.pen === 'fineliner') {
    const paths = page.strokes.map((points) => `<path d="${toPolylines(points).map((line) => pathData(line, scale)).join('')}"/>`);
    out += `<g fill="none" stroke="${colors.ink}" stroke-width="${fmt(lw)}" stroke-linecap="round" stroke-linejoin="round">${paths.join('')}</g>`;
  } else if (l.pen === 'fueller') {
    const paths = svgPenGroups(page, l, scale).map(({ key, d }) => `<path stroke-width="${fmt(fuellerWidth(lw, key / 12))}" d="${d}"/>`);
    out += `<g fill="none" stroke="${colors.ink}" stroke-linecap="round" stroke-linejoin="round">${paths.join('')}</g>`;
  } else {
    // Graphite: lighter tones first, so the stronger tone wins where pieces overlap.
    // On a transparent background the tone is the graphite's opacity instead of a mix with the paper.
    const paths = svgPenGroups(page, l, scale).map(({ key, d }) => (paper
      ? `<path stroke="${pencilColor(colors, key)}" d="${d}"/>`
      : `<path stroke="${colors.graphite}" stroke-opacity="${fmt(0.54 + 0.42 * (key / (TONES - 1)))}" d="${d}"/>`));
    out += '<filter id="grain" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="1" seed="7" result="n"/>' +
      '<feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -1.1 0 0 0 1.45" result="m"/><feComposite in="SourceGraphic" in2="m" operator="in"/></filter>';
    out += `<g fill="none" stroke-width="${fmt(lw)}" stroke-linecap="round" stroke-linejoin="round" filter="url(#grain)">${paths.join('')}</g>`;
  }
  return `${out}</svg>\n`;
}

/**
 * Only the ink: the paper's colour is taken out again, so every pixel is the stroke colour
 * with some transparency (exact for Fineliner and Füller, which have none to take out;
 * for Bleistift its tone and grain become transparency).
 */
function inkOnly(canvas, colors, color) {
  const c = canvas.getContext('2d');
  const img = c.getImageData(0, 0, canvas.width, canvas.height), d = img.data;
  const p = hexRgb(colors.paper), k = hexRgb(color);
  const v = [k[0] - p[0], k[1] - p[1], k[2] - p[2]], vv = v[0] * v[0] + v[1] * v[1] + v[2] * v[2] || 1;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    let t = ((d[i] - p[0]) * v[0] + (d[i + 1] - p[1]) * v[1] + (d[i + 2] - p[2]) * v[2]) / vv;
    t = t > 0 ? (t < 1 ? t : 1) : 0;
    d[i] = k[0]; d[i + 1] = k[1]; d[i + 2] = k[2]; d[i + 3] = Math.round(d[i + 3] * t);
  }
  c.putImageData(img, 0, 0);
}

/**
 * Render the page into a new canvas (for PNG export).  paper: true = as on the sheet
 * (paper, lines, ink); false = transparent background with the ink only.
 */
export function toCanvas(page, { scale = 24, look = DEFAULT_LOOK, paper = true, guideWidth = 1, spacing = 6.5, top = 5, margin = 3, createCanvas } = {}) {
  const l = normalizeLook(look);
  const colors = lookColors(l);
  const make = createCanvas || ((w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }));
  const W = Math.ceil(page.width * scale), H = Math.ceil(page.height * scale);
  const inkCanvas = make(W, H);
  drawWords(inkCanvas.getContext('2d'), page.strokes, { scale, look: l, colors });
  if (!paper) {
    if (l.pen === 'bleistift') inkOnly(inkCanvas, colors, colors.graphite);
    return inkCanvas;
  }
  const out = make(W, H);
  const c = out.getContext('2d');
  drawSheet(c, W, H, l, colors, { scale, spacing, top, margin, lineWidth: guideWidth });
  c.drawImage(inkCanvas, 0, 0);
  return out;
}

// ---------- document pages (document.js), in millimetres ----------

const nominal = new WeakMap();
/** A document word array (mm) in the x-heights of the page (mm / xh), so that the
 *  pens' speed and width rules see the same units as on the quick sheet (cached). */
export function docWordXh(points, xh) {
  let out = nominal.get(points);
  if (!out || out.xh !== xh) {
    const q = new Float32Array(points.length);
    for (let i = 0; i < q.length; i += 3) { q[i] = points[i] / xh; q[i + 1] = points[i + 1] / xh; q[i + 2] = points[i + 2]; }
    out = { xh, q };
    nominal.set(points, out);
  }
  return out.q;
}

/** The colour of a document page's ruling. */
export const rulingColor = (doc, colors) => (doc.geometry.ruling.tone === 'faint' ? colors.faint : colors.rule);

/**
 * Draw page `pageIndex` of a document onto a 2D context with the identity transform:
 * paper, ruling, ink.  o = { scale (device px per mm), look (default the document's),
 * colors, offsetX, offsetY, mark: [[x0, y0, x1, y1], ...] boxes in mm to underlay
 * (a piece picked for rewriting), markColor }.  The page is drawn from the same
 * object the PDF is written from, with the same pens.
 */
export function drawDocumentPage(ctx, doc, pageIndex, { scale, look, colors, offsetX = 0, offsetY = 0, mark = null, markColor = null, ink = true } = {}) {
  const l = normalizeLook(look || doc.settings.look);
  const c = colors || lookColors(l);
  const { width: W, height: H } = doc.page;
  const g = doc.geometry;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = c.paper;
  ctx.fillRect(offsetX, offsetY, W * scale, H * scale);
  const { ys, xs } = g.ruling;
  if (ys.length || xs.length) {
    const lw = Math.max(1, g.ruling.width * scale);
    const whole = Math.abs(lw - Math.round(lw)) < 1e-6;
    const at = (v, o) => (whole ? Math.round(v * scale + o - lw / 2) + lw / 2 : v * scale + o);
    ctx.lineWidth = lw; ctx.lineCap = 'butt';
    ctx.strokeStyle = rulingColor(doc, c);
    ctx.beginPath();
    for (const y of ys) { ctx.moveTo(offsetX, at(y, offsetY)); ctx.lineTo(offsetX + W * scale, at(y, offsetY)); }
    for (const x of xs) { ctx.moveTo(at(x, offsetX), offsetY); ctx.lineTo(at(x, offsetX), offsetY + H * scale); }
    ctx.stroke();
  }
  if (mark && mark.length) {
    ctx.fillStyle = markColor || c.faint;
    const pad = 0.12 * g.pitch;
    for (const [x0, y0, x1, y1] of mark) ctx.fillRect(offsetX + (x0 - pad) * scale, offsetY + (y0 - pad) * scale, (x1 - x0 + 2 * pad) * scale, (y1 - y0 + 2 * pad) * scale);
  }
  ctx.restore();
  const page = doc.pages[pageIndex];
  if (!ink || !page) return;
  const o = { scale: scale * g.xh, look: l, colors: c, offsetX, offsetY };
  for (const points of page.strokes) drawWord(ctx, docWordXh(points, g.xh), o);
}

/** One document page in a new canvas, `scale` device px per mm (PNG export). */
export function documentPageCanvas(doc, pageIndex, { scale = 8, look, createCanvas } = {}) {
  const make = createCanvas || ((w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }));
  const canvas = make(Math.round(doc.page.width * scale), Math.round(doc.page.height * scale));
  drawDocumentPage(canvas.getContext('2d'), doc, pageIndex, { scale, look });
  return canvas;
}
