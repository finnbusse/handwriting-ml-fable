// Records a multi-stroke pen line through the real UI and checks the stored hwline/v1 record.
const L = require('./lib.cjs');

(async () => {
  const server = await L.start();
  const browser = await L.launch();
  try {
    const { page, cdp, errors, hfLog } = await L.newApp(browser, server);

    L.check('first run shows the start screen', await page.isVisible('#v-start'));
    await page.click('#start-go');
    await page.waitForSelector('#cap[data-state="write"]');
    L.check('"Los geht\'s" opens the capture screen', page.url().endsWith('#/erfassen'));
    await page.waitForTimeout(150);

    const prompt = await page.textContent('#cap-prompt');
    const progress = await page.textContent('#cap-progress');
    L.check('progress reads "Block 1 · Zeile 1 von N"', /^Block 1 · Zeile 1 von \d+$/.test(progress), progress);
    const rect = await L.canvasRect(page);
    const base = rect.top + rect.height * 0.64;
    const p = L.pen(cdp);

    // A finger touch on the sheet must be ignored.
    await p.touchTap(rect.left + 300, base - 10);

    // Three strokes; tiltX is 0 (a falsy value that must survive), coordinates fractional.
    const strokes = [
      L.glyph(rect.left + 80.3, base - 2.7, 14),
      L.glyph(rect.left + 130.61, base - 1.13, 9),
      [[rect.left + 190.25, base - 30.5, 0.2], [rect.left + 191.5, base - 20.25, 0.4], [rect.left + 192.75, base - 10.125, 0.6], [rect.left + 194, base, 0.7], [rect.left + 194.5, base + 1]],
    ];
    for (const s of strokes) await p.stroke(s, { tiltX: 0 });
    L.check('undo/clear/done enabled after writing', !(await page.isDisabled('#cap-done')));

    await L.settle(page);
    await page.click('#cap-done');
    await page.waitForSelector('#cap[data-state="confirm"]');
    L.check('confirm screen asks "Genau so geschrieben?"', (await page.textContent('#confirm-title')).includes('Genau so geschrieben?'));
    L.check('confirm screen shows the prompt', (await page.textContent('#confirm-prompt')) === prompt);
    await L.settle(page);
    await page.click('#confirm-ok');
    await L.until(async () => (await L.lines(page)).length === 1);
    await page.waitForSelector('#cap[data-state="write"]');

    const [entry] = await L.lines(page);
    const r = entry.record;
    const serr = L.schemaErrors(r);
    L.check('record satisfies hwline_v1.schema.json', serr.length === 0, serr.join('; '));
    const appErr = await page.evaluate(async (rec) => (await import('./js/capture/hwline.js')).validate(rec), r);
    L.check('app validator agrees', appErr.length === 0, appErr.join('; '));
    L.check('prompt and text match the shown prompt', r.prompt.text === prompt && r.text === prompt);
    L.check('stored as queued in the outbox', entry.state === 'queued');
    L.check('path contains session, prompt id and line id', entry.path === `raw/v1/${r.session_id}/${r.prompt.id}__${r.id}.json`, entry.path);
    L.check('exactly 3 strokes', r.strokes.length === 3, String(r.strokes.length));

    let samplesOk = true, detail = '';
    strokes.forEach((pts, i) => {
      const s = r.strokes[i];
      const want = pts.slice(0, -1);
      if (s.x.length !== want.length) { samplesOk = false; detail += `stroke ${i}: ${s.x.length} samples, want ${want.length}; `; return; }
      want.forEach(([x, y], j) => {
        const dx = Math.abs(s.x[j] - (x - rect.left)), dy = Math.abs(s.y[j] - (y - rect.top));
        if (dx > 0.01 || dy > 0.01) { samplesOk = false; detail += `s${i}[${j}] off by ${dx.toFixed(4)},${dy.toFixed(4)}; `; }
      });
      const [ux, uy] = pts[pts.length - 1];
      if (!s.up || Math.abs(s.up.x - (ux - rect.left)) > 0.01 || Math.abs(s.up.y - (uy - rect.top)) > 0.01) { samplesOk = false; detail += `s${i} up sample wrong; `; }
      if (s.end !== 'up') { samplesOk = false; detail += `s${i} end ${s.end}; `; }
      if (s.x.some((x, j) => Math.abs(x - (ux - rect.left)) < 1e-6 && Math.abs(s.y[j] - (uy - rect.top)) < 1e-6)) { samplesOk = false; detail += `s${i} up sample inside arrays; `; }
    });
    L.check('exactly the injected samples, in order, coordinates within 0.01 px', samplesOk, detail);
    L.check('pointer-up sample kept out of the arrays (in stroke.up)', r.strokes.every((s) => s.up && s.up.t > s.t[s.t.length - 1]));
    const ts = r.strokes.flatMap((s) => s.t);
    L.check('t strictly increasing over the whole line', ts.every((t, i) => i === 0 || t > ts[i - 1]));
    L.check('t starts at 0 (first pen-down)', ts[0] === 0);
    L.check('pressure stored as delivered', Math.abs(r.strokes[2].p[0] - 0.2) < 1e-3 && Math.abs(r.strokes[2].p[3] - 0.7) < 1e-3, JSON.stringify(r.strokes[2].p));
    L.check('tiltX 0 kept', r.strokes.every((s) => s.tiltX.length === s.x.length && s.tiltX.every((v) => v === 0)));
    L.check('finger touch ignored and counted', r.anomalies.touch_ignored >= 1 && r.strokes.length === 3, JSON.stringify(r.anomalies));
    L.check('pointer.type pen, pen_only true', r.pointer.type === 'pen' && r.pointer.pen_only === true);
    L.check('pointer.api is pointerrawupdate', r.pointer.api === 'pointerrawupdate', r.pointer.api);
    L.check('rate_hz measured (~476 Hz from injected timestamps)', r.pointer.rate_hz > 300, String(r.pointer.rate_hz));
    L.check('baseline y stored and matches the sheet', Math.abs(r.guides.baseline_y - rect.height * 0.64) < 1.5, String(r.guides.baseline_y));
    L.check('canvas size and dpr stored', r.coord.canvas_css[0] === Math.floor(rect.width) && r.coord.dpr === 2 && r.coord.canvas_px[0] === Math.floor(rect.width) * 2);
    L.check('too few strokes for the prompt -> flagged stroke_count_low', r.status === 'flagged' && r.flags.includes('stroke_count_low'), JSON.stringify(r.flags));
    L.check('no other flags', r.flags.length === 1, JSON.stringify(r.flags));

    const progress2 = await page.textContent('#cap-progress');
    L.check('progress advanced to Zeile 2', /Zeile 2 von/.test(progress2), progress2);
    L.check('indicator: 1 line waiting', (await page.textContent('#waiting-text')).startsWith('1 Zeile wartet'));

    // Undo / clear / skip.
    await p.stroke(L.glyph(rect.left + 100, base, 6));
    await p.stroke(L.glyph(rect.left + 140, base, 6));
    await L.settle(page);
    await page.click('#cap-undo');
    L.check('undo removes the last stroke', (await page.evaluate(() => window.__hw.capture.recorder.strokes.length)) === 1);
    await L.settle(page);
    await page.click('#cap-clear');
    L.check('clear removes everything', (await page.evaluate(() => window.__hw.capture.recorder.strokes.length)) === 0);
    const before = await page.textContent('#cap-prompt');
    await L.settle(page);
    await page.click('#cap-skip');
    await page.waitForTimeout(100);
    L.check('skip shows another prompt', (await page.textContent('#cap-prompt')) !== before);

    // Button guard: a tap right after a stroke is ignored.
    await p.stroke(L.glyph(rect.left + 100, base, 6));
    await page.click('#cap-done', { delay: 0 });
    L.check('tap within 300 ms after a stroke is ignored', (await page.getAttribute('#cap', 'data-state')) === 'write');

    // Leaving fullscreen during a line -> pause and write again.
    L.check('"Los geht\'s" entered fullscreen', await page.evaluate(() => !!document.fullscreenElement));
    await page.evaluate(() => document.exitFullscreen());
    await page.waitForTimeout(300);
    L.check('leaving fullscreen during a line pauses', (await page.getAttribute('#cap', 'data-state')) === 'pause');
    await L.settle(page);
    await page.click('#pause-ok');
    await page.waitForTimeout(100);
    await p.stroke(L.glyph(rect.left + 100, base, 6));

    // Resize during a line -> pause too.
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForTimeout(200);
    L.check('resize during a line pauses and asks to rewrite', (await page.getAttribute('#cap', 'data-state')) === 'pause');
    await L.settle(page);
    await page.click('#pause-ok');
    L.check('rewrite starts with an empty sheet', (await page.getAttribute('#cap', 'data-state')) === 'write' && (await page.evaluate(() => window.__hw.capture.recorder.strokes.length)) === 0);

    // Backup download contains the stored line.
    await page.goto(server.url + '#/einstellungen');
    await page.waitForFunction(() => window.__hwReady);
    await page.waitForSelector('#v-einstellungen:not([hidden])');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#backup')]);
    const text = require('fs').readFileSync(await dl.path(), 'utf8');
    const rows = text.trim().split('\n').map((l) => JSON.parse(l));
    L.check('backup .jsonl holds every local line', rows.length === 1 && rows[0].id === r.id && /\.jsonl$/.test(dl.suggestedFilename()));

    L.check('no request to Hugging Face while signed out', hfLog.length === 0, hfLog.map((h) => h.url).join(', '));
    L.check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (e) {
    console.error(e); L.check('test ran without exception', false, String(e));
  } finally {
    await browser.close(); await server.close();
  }
  process.exit(L.summary() ? 0 : 1);
})();
