// How the writing sheet looks (SPEC 2.3): pen kind, ink width, paper, colours.
// Only what the writer SEES is decided here. The recorder and the stored samples never
// depend on any of it; the chosen look is reported in the record's `guides` only.
//
// Drawing is per segment (sample i-1 -> i), each with its own width and colour, in the
// order the samples arrived. Incremental drawing (a few new samples per pointer event)
// and a full redraw (undo, clear, option change, resize) therefore issue exactly the
// same canvas operations and give the same pixels.

export const WIDTHS = [0.75, 1, 1.5, 2, 3];               // CSS px, "sehr fein" .. "dick"
export const PENS = ['fineliner', 'fueller', 'bleistift'];
export const PAPERS = ['linie', 'liniert', 'kariert'];
export const SCHEMES = ['dark_on_light', 'light_on_dark'];
export const SPACING = 28;                                // ruled / squared paper, CSS px (~5 mm on the tablet)
export const DEFAULTS = Object.freeze({ pen: 'fineliner', width: 1, paper: 'linie', scheme: 'dark_on_light' });

const BASELINE_FRAC = 0.64;     // baseline position inside the band (unchanged for every paper)
const GUIDE_INSET = 32;         // baseline starts/ends this far inside the band
const EDGE = 6;                 // no paper line closer than this to the sheet edge
const TAU_MS = 9;               // pressure smoothing (Füller width, Bleistift tone)
const TONES = 8;                // Bleistift: pressure levels, one grain pattern each
const GRAIN = 64;               // grain tile, device px

/** Any stored or half-valid object -> a complete, valid set of options. */
export function normalize(o) {
  const v = o && typeof o === 'object' ? o : {};
  return {
    pen: PENS.includes(v.pen) ? v.pen : DEFAULTS.pen,
    width: WIDTHS.includes(v.width) ? v.width : DEFAULTS.width,
    paper: PAPERS.includes(v.paper) ? v.paper : DEFAULTS.paper,
    scheme: SCHEMES.includes(v.scheme) ? v.scheme : DEFAULTS.scheme,
  };
}

export const sameDisplay = (a, b) => a.pen === b.pen && a.width === b.width && a.paper === b.paper && a.scheme === b.scheme;

/**
 * Everything drawn on a sheet of w x h CSS px besides ink, in stroke coordinates.
 * The baseline sits where it always did, whatever the paper.
 */
export function computeGuides(w, h, display) {
  const d = normalize(display);
  const baseline = Math.round(h * BASELINE_FRAC) + 0.5;   // .5: crisp 1 px line
  const inset = Math.min(GUIDE_INSET, Math.round(w * 0.04));
  const ys = [], xs = [];
  if (d.paper !== 'linie') {
    for (let y = baseline - SPACING; y >= EDGE; y -= SPACING) ys.push(y);
    ys.reverse();
    for (let y = baseline + SPACING; y <= h - EDGE; y += SPACING) ys.push(y);
  }
  if (d.paper === 'kariert') {
    const x0 = inset + 0.5;
    for (let x = x0 - SPACING * Math.floor((x0 - EDGE) / SPACING); x <= w - EDGE; x += SPACING) xs.push(x);
  }
  const g = {
    visible: true, baseline_y: baseline, x_start: inset, x_end: w - inset,
    extra_lines_y: ys, ink_width_css: d.width, pressure_width: d.pen === 'fueller',
    pen: d.pen, paper: d.paper, scheme: d.scheme,
  };
  if (d.paper !== 'linie') g.spacing_css = SPACING;
  if (xs.length) g.extra_lines_x = xs;
  return g;
}

// ---------- colours ----------

const colorCache = {};

/** Sheet colours for a scheme, from the CSS tokens --paper-light-* / --paper-dark-*. */
export function schemeColors(scheme) {
  if (colorCache[scheme]) return colorCache[scheme];
  const dark = scheme === 'light_on_dark';
  const cs = getComputedStyle(document.documentElement);
  const k = dark ? 'dark' : 'light';
  const get = (n, fb) => cs.getPropertyValue(`--paper-${k}-${n}`).trim() || fb;
  const c = {
    scheme, dark,
    paper: get('bg', dark ? '#1B1F26' : '#FFFFFF'),
    ink: get('ink', dark ? '#C9D4FF' : '#2141B8'),
    graphite: get('graphite', dark ? '#E9ECF1' : '#2B2E34'),
    rule: get('rule', dark ? '#52637F' : '#9DB0CB'),
    faint: get('faint', dark ? '#2F3746' : '#DFE5EE'),
  };
  if (cs.getPropertyValue(`--paper-${k}-bg`).trim()) colorCache[scheme] = c;   // cache only real tokens
  return c;
}

export function hexRgb(hex) {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  const n = parseInt(f.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG contrast ratio of two #rrggbb colours. */
export function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = hexRgb(hex).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Bleistift tone (0 = paper, 1 = full graphite) for tone level k. */
export const pencilTone = (k) => 0.54 + 0.42 * (k / (TONES - 1));

/** The colour a Bleistift stroke of tone level k has without grain (for contrast checks). */
export function pencilColor(colors, k) {
  const p = hexRgb(colors.paper), g = hexRgb(colors.graphite), m = pencilTone(k);
  return '#' + p.map((v, i) => Math.round(v + (g[i] - v) * m).toString(16).padStart(2, '0')).join('');
}

// ---------- paper ----------

/** Paper, faint lines, baseline. lw = width of one guide line in user units (1 / scale). */
export function drawPaper(c, w, h, guides, colors, lw = 1) {
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = 1;
  c.fillStyle = colors.paper; c.fillRect(0, 0, w, h);
  if (!guides) return;
  c.lineWidth = lw; c.lineCap = 'butt';
  const ys = guides.extra_lines_y || [], xs = guides.extra_lines_x || [];
  if (ys.length || xs.length) {
    const grid = xs.length > 0;
    const x0 = grid ? 0 : guides.x_start, x1 = grid ? w : guides.x_end;
    c.strokeStyle = colors.faint;
    c.beginPath();
    for (const y of ys) { c.moveTo(x0, y); c.lineTo(x1, y); }
    for (const x of xs) { c.moveTo(x, 0); c.lineTo(x, h); }
    c.stroke();
  }
  c.strokeStyle = colors.rule;
  c.beginPath(); c.moveTo(guides.x_start, guides.baseline_y); c.lineTo(guides.x_end, guides.baseline_y); c.stroke();
}

// ---------- ink ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One opaque grain tile per tone level: paper tooth leaves lighter specks in the graphite. */
function makeGrain(c, colors, devScale) {
  const rnd = mulberry32(20241125);
  const n = GRAIN * GRAIN;
  const noise = new Float32Array(n);
  for (let i = 0; i < n; i++) { const r = rnd(); noise[i] = r * r * r; }   // mostly solid, some light specks
  const p = hexRgb(colors.paper), g = hexRgb(colors.graphite);
  const tile = document.createElement('canvas');
  tile.width = GRAIN; tile.height = GRAIN;
  const tc = tile.getContext('2d');
  const img = tc.createImageData(GRAIN, GRAIN);
  const m = new DOMMatrix([1 / devScale, 0, 0, 1 / devScale, 0, 0]);
  const out = [];
  for (let k = 0; k < TONES; k++) {
    const tone = pencilTone(k);
    for (let i = 0; i < n; i++) {
      const t = tone * (1 - 0.5 * noise[i]);
      img.data[i * 4] = Math.round(p[0] + (g[0] - p[0]) * t);
      img.data[i * 4 + 1] = Math.round(p[1] + (g[1] - p[1]) * t);
      img.data[i * 4 + 2] = Math.round(p[2] + (g[2] - p[2]) * t);
      img.data[i * 4 + 3] = 255;
    }
    tc.putImageData(img, 0, 0);
    const pat = c.createPattern(tile, 'repeat');
    if (pat.setTransform) pat.setTransform(m);     // grain at device-pixel size
    out.push(pat);
    // createPattern copies the tile, so the same canvas can be reused for the next level.
  }
  return out;
}

const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);

/**
 * A renderer for one 2D context. configure() before drawing (cheap when nothing changed);
 * draw(stroke, from) draws the samples from index `from` on, as the recorder delivers them.
 */
export function createInk(c) {
  let pen = DEFAULTS.pen, width = DEFAULTS.width, colors = null, devScale = 1;
  let grain = null, grainKey = '';
  // Smoothing state of the stroke drawn last; a different stroke or a jump replays it.
  const st = { s: null, next: 0, pe: 0 };
  let lastW = -1, lastStyle = null;

  function configure(display, cols, deviceScale) {
    pen = display.pen; width = display.width; colors = cols; devScale = deviceScale || 1;
    if (pen === 'bleistift') {
      const key = `${cols.paper}|${cols.graphite}|${devScale}`;
      if (key !== grainKey) { grain = makeGrain(c, cols, devScale); grainKey = key; }
    }
    st.s = null; lastW = -1; lastStyle = null;
  }

  /** Fold sample i into the smoothed pressure. */
  function advance(s, i) {
    const p = clamp01(s.p[i]);
    if (i === 0) { st.pe = p; return; }
    const dt = s.t[i] - s.t[i - 1];
    st.pe += (p - st.pe) * (1 - Math.exp(-(dt > 0 ? dt : 0) / TAU_MS));
  }

  function lineWidthNow() {
    if (pen !== 'fueller') return width;
    // Thin on light pressure, fuller on firm pressure; nominal width at pressure 0.5.
    const k = 0.4 + 1.2 * st.pe;
    return width * (k < 1.6 ? k : 1.6);
  }

  function styleNow() {
    if (pen !== 'bleistift') return colors.ink;
    let k = Math.round(st.pe * 1.25 * (TONES - 1));    // pencil pressure seldom reaches 1
    if (k > TONES - 1) k = TONES - 1;
    return grain[k];
  }

  function draw(s, from) {
    if (!colors) return;
    const n = s.x.length;
    if (!n || from >= n) return;
    if (st.s !== s || st.next !== from) {
      st.s = s; st.pe = 0;
      for (let i = 0; i < from; i++) advance(s, i);
    }
    c.globalAlpha = 1;
    // Graphite: overlapping segments of one stroke must not pile up, and a faint line
    // under it should show through: keep the darker (lighter on a dark sheet) of both.
    c.globalCompositeOperation = pen === 'bleistift' ? (colors.dark ? 'lighten' : 'darken') : 'source-over';
    c.lineCap = 'round'; c.lineJoin = 'round';
    lastW = -1; lastStyle = null;
    for (let i = from; i < n; i++) {
      advance(s, i);
      const w = lineWidthNow(), style = styleNow();
      if (style !== lastStyle) { c.strokeStyle = style; c.fillStyle = style; lastStyle = style; }
      if (i === 0) {
        c.beginPath(); c.arc(s.x[0], s.y[0], w / 2, 0, Math.PI * 2); c.fill();
      } else {
        if (w !== lastW) { c.lineWidth = w; lastW = w; }
        c.beginPath(); c.moveTo(s.x[i - 1], s.y[i - 1]); c.lineTo(s.x[i], s.y[i]); c.stroke();
      }
    }
    st.next = n;
    c.globalCompositeOperation = 'source-over';
  }

  return { configure, draw };
}
