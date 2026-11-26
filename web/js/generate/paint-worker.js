// Draws the Schreiben canvases (the quick sheet and the A4 pages) off the main thread.
//
// A canvas in the page is handed over once (transferControlToOffscreen) and from then on
// only this worker draws on it; the page sends lists of drawing steps.  Measured on a 4x
// slowed CPU with the drawing on the main thread: a pen change on one Bleistift A4 page held
// it for 1.2 s (gathered strokes, render.js), and every frame the page copied each canvas for
// the compositor whether it had changed or not (two A4 pages: 33-50 ms frames while
// scrolling; 2 x 47 MB per frame on a quick sheet of 1 500 characters).  A handed-over
// canvas is copied only when this worker has drawn on it, and the raster happens here.
//
//   const painter = createPainterClient();
//   painter.attach('ink', canvasElement);       // or several strips: attach('ink', strip, k)
//   painter.run([{ op: 'size', id: 'ink', w, h }, { op: 'words', id: 'ink', words, scale, look, colors }]);
//   await painter.flush();                      // everything sent so far is drawn
//
// Steps of one run() are drawn in one task, so the page shows all of them or none.  Where a
// browser cannot hand a canvas over, the same steps are drawn on the main thread.
import { drawWord, drawPartial, drawSheet, drawDocumentPage, drawBands, docWordXh } from './render.js';

// The quick sheet's ink is a stack of strips this many device px tall.  A canvas that was
// drawn on is copied whole for the compositor, so with one canvas for the sheet every frame
// of the writing animation copied all of it: on 1 500 characters this worker spent 75 s of a
// 122 s run on that, and 383 of 7 216 frames took over 33 ms (on an unslowed core).  A frame
// now copies the strip or two the pen is in.  A multiple of the 64 px Bleistift grain tile,
// so the grain runs on across strips.
export const STRIP = 512;

/** Rows (device px) a word's ink can reach: its points' extent and room for the widest pen. */
function rows(points, scale, look) {
  let y0 = Infinity, y1 = -Infinity;
  for (let i = 1; i < points.length; i += 3) { if (points[i] < y0) y0 = points[i]; if (points[i] > y1) y1 = points[i]; }
  const pad = 2 * look.width * scale + 4;
  return [y0 * scale - pad, y1 * scale + pad];
}

/** Executes drawing steps on canvases (HTMLCanvasElement or OffscreenCanvas) by id. */
export function createPainter() {
  const canvases = new Map();     // id -> parts: [{ canvas, y (device px), under: { canvas, x, y, w, h } | null }]
  const make = (w, h) => (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));
  const meets = (c, [a, b]) => b > c.y && a < c.y + c.canvas.height;

  const steps = {
    size(c, { w, h }) {
      if (c.canvas.width === w && c.canvas.height === h) return;
      c.canvas.width = w; c.canvas.height = h; c.under = null;
    },
    clear(c) { c.canvas.getContext('2d').clearRect(0, 0, c.canvas.width, c.canvas.height); c.under = null; },
    /** The quick sheet's paper (render.js drawSheet). */
    sheet(c, { look, colors, g }) { drawSheet(c.canvas.getContext('2d'), c.canvas.width, c.canvas.height, look, colors, g); },
    /** A document page's paper and ruling (doc = { page, geometry }). */
    page(c, { doc, scale, look, colors }) {
      drawDocumentPage(c.canvas.getContext('2d'), { ...doc, settings: { look }, pages: [] }, 0, { scale, look, colors, ink: false });
    },
    /** Whole words; xh: document words in mm, drawn with the page's x-height as unit;
     *  styles: a document's stroke styles, parallel to words. */
    words(c, { words, styles, scale, look, colors, xh }) {
      const ctx = c.canvas.getContext('2d');
      const o = { scale: xh ? scale * xh : scale, look, colors, offsetY: -c.y, style: null };
      words.forEach((w, i) => {
        const p = xh ? docWordXh(w, xh) : w;
        o.style = styles ? styles[i] : null;
        if (meets(c, rows(p, o.scale, look))) drawWord(ctx, p, o);
      });
    },
    /** A document page's highlighter bands (mm), under the ink drawn after them. */
    bands(c, { bands, scale, colors }) { drawBands(c.canvas.getContext('2d'), bands, { scale, colors, offsetY: -c.y }); },
    /** Paper, ruling, bands and ink anew inside one device px rect [x, y, w, h] only: what
     *  a later piece took away or put under the ink, without drawing the page again.  One
     *  rect per step: a clip of several rects changed the edges of all the ink inside it
     *  (up to 3 levels on 34 pixels of a plain page), one rect only those of strokes it
     *  cuts (8-70 pixels of an A4 page, up to 120 of 765 levels summed; no visible seam). */
    region(c, { rect: [x, y, w, h], doc, bands, words, styles, scale, look, colors, xh }) {
      const ctx = c.canvas.getContext('2d');
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y - c.y, w, h);
      ctx.clip();
      drawDocumentPage(ctx, { ...doc, settings: { look }, pages: [] }, 0, { scale, look, colors, ink: false, offsetY: -c.y });
      if (bands.length) drawBands(ctx, bands, { scale, colors, offsetY: -c.y });
      steps.words(c, { words, styles, scale, look, colors, xh });
      ctx.restore();
    },
    /** Keep a copy of a box (device px) to draw a growing word over, again and again. */
    hold(c, { x, y, w, h }) {
      const top = Math.max(y, c.y), bottom = Math.min(y + h, c.y + c.canvas.height);
      if (bottom <= top) { c.under = null; return; }
      const hh = bottom - top, yy = top - c.y;
      const u = c.under && c.under.canvas.width >= w && c.under.canvas.height >= hh ? c.under.canvas : make(w, hh);
      const uc = u.getContext('2d');
      uc.clearRect(0, 0, w, hh);
      uc.drawImage(c.canvas, x, yy, w, hh, 0, 0, w, hh);
      c.under = { canvas: u, x, y: yy, w, h: hh };
    },
    /** Put the held box back; keep: hold it for the next frame too. */
    unhold(c, { keep }) {
      const u = c.under;
      if (!u) return;
      const ctx = c.canvas.getContext('2d');
      ctx.clearRect(u.x, u.y, u.w, u.h);
      ctx.drawImage(u.canvas, 0, 0, u.w, u.h, u.x, u.y, u.w, u.h);
      if (!keep) c.under = null;
    },
    /** The first n points of a word (the writing animation); xh, style: a document's
     *  stroke in mm, drawn as the words step draws it. */
    partial(c, { word, n, scale, look, colors, xh, style = null }) {
      const p = xh ? docWordXh(word, xh) : word, s = xh ? scale * xh : scale;
      if (meets(c, rows(p, s, look))) drawPartial(c.canvas.getContext('2d'), p, n, { scale: s, look, colors, offsetY: -c.y, style });
    },
    /** A highlighter band (mm) as far as x (mm): the marker going over its words.  Drawn
     *  over the ink; once it is through, its region is drawn anew with the band under it. */
    sweep(c, { band, x, scale, colors }) {
      const ctx = c.canvas.getContext('2d');
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, Math.max(0, x * scale), c.canvas.height);
      ctx.clip();
      drawBands(ctx, [band], { scale, colors, offsetY: -c.y });
      ctx.restore();
    },
    /** No bitmap at all (a page far from the viewport gives its memory back). */
    free(c) { c.canvas.width = 0; c.canvas.height = 0; c.under = null; },
  };

  return {
    /** k: the strip's place in a stack of strips (STRIP device px each). */
    attach(id, canvas, k = 0) {
      if (!canvases.has(id)) canvases.set(id, []);
      canvases.get(id)[k] = { canvas, y: k * STRIP, under: null };
    },
    run(list) {
      for (const s of list) {
        const parts = canvases.get(s.id);
        if (!parts) continue;
        if (s.op === 'drop') {                  // strips from s.from on are gone
          for (const c of parts.splice(s.from)) if (c) steps.free(c);
          continue;
        }
        for (const c of parts) if (c) steps[s.op](c, s);
      }
    },
  };
}

/** The page's side: the worker when canvases can be handed over, else the painter here. */
export function createPainterClient() {
  const offscreen = typeof OffscreenCanvas === 'function' && typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function';
  if (offscreen) {
    try {
      const worker = new Worker(new URL('./paint-worker.js', import.meta.url), { type: 'module' });
      const waiting = new Map();
      let seq = 0;
      worker.onmessage = (e) => { const done = waiting.get(e.data.flushed); if (done) { waiting.delete(e.data.flushed); done(); } };
      return {
        offThread: true,
        attach(id, canvas, k = 0) { const off = canvas.transferControlToOffscreen(); worker.postMessage({ attach: id, k, canvas: off }, [off]); },
        run(list) { if (list.length) worker.postMessage({ list }); },
        flush() { const id = ++seq; return new Promise((r) => { waiting.set(id, r); worker.postMessage({ flush: id }); }); },
      };
    } catch (_) { /* no module workers: draw here */ }
  }
  const p = createPainter();
  return { offThread: false, attach: p.attach, run: p.run, flush: () => Promise.resolve() };
}

// As a worker: steps arrive in order; each message is one task, drawn as a whole.
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  const painter = createPainter();
  self.onmessage = (e) => {
    const m = e.data;
    if (m.attach) painter.attach(m.attach, m.canvas, m.k);
    else if (m.list) painter.run(m.list);
    else if (m.flush) self.postMessage({ flushed: m.flush });
  };
}
