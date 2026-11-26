// Replays a whole recorded line through the capture screen the way Chrome delivers an S Pen:
// one pointerrawupdate per sample, and about every 8 samples a pointermove whose coalesced
// list repeats the samples since the last one (the recorder de-duplicates them by time).
// Lines come from the writer's real recordings when they are on this machine, else from a
// synthetic line of the same size (42 strokes, ~3700 samples at 476 Hz, x-height ~7 px).
const fs = require('fs');
const path = require('path');

const REAL = path.resolve(__dirname, '..', '..', 'data_cache', 'finnbusse__handwriting-fable', 'raw', 'v1', 'finn');
const REAL_ALT = '/home/user/handwriting-ml-fable/data_cache/finnbusse__handwriting-fable/raw/v1/finn';

/** All real lines of the writer that are on this machine (read-only), or []. */
function realLines() {
  if (process.env.HW_SYNTHETIC_ONLY) return [];   // as on a machine without the recordings
  const dir = fs.existsSync(REAL) ? REAL : fs.existsSync(REAL_ALT) ? REAL_ALT : null;
  if (!dir) return [];
  const out = [];
  for (const d of fs.readdirSync(dir)) {
    const sub = path.join(dir, d);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const f of fs.readdirSync(sub)) if (f.endsWith('.json')) {
      try { out.push(JSON.parse(fs.readFileSync(path.join(sub, f), 'utf8'))); } catch (_) {}
    }
  }
  return out;
}

/** A long real line (>= minStrokes), or a synthetic one when none is available. */
function longLine(minStrokes = 40) {
  const real = realLines().filter((r) => r.strokes && r.strokes.length >= minStrokes && r.strokes.every((s) => s.up));
  if (real.length) {
    real.sort((a, b) => b.strokes.reduce((n, s) => n + s.x.length, 0) - a.strokes.reduce((n, s) => n + s.x.length, 0));
    return { source: `real ${real[0].prompt.id}`, strokes: real[0].strokes, baseline: real[0].guides.baseline_y };
  }
  return { source: 'synthetic', strokes: syntheticLine(42), baseline: 0 };
}

/** Small cursive-like strokes from left to right; baseline at y = 0 (shifted on replay). */
function syntheticLine(n) {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const strokes = [];
  let t = 0, x = 0;
  for (let k = 0; k < n; k++) {
    const dot = k % 9 === 8;
    const m = dot ? 4 : 60 + Math.floor(rnd() * 60);
    const s = { x: [], y: [], t: [], p: [], tiltX: [], tiltY: [], buttons: 1, end: 'up', up: null };
    const w = 8 + rnd() * 6, h = 6 + rnd() * 3;
    const x0 = dot ? x - 6 : x, y0 = dot ? -12 : 0;
    for (let i = 0; i < m; i++) {
      const u = i / Math.max(1, m - 1), a = u * Math.PI * 3;
      s.x.push(Math.round((x0 + (dot ? i * 0.3 : u * w + Math.sin(a) * 2.2)) * 1e4) / 1e4);
      s.y.push(Math.round((y0 - (dot ? i * 0.2 : (1 - Math.cos(a)) * h * 0.5)) * 1e4) / 1e4);
      s.t.push(Math.round(t * 100) / 100);
      s.p.push(Math.round((0.18 + 0.3 * Math.sin(u * Math.PI) + rnd() * 0.05) * 1e4) / 1e4);
      s.tiltX.push(-20 + Math.round(rnd() * 4)); s.tiltY.push(35 + Math.round(rnd() * 4));
      t += 2.0 + rnd() * 0.2;
    }
    s.up = { t: Math.round((t + 1) * 100) / 100, x: s.x[m - 1], y: s.y[m - 1] };
    strokes.push(s);
    t += 120 + rnd() * 260;
    if (!dot) x += w + 2 + rnd() * 3;
  }
  return strokes;
}

/** Shift a line so it starts near the left edge and sits on the sheet's baseline. */
async function placeLine(page, line) {
  const r = await page.evaluate(() => { const b = document.getElementById('cap-canvas').getBoundingClientRect(); return { w: b.width, h: b.height }; });
  const xs = line.strokes.flatMap((s) => s.x);
  const dx = Math.round(48 - Math.min(...xs));
  const baseline = Math.round(Math.floor(r.h) * 0.64) + 0.5;
  return { dx, dy: baseline - line.baseline, width: Math.max(...xs) + dx, canvasW: r.w };
}

/**
 * In the page: dispatch the strokes [from, to) with synthetic PointerEvents. Times are
 * placed in the past (so later CDP pen input is newer) and kept relative to each other.
 */
async function replay(page, line, place, from = 0, to = line.strokes.length) {
  return page.evaluate(async ({ strokes, dx, dy, from, to }) => {
    const cv = document.getElementById('cap-canvas');
    const rect = cv.getBoundingClientRect();
    const span = strokes[to - 1].up.t - strokes[from].t[0];
    const base = performance.now() - span - 2000 - strokes[from].t[0];
    const mk = (type, s, i, T, extra = {}) => {
      const e = new PointerEvent(type, Object.assign({
        pointerId: 7, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true, composed: true,
        clientX: rect.left + s.x[i] + dx, clientY: rect.top + s.y[i] + dy, pressure: s.p[i],
        tiltX: s.tiltX[i], tiltY: s.tiltY[i], buttons: 1, button: type === 'pointerdown' ? 0 : -1, width: 1, height: 1,
      }, extra));
      Object.defineProperty(e, 'timeStamp', { value: T });
      return e;
    };
    for (let k = from; k < to; k++) {
      const s = strokes[k];
      cv.dispatchEvent(mk('pointerdown', s, 0, base + s.t[0]));
      let pending = [];
      for (let i = 1; i < s.x.length; i++) {
        const T = base + s.t[i];
        const ce = mk('pointerrawupdate', s, i, T);
        cv.dispatchEvent(mk('pointerrawupdate', s, i, T, { coalescedEvents: [ce] }));
        pending.push(mk('pointermove', s, i, T));
        if (pending.length >= 8 || i === s.x.length - 1) {
          cv.dispatchEvent(mk('pointermove', s, i, T, { coalescedEvents: pending }));
          pending = [];
          await new Promise((res) => setTimeout(res, 0));
        }
      }
      const up = new PointerEvent('pointerup', { pointerId: 7, pointerType: 'pen', isPrimary: true, bubbles: true,
        clientX: rect.left + s.up.x + dx, clientY: rect.top + s.up.y + dy, pressure: 0, buttons: 0, button: 0 });
      Object.defineProperty(up, 'timeStamp', { value: base + s.up.t });
      cv.dispatchEvent(up);
    }
    return window.__hw.capture.recorder.strokes.length;
  }, { strokes: line.strokes, dx: place.dx, dy: place.dy, from, to });
}

/**
 * Init script: count what is drawn on the visible writing canvas (#cap-canvas), so a test
 * can tell a single blit from a wipe-and-repaint.
 */
function instrumentCanvas() {
  const P = CanvasRenderingContext2D.prototype;
  window.__ops = { fillRect: 0, clearRect: 0, stroke: 0, fill: 0, drawImage: 0, putImageData: 0 };
  for (const k of Object.keys(window.__ops)) {
    const o = P[k];
    P[k] = function (...a) { if (this.canvas && this.canvas.id === 'cap-canvas') window.__ops[k]++; else window.__opsOff[k]++; return o.apply(this, a); };
  }
  window.__opsOff = Object.assign({}, window.__ops);
  window.__resetOps = () => { for (const k of Object.keys(window.__ops)) { window.__ops[k] = 0; window.__opsOff[k] = 0; } };
  window.__pixels = () => { const c = document.getElementById('cap-canvas'); return c.getContext('2d').getImageData(0, 0, c.width, c.height); };
}

/** Pen tap on an element's centre (CDP, like an S Pen: press, release ~60 ms later). */
async function penTap(page, cdp, sel, holdMs = 60) {
  const b = await page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
  const ev = (type) => cdp.send('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'pen', force: type === 'mouseReleased' ? 0 : 0.4 });
  await ev('mousePressed');
  await page.waitForTimeout(holdMs);
  await ev('mouseReleased');
}

/**
 * A point on stroke k (canvas CSS px) that no other stroke comes within `clear` px of,
 * so an eraser tap there can only mean stroke k.
 */
function lonelyPoint(strokes, k, clear = 4) {
  const s = strokes[k];
  let best = null, bestD = -1;
  for (let i = 0; i < s.x.length; i++) {
    let d = Infinity;
    strokes.forEach((o, j) => { if (j !== k) for (let m = 0; m < o.x.length; m++) d = Math.min(d, Math.hypot(o.x[m] - s.x[i], o.y[m] - s.y[i])); });
    if (d > bestD) { bestD = d; best = [s.x[i], s.y[i]]; }
  }
  return bestD >= clear ? best : null;
}

module.exports = { realLines, longLine, syntheticLine, placeLine, replay, instrumentCanvas, penTap, lonelyPoint };
