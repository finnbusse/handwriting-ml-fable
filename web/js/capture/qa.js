// Automatic checks on a finished line (SPEC 2.3). Pure functions, no DOM, so
// they can be unit-tested in Node.

export const LIMITS = {
  strokesPerCharMin: 0.4,
  strokesPerCharMax: 2.0,
  minRateHz: 100,
  strayFarMinPx: 60,      // a stray stroke is at least this far from all other ink ...
  strayFarXh: 2.5,        // ... and at least this many typical stroke heights
  strayTinyXh: 0.35,      // tiny = bbox smaller than this many typical stroke heights ...
  strayTinyMinPx: 6,      // ... or than this many px
};

/** German hint per flag, shown on the confirm screen. */
export const HINTS = {
  stroke_count_low: 'Weniger Striche als erwartet. Fehlt ein Teil der Zeile?',
  stroke_count_high: 'Viel mehr Striche als erwartet. Ist etwas doppelt oder durchgestrichen?',
  stray_stroke: 'Ein kleiner Strich liegt weit weg vom Text. Vielleicht hat der Stift aus Versehen aufgetippt.',
  out_of_bounds: 'Ein Teil der Schrift ging über den Rand des Blatts.',
  pointercancel: 'Ein Strich wurde vom Gerät abgebrochen.',
  button_pressed: 'Die Taste am Stift war gedrückt.',
  low_rate: 'Der Stift hat nur wenige Punkte geliefert. Die Zeile ist vielleicht ungenau.',
  layout_changed: 'Die Ansicht hat sich beim Schreiben verändert.',
};

function bbox(s) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < s.x.length; i++) {
    const x = s.x[i], y = s.y[i];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

function boxDist(a, b) {
  const dx = Math.max(0, a.x0 - b.x1, b.x0 - a.x1);
  const dy = Math.max(0, a.y0 - b.y1, b.y0 - a.y1);
  return Math.hypot(dx, dy);
}

const median = (arr) => {
  if (!arr.length) return NaN;
  const a = arr.slice().sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/** Pen rate: 1000 / median dt inside strokes. */
export function rateHz(strokes) {
  const dts = [];
  for (const s of strokes) for (let i = 1; i < s.t.length; i++) dts.push(s.t[i] - s.t[i - 1]);
  const m = median(dts);
  return m > 0 ? Math.round((1000 / m) * 10) / 10 : null;
}

export function countDtOver(strokes, ms) {
  let n = 0;
  for (const s of strokes) for (let i = 1; i < s.t.length; i++) if (s.t[i] - s.t[i - 1] > ms) n++;
  return n;
}

/** Indices of tiny strokes far from all other ink. */
export function strayStrokes(strokes) {
  if (strokes.length < 2) return [];
  const boxes = strokes.map(bbox);
  const typical = Math.max(10, median(boxes.map((b) => Math.max(b.w, b.h))));
  const out = [];
  boxes.forEach((b, i) => {
    const size = Math.max(b.w, b.h);
    const tiny = size < Math.max(LIMITS.strayTinyMinPx, LIMITS.strayTinyXh * typical);
    if (!tiny) return;
    let nearest = Infinity;
    boxes.forEach((o, j) => { if (j !== i) nearest = Math.min(nearest, boxDist(b, o)); });
    if (nearest > Math.max(LIMITS.strayFarMinPx, LIMITS.strayFarXh * typical)) out.push(i);
  });
  return out;
}

/**
 * line: {text, strokes, canvas: [w,h], layoutChanged, rate}
 * returns sorted unique flag names
 */
export function check(line) {
  const flags = new Set();
  const strokes = line.strokes || [];
  const chars = [...(line.text || '')].filter((c) => !/\s/.test(c)).length;
  if (chars > 0) {
    const per = strokes.length / chars;
    if (per < LIMITS.strokesPerCharMin) flags.add('stroke_count_low');
    if (per > LIMITS.strokesPerCharMax) flags.add('stroke_count_high');
  }
  if (strayStrokes(strokes).length) flags.add('stray_stroke');
  if (line.canvas) {
    const [w, h] = line.canvas;
    const out = strokes.some((s) => s.x.some((x, i) => x < 0 || x > w || s.y[i] < 0 || s.y[i] > h));
    if (out) flags.add('out_of_bounds');
  }
  if (strokes.some((s) => s.end === 'cancel')) flags.add('pointercancel');
  if (strokes.some((s) => s.button || (s.buttons !== undefined && s.buttons !== 1))) flags.add('button_pressed');
  const rate = line.rate !== undefined ? line.rate : rateHz(strokes);
  if (rate !== null && rate < LIMITS.minRateHz) flags.add('low_rate');
  if (line.layoutChanged) flags.add('layout_changed');
  return [...flags].sort();
}
