// Edge cases of removing writing: time bases, anomaly counters, a stray first stroke, a palm in
// finger mode, the way back from the confirm screen, and a toolbar that fits at every width.
const L = require('./lib.cjs');
const R = require('./replay.cjs');

const LOOK = { pen: 'bleistift', width: 2, paper: 'kariert', scheme: 'light_on_dark' };
const nStrokes = (page) => page.evaluate(() => window.__hw.capture.recorder.strokes.length);
const mode = (page) => page.getAttribute('#cap', 'data-mode');
const quiet = (page) => page.waitForTimeout(400);
const tap = async (page, cdp, sel) => { await R.penTap(page, cdp, sel); await page.waitForTimeout(120); };

async function app(browser, server, viewport = { width: 1280, height: 680 }) {
  const a = await L.newApp(browser, server, { viewport, dsf: 2.25, colorScheme: 'dark', writer: 'finn' });
  await a.page.evaluate((o) => window.__hw.saveDisplay(o), LOOK);
  await a.page.waitForTimeout(150);
  a.rect = await L.canvasRect(a.page);
  a.base = a.rect.top + Math.round(a.rect.height * 0.64) + 0.5;
  a.P = L.pen(a.cdp);
  a.glyph = (i) => a.P.stroke(L.glyph(a.rect.left + 80 + i * 26, a.base, 8));
  return a;
}

async function accept(page, cdp) {
  await tap(page, cdp, '#cap-done');
  await page.waitForSelector('#cap[data-state="confirm"]');
  await quiet(page);
  const before = (await L.lines(page)).length;
  await tap(page, cdp, '#confirm-ok');
  await L.until(async () => (await L.lines(page)).length === before + 1);
  const recs = await L.lines(page);
  return recs[recs.length - 1].record;
}

async function valid(page, rec, tag) {
  const se = L.schemaErrors(rec);
  const ve = await page.evaluate(async (r) => (await import('./js/capture/hwline.js')).validate(r), rec);
  L.check(`${tag}: record satisfies the schema and the app validator`, se.length === 0 && ve.length === 0, se.concat(ve).join('; '));
}

/** Toolbar measurements: every visible button 48x48 or more, one row, nothing cut off or scrolling. */
function toolbarFit(page) {
  return page.evaluate(() => {
    const tb = document.querySelector('.cap-tools');
    const bs = [...tb.querySelectorAll('.btn')].filter((b) => b.offsetParent);
    const top = bs.length ? bs[0].getBoundingClientRect().top : 0;
    const bad = bs.filter((b) => { const r = b.getBoundingClientRect(); return r.width < 48 || r.height < 48 || r.left < 0 || r.right > innerWidth || Math.abs(r.top - top) > 1 || b.scrollWidth > b.clientWidth; })
      .map((b) => `${b.id}:${Math.round(b.getBoundingClientRect().width)}@${Math.round(b.getBoundingClientRect().right)}`);
    const label = (id) => { const b = document.getElementById(id); const s = b && b.querySelector('span'); return !!(b && b.offsetParent && s && getComputedStyle(s).display !== 'none' && tb.contains(b)); };
    return { bad, over: tb.scrollWidth > tb.clientWidth, doc: document.documentElement.scrollWidth, iw: innerWidth,
      ids: bs.map((b) => b.id), lookLabel: label('cap-look'), fsLabel: label('cap-fs'), doneLabel: label('cap-done') };
  });
}

(async () => {
  const server = await L.start();
  const browser = await L.launch();
  try {
    // ---------- removed_t across a Löschen that was taken back ----------
    {
      const { page, cdp, ctx, glyph, errors } = await app(browser, server);
      await glyph(0); await glyph(1);
      await quiet(page);
      const tb1 = await page.evaluate(() => window.__hw.capture.recorder.timeBase);
      await tap(page, cdp, '#cap-clear');
      await page.waitForTimeout(250);
      await glyph(2);
      await quiet(page);
      const c = await page.evaluate(() => { const r = window.__hw.capture.recorder; const s = r.strokes[0]; return { tb: r.timeBase, t0: s.t[0], t1: s.t[s.t.length - 1] }; });
      await tap(page, cdp, '#cap-undo');      // C goes (the line is empty again)
      await tap(page, cdp, '#cap-undo');      // Löschen taken back: A and B on their old time base
      L.check('Löschen taken back: A and B are back on their own time base', (await nStrokes(page)) === 2 && (await page.evaluate(() => window.__hw.capture.recorder.timeBase)) === tb1);
      await quiet(page);
      await glyph(3);
      await quiet(page);
      const rec = await accept(page, cdp);
      await valid(page, rec, 'time bases');
      const r2 = (v) => Math.round(v * 100) / 100;
      const want = [r2(c.t0 + c.tb - tb1), r2(c.t1 + c.tb - tb1)];
      const bEnd = rec.strokes[1].t[rec.strokes[1].t.length - 1], dStart = rec.strokes[2].t[0];
      L.check('removed_t holds the stroke written after Löschen, moved into the record\'s time base',
        rec.edits.removed_t.some(([a, b]) => Math.abs(a - want[0]) < 0.02 && Math.abs(b - want[1]) < 0.02) && want[0] > bEnd && want[1] < dStart,
        JSON.stringify({ removed_t: rec.edits.removed_t, want, bEnd, dStart }));
      L.check('… and every stored stroke keeps its raw timestamps (strictly increasing)', rec.strokes.flatMap((s) => s.t).every((t, i, a) => i === 0 || t > a[i - 1]));
      L.check('time bases: no page errors', errors.length === 0, errors.join(' | '));
      await ctx.close();
    }

    // ---------- anomaly counters follow the attempt (Löschen starts them over) ----------
    {
      const { page, cdp, ctx, glyph, rect, P } = await app(browser, server);
      await glyph(0); await glyph(1);
      await P.touchTap(rect.left + 400, rect.top + 60);       // a finger: ignored and counted
      await quiet(page);
      const ti = () => page.evaluate(() => window.__hw.capture.recorder.anomalies.touch_ignored);
      L.check('a finger on the sheet is counted', (await ti()) === 1);
      await tap(page, cdp, '#cap-clear');
      L.check('Löschen: the counters start over with the line', (await ti()) === 0);
      await tap(page, cdp, '#cap-undo');
      L.check('Rückgängig after Löschen brings the counters back with the strokes', (await ti()) === 1 && (await nStrokes(page)) === 2);
      await tap(page, cdp, '#cap-again');
      await quiet(page);
      for (let i = 0; i < 3; i++) await glyph(i);
      await quiet(page);
      const rec = await accept(page, cdp);
      await valid(page, rec, 'anomalies');
      L.check('the rewritten line does not carry the cleared attempt\'s finger touch', rec.anomalies.touch_ignored === 0 && rec.strokes.length === 3, JSON.stringify(rec.anomalies));
      await ctx.close();
    }

    // ---------- a stray mark as the very first stroke ----------
    {
      const { page, cdp, ctx, glyph, rect, P } = await app(browser, server);
      await P.stroke([[rect.left + 700, rect.top + 30, 0.3], [rect.left + 700.6, rect.top + 30.4, 0.3], [rect.left + 701, rect.top + 30.6]]);
      for (let i = 0; i < 6; i++) await glyph(i);
      await quiet(page);
      const stray = await page.evaluate(async () => (await import('./js/capture/qa.js')).strayStrokes(window.__hw.capture.recorder.strokes));
      L.check('qa calls the first dot stray', JSON.stringify(stray) === '[0]', JSON.stringify(stray));
      const kept = await page.evaluate(() => JSON.stringify(window.__hw.capture.recorder.strokes.slice(1).map((s) => [s.x, s.y, s.t])));
      await tap(page, cdp, '#cap-erase');
      await R.penTap(page, cdp, '#cap-canvas');   // anywhere first (blank): nothing chosen
      await P.stroke([[rect.left + 700.4, rect.top + 30.3], [rect.left + 700.4, rect.top + 30.3], [rect.left + 700.4, rect.top + 30.3]]);
      L.check('a tap on the first dot chooses only it', (await page.textContent('#erase-status')) === 'Nur dieser Fleck wird entfernt.');
      await quiet(page);
      await tap(page, cdp, '#erase-ok');
      await quiet(page);
      const rec = await accept(page, cdp);
      await valid(page, rec, 'stray first');
      L.check('the stored strokes are the rest, unchanged (t not shifted)', JSON.stringify(rec.strokes.map((s) => [s.x, s.y, s.t])) === kept && rec.strokes[0].t[0] > 0, String(rec.strokes[0].t[0]));
      L.check('removed_t starts at 0: t = 0 belongs to the removed dot', rec.edits.spot === 1 && rec.edits.removed_t.length === 1 && rec.edits.removed_t[0][0] === 0, JSON.stringify(rec.edits));
      await ctx.close();
    }

    // ---------- finger mode: a resting palm does not hold the eraser ----------
    {
      const { page, cdp, ctx, glyph, rect } = await app(browser, server);
      await page.evaluate(() => window.__hw.capture.setPenOnly(false));
      for (let i = 0; i < 6; i++) await glyph(i);
      await quiet(page);
      const pts = await page.evaluate(() => window.__hw.capture.recorder.strokes.map((s) => [s.x[4], s.y[4]]));
      await tap(page, cdp, '#cap-erase');
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rect.left + pts[1][0], y: rect.top + pts[1][1], id: 1 }] });
      await page.waitForTimeout(60);
      const palm = await page.evaluate(() => window.__hw.capture.eraser);
      const P = L.pen(cdp);
      await P.stroke([[rect.left + pts[4][0], rect.top + pts[4][1]], [rect.left + pts[4][0], rect.top + pts[4][1]], [rect.left + pts[4][0], rect.top + pts[4][1]]]);
      const er = await page.evaluate(() => window.__hw.capture.eraser);
      L.check('finger mode: the pen takes the eraser over from a resting palm', palm.k === 1 && er.k === 4 && !er.active, JSON.stringify([palm, er]));
      await quiet(page);
      await tap(page, cdp, '#erase-ok');
      L.check('… and Entfernen works while the palm still rests', (await nStrokes(page)) === 4 && (await mode(page)) === null);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await ctx.close();
    }

    // ---------- confirm screen: back to the sheet keeps the line ----------
    {
      const { page, cdp, ctx, glyph, rect, base, P } = await app(browser, server);
      for (let i = 0; i < 10; i++) await glyph(i);
      await P.stroke([[rect.left + 110, base - 34], [rect.left + 112, base - 36], [rect.left + 114, base - 35]]);   // added later, far left
      await quiet(page);
      const json = () => page.evaluate(() => JSON.stringify(window.__hw.capture.recorder.strokes.map((s) => [s.x, s.y, s.t])));
      const before = await json();
      await tap(page, cdp, '#cap-done');
      await page.waitForSelector('#cap[data-state="confirm"]');
      const flags = await page.evaluate(() => [...document.querySelectorAll('#confirm-qa li')].map((li) => [li.dataset.flag, li.textContent]));
      L.check('a stroke added far left is flagged late_stroke, and the hint points to the way back', flags.some(([f, t]) => f === 'late_stroke' && t.includes('Zurück zum Blatt')), JSON.stringify(flags));
      const bb = await page.evaluate(() => { const r = document.getElementById('confirm-back').getBoundingClientRect(); return [r.width, r.height, document.getElementById('confirm-back').textContent]; });
      L.check('"Zurück zum Blatt" is on the confirm screen, at least 48x48', bb[0] >= 48 && bb[1] >= 48 && bb[2] === 'Zurück zum Blatt', JSON.stringify(bb));
      await quiet(page);
      await tap(page, cdp, '#confirm-back');
      await page.waitForSelector('#cap[data-state="write"]');
      await page.waitForTimeout(100);
      L.check('back on the sheet: the line and its history are kept', (await json()) === before && !(await page.isDisabled('#cap-undo')));
      await tap(page, cdp, '#cap-undo');
      await quiet(page);
      const rec = await accept(page, cdp);
      await valid(page, rec, 'back to sheet');
      L.check('after taking the late stroke back the line has no late_stroke flag', rec.strokes.length === 10 && !rec.flags.includes('late_stroke') && rec.attempt === 1 && rec.edits.undo === 1, JSON.stringify([rec.flags, rec.attempt, rec.edits.undo]));
      await ctx.close();
    }

    // ---------- the toolbar fits at every width ----------
    const order = ['cap-undo', 'cap-again', 'cap-erase', 'cap-skip', 'cap-clear', 'cap-look', 'cap-fs', 'cap-done'];
    for (const [vw, vh] of [[412, 915], [800, 1232], [753, 1205], [915, 412], [1138, 640], [1280, 800], [1691, 866]]) {
      const { page, cdp, ctx, rect, errors } = await app(browser, server, { width: vw, height: vh });
      const P = L.pen(cdp);
      for (let i = 0; i < 3; i++) await P.stroke(L.glyph(rect.left + 30 + i * 22, rect.top + rect.height * 0.64, 8));
      await quiet(page);
      const f = await toolbarFit(page);
      L.check(`${vw}x${vh}: every toolbar button is 48x48 or more, in one row, inside the screen; no label cut off; no sideways scrolling`,
        f.bad.length === 0 && !f.over && f.doc <= f.iw && f.doneLabel, JSON.stringify(f));
      if (vw >= 1280) L.check(`${vw}x${vh}: "Stift & Papier" and "Vollbild" keep their labels`, f.lookLabel && f.fsLabel, JSON.stringify(f));
      if (vw === 412) {
        L.check('412x915: Überspringen, Stift & Papier and Vollbild sit behind "Mehr"', f.ids.includes('cap-more') && !f.ids.includes('cap-look') && !f.ids.includes('cap-skip'), JSON.stringify(f.ids));
        await tap(page, cdp, '#cap-more');
        const m = await page.evaluate(() => { const menu = document.getElementById('cap-menu'); return { open: !menu.hidden, items: [...menu.querySelectorAll('.btn')].filter((b) => b.offsetParent).map((b) => { const r = b.getBoundingClientRect(); return [b.id, r.width >= 48 && r.height >= 48 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, b.textContent]; }) }; });
        L.check('412x915: "Mehr" opens a menu with the three, labelled, inside the screen', m.open && m.items.length === 3 && m.items.every((i) => i[1]) && m.items.map((i) => i[2]).join('|') === 'Überspringen|Stift & Papier|Vollbild', JSON.stringify(m));
        const cr0 = JSON.stringify(await L.canvasRect(page));
        await tap(page, cdp, '#cap-look');
        L.check('412x915: a menu item works and closes the menu; the sheet did not move', (await page.evaluate(() => document.getElementById('dlg-look').open && document.getElementById('cap-menu').hidden)) && JSON.stringify(await L.canvasRect(page)) === cr0);
        await page.click('#look-close');
        await quiet(page);
        await tap(page, cdp, '#cap-clear');          // an empty line: a new size does not pause it
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.waitForTimeout(300);
        const g = await toolbarFit(page);
        L.check('412 -> 1280 wide: the buttons are back in the row, in their order', JSON.stringify(g.ids) === JSON.stringify(order) && g.bad.length === 0, JSON.stringify(g.ids));
      }
      L.check(`${vw}x${vh}: no page errors`, errors.length === 0, errors.join(' | '));
      await ctx.close();
    }
  } catch (e) {
    console.error(e); L.check('test ran without exception', false, String(e));
  } finally {
    await browser.close(); await server.close();
  }
  process.exit(L.summary() ? 0 : 1);
})();
