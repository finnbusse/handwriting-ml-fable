// Rückgängig on a long, real-sized line in the writer's setup (Bleistift 2 px, kariert,
// light on dark, dark app theme, fractional DPR): steady, one stroke per tap, no wipe.
const L = require('./lib.cjs');
const R = require('./replay.cjs');

const SETUPS = [
  { vw: 1691, vh: 900, dsf: 2.25 },
  { vw: 1691, vh: 900, dsf: 1.75 },
];

/** Pen tap on an element's centre (CDP, like an S Pen: press and release ~60 ms later). */
async function penTap(page, cdp, sel, holdMs = 60) {
  const b = await page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
  const ev = (type) => cdp.send('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'pen', force: type === 'mouseReleased' ? 0 : 0.4 });
  await ev('mousePressed');
  await page.waitForTimeout(holdMs);
  await ev('mouseReleased');
}

const nStrokes = (page) => page.evaluate(() => window.__hw.capture.recorder.strokes.length);

/** Screen rects of everything around the sheet (they must not move). */
const rects = (page) => page.evaluate(() => ['cap-sheet', 'cap-canvas', 'cap-undo', 'cap-prompt', 'cap-done'].map((id) => {
  const b = document.getElementById(id).getBoundingClientRect(); return [b.left, b.top, b.width, b.height].join(',');
}).join(' | '));

(async () => {
  const server = await L.start();
  const browser = await L.launch();
  const line = R.longLine(40);
  console.log(`line: ${line.source}, ${line.strokes.length} strokes, ${line.strokes.reduce((n, s) => n + s.x.length, 0)} samples`);
  try {
    for (const su of SETUPS) {
      const tag = `dpr ${su.dsf}`;
      const { page, cdp, errors } = await L.newApp(browser, server, { viewport: { width: su.vw, height: su.vh }, dsf: su.dsf, colorScheme: 'dark', writer: 'finn', init: R.instrumentCanvas });
      await page.evaluate((o) => window.__hw.saveDisplay(o), { pen: 'bleistift', width: 2, paper: 'kariert', scheme: 'light_on_dark' });
      await page.waitForTimeout(200);
      const place = await R.placeLine(page, line);
      const n0 = await R.replay(page, line, place);
      L.check(`${tag}: the replayed line is recorded sample for sample`, n0 === line.strokes.length && await page.evaluate(({ src, dx, dy }) => {
        const got = window.__hw.capture.recorder.strokes;
        return got.every((s, k) => s.x.length === src[k].x.length && s.x.every((x, i) => Math.abs(x - src[k].x[i] - dx) < 1e-3 && Math.abs(s.y[i] - src[k].y[i] - dy) < 1e-3));
      }, { src: line.strokes, dx: place.dx, dy: place.dy }), `${n0}`);
      await page.waitForTimeout(400);       // the 300 ms after the last stroke

      const rectsBefore = await rects(page);
      // Writer's rhythm, nothing in between: 4 taps 150 ms apart (release to release).
      const r0 = await nStrokes(page);
      await page.evaluate(() => window.__resetOps());
      for (let i = 0; i < 4; i++) { await penTap(page, cdp, '#cap-undo'); await page.waitForTimeout(90); }
      const off = await page.evaluate(() => window.__opsOff.stroke);
      L.check(`${tag}: 4 taps 150 ms apart remove 4 strokes`, (await nStrokes(page)) === r0 - 4, `${r0} -> ${await nStrokes(page)}`);
      // Checkpoints: an undo draws at most 7 strokes off screen, not the whole line again.
      const samples = line.strokes.reduce((n, s) => n + s.x.length, 0);
      L.check(`${tag}: undo cost does not grow with the line (${off} segments drawn for 4 undos, line has ${samples})`, off < samples * 0.75, String(off));
      const t = await page.evaluate(async () => {
        const b = document.getElementById('cap-undo'); const c = document.getElementById('cap-canvas').getContext('2d');
        const t0 = performance.now(); b.dispatchEvent(new MouseEvent('click', { bubbles: true })); c.getImageData(0, 0, 1, 1);
        return performance.now() - t0;
      });
      console.log(`  ${tag}: one undo incl. raster: ${t.toFixed(1)} ms`);
      await page.waitForTimeout(100);
      // Again, now looking closely after each tap.
      const removed = [];
      let allBlit = true, opsDetail = '';
      let changedOutside = 0, pxDetail = '';
      for (let i = 0; i < 4; i++) {
        const before = await nStrokes(page);
        const bbox = await page.evaluate((k) => {
          const s = window.__hw.capture.recorder.strokes[k];
          return [Math.min(...s.x), Math.min(...s.y), Math.max(...s.x), Math.max(...s.y)];
        }, before - 1);
        const snap = await page.evaluate(() => { window.__px = window.__pixels(); window.__resetOps(); return true; });
        await penTap(page, cdp, '#cap-undo');
        const ops = await page.evaluate(() => Object.assign({}, window.__ops));
        // The visible sheet changes in one step: one image is put on it, nothing is wiped or repainted.
        if (!(ops.drawImage === 1 && ops.fillRect === 0 && ops.clearRect === 0 && ops.stroke === 0 && ops.fill === 0 && ops.putImageData === 0)) { allBlit = false; opsDetail += JSON.stringify(ops); }
        // Everything that stays is pixel for pixel what it was.
        const diff = await page.evaluate((bb) => {
          const a = window.__px, b = window.__pixels();
          const d = devicePixelRatio, m = 4;
          const x0 = Math.floor((bb[0] - m) * d), y0 = Math.floor((bb[1] - m) * d), x1 = Math.ceil((bb[2] + m) * d), y1 = Math.ceil((bb[3] + m) * d);
          let n = 0;
          for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) {
            if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue;
            const o = (y * b.width + x) * 4;
            if (a.data[o] !== b.data[o] || a.data[o + 1] !== b.data[o + 1] || a.data[o + 2] !== b.data[o + 2]) n++;
          }
          return n;
        }, bbox);
        changedOutside += diff; if (diff) pxDetail += `tap ${i}: ${diff} px; `;
        removed.push(before - await nStrokes(page));
        await page.waitForTimeout(90);     // 60 ms contact + 90 ms = 150 ms between taps
      }
      L.check(`${tag}: 4 quick taps (150 ms apart) remove exactly 4 strokes, one each`, removed.every((r) => r === 1), JSON.stringify(removed));
      L.check(`${tag}: each undo puts one finished image on the sheet (no wipe, no stroke-by-stroke repaint)`, allBlit, opsDetail);
      L.check(`${tag}: strokes that stay are pixel-identical after each undo`, changedOutside === 0, pxDetail);
      L.check(`${tag}: nothing on the screen moves`, (await rects(page)) === rectsBefore);
      const cmp = await page.evaluate(() => {
        const a = window.__pixels();
        window.__hw.capture.redraw();
        const b = window.__pixels();
        let n = 0; for (let i = 0; i < a.data.length; i += 4) if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) n++;
        return n;
      });
      L.check(`${tag}: the sheet after undo equals a full redraw from scratch (0 px differ)`, cmp === 0, String(cmp));

      // A tap inside the 300 ms after a stroke does nothing, and does not look pressed either.
      await R.replay(page, line, place, n0 - 4, n0 - 3);
      const b = await page.evaluate(() => { const r = document.getElementById('cap-undo').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      const nq = await nStrokes(page);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.4 });
      await page.waitForTimeout(120);
      const pressed = await page.evaluate(() => getComputedStyle(document.getElementById('cap-undo')).transform);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen', force: 0 });
      await page.waitForTimeout(50);
      L.check(`${tag}: a tap right after a stroke is ignored and the button does not look pressed`, (await nStrokes(page)) === nq && pressed === 'none', pressed);
      await page.waitForTimeout(400);
      const nl = await nStrokes(page);
      await penTap(page, cdp, '#cap-undo');
      L.check(`${tag}: the next tap after the quiet time works`, (await nStrokes(page)) === nl - 1);
      L.check(`${tag}: no page errors`, errors.length === 0, errors.join(' | '));
      await page.context().close();
    }
  } catch (e) {
    console.error(e); L.check('test ran without exception', false, String(e));
  } finally {
    await browser.close(); await server.close();
  }
  process.exit(L.summary() ? 0 : 1);
})();
