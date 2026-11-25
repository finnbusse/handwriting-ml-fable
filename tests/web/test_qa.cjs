// QA flags through the real UI (stray stroke, far-too-short line) plus pure unit checks.
const path = require('path');
const { pathToFileURL } = require('url');
const L = require('./lib.cjs');

const mod = (p) => import(pathToFileURL(path.resolve(__dirname, '..', '..', 'web', 'js', p)).href);

async function unit() {
  const qa = await mod('capture/qa.js');
  const store = await mod('store.js');
  const prompts = await mod('prompts.js');
  const st = (x0, y0, n = 8, dx = 2, dt = 2.1, t0 = 0) => ({ x: Array.from({ length: n }, (_, i) => x0 + i * dx), y: Array.from({ length: n }, (_, i) => y0 - (i % 4) * 7), t: Array.from({ length: n }, (_, i) => t0 + i * dt), p: Array(n).fill(0.5), buttons: 1, end: 'up' });
  const line = (k) => Array.from({ length: k }, (_, i) => st(40 + i * 30, 200, 8, 2, 2.1, i * 100));
  L.check('unit: clean line has no flags', qa.check({ text: 'abcdefghij', strokes: line(10), canvas: [1000, 300] }).length === 0);
  L.check('unit: stroke_count_low', qa.check({ text: 'abcdefghij', strokes: line(3), canvas: [1000, 300] }).includes('stroke_count_low'));
  L.check('unit: stroke_count_high', qa.check({ text: 'abc', strokes: line(7), canvas: [1000, 300] }).includes('stroke_count_high'));
  const withStray = line(10).concat([st(950, 290, 2, 1, 2.1, 5000)]);
  L.check('unit: stray_stroke', qa.check({ text: 'abcdefghijk', strokes: withStray, canvas: [1000, 300] }).includes('stray_stroke'));
  const withDot = line(10).concat([st(70, 160, 2, 1, 2.1, 5000)]);   // an i-dot close to the text
  L.check('unit: a dot near the text is not stray', !qa.check({ text: 'abcdefghijk', strokes: withDot, canvas: [1000, 300] }).includes('stray_stroke'));
  L.check('unit: out_of_bounds', qa.check({ text: 'a', strokes: [st(-3, 100)], canvas: [1000, 300] }).includes('out_of_bounds'));
  L.check('unit: pointercancel', qa.check({ text: 'a', strokes: [Object.assign(st(10, 100), { end: 'cancel' })], canvas: [1000, 300] }).includes('pointercancel'));
  L.check('unit: button_pressed', qa.check({ text: 'a', strokes: [Object.assign(st(10, 100), { buttons: 3 })], canvas: [1000, 300] }).includes('button_pressed'));
  L.check('unit: low_rate at 60 Hz', qa.check({ text: 'a', strokes: [st(10, 100, 8, 2, 16.7)], canvas: [1000, 300] }).includes('low_rate'));
  L.check('unit: low_rate at 120 Hz (frame-rate pointermove, the old defect)', qa.check({ text: 'a', strokes: [st(10, 100, 8, 2, 8.3)], canvas: [1000, 300] }).includes('low_rate'));
  L.check('unit: no low_rate at 480 Hz', !qa.check({ text: 'a', strokes: [st(10, 100, 8, 2, 2.1)], canvas: [1000, 300] }).includes('low_rate'));
  L.check('unit: layout_changed', qa.check({ text: 'a', strokes: [st(10, 100)], canvas: [1000, 300], layoutChanged: true }).includes('layout_changed'));
  L.check('unit: every flag has a German hint', ['stroke_count_low', 'stroke_count_high', 'stray_stroke', 'out_of_bounds', 'pointercancel', 'button_pressed', 'low_rate', 'layout_changed'].every((f) => qa.HINTS[f]));
  const id = '3f0c9d1e-6c1b-4b0e-9a57-2d0a3c1f7e11';
  L.check('unit: prompt id recovered from path', store.promptIdFromPath(`raw/v1/finn/abc/de-core-0042__${id}.json`) === 'de-core-0042');
  L.check('unit: foreign paths ignored', store.promptIdFromPath(`raw/v1/finn/abc/${id}.json`) === null && store.promptIdFromPath('README.md') === null && store.promptIdFromPath(`raw/v1/abc/de-core-0042__${id}.json`) === null);
  L.check('unit: path only counts for its own writer', store.promptIdFromPath(`raw/v1/finn/abc/de-core-0042__${id}.json`, 'finn') === 'de-core-0042' && store.promptIdFromPath(`raw/v1/finn/abc/de-core-0042__${id}.json`, 'lena') === null && store.promptIdFromPath(`raw/v1/finn-x/abc/de-core-0042__${id}.json`, 'finn') === null);
  L.check('unit: linePath has the writer folder', store.linePath({ writer_id: 'finn', session_id: 's1', id, prompt: { id: 'p1' } }) === `raw/v1/finn/s1/p1__${id}.json`);
  const P = [{ id: 'a', block: 1 }, { id: 'b', block: 1 }, { id: 'c', block: 2 }];
  L.check('unit: next prompt skips skipped ones', prompts.nextPrompt(P, new Set(), new Set(['a'])).id === 'b');
  L.check('unit: skipped prompt comes back when the block is otherwise done', prompts.nextPrompt(P, new Set(['b']), new Set(['a'])).id === 'a');
  L.check('unit: next block after a finished block', prompts.nextPrompt(P, new Set(['a', 'b']), new Set()).id === 'c');
  const pr = prompts.progressOf(P, new Set(['a']), P[1]);
  L.check('unit: progress block/index/size/total', pr.block === 1 && pr.index === 2 && pr.size === 2 && pr.done === 1 && pr.total === 3);
}

async function writeLine(page, cdp, nStrokes, stray) {
  const rect = await L.canvasRect(page);
  const base = rect.top + rect.height * 0.64;
  const p = L.pen(cdp);
  const step = Math.min(30, (rect.width - 120) / Math.max(1, nStrokes));
  for (let i = 0; i < nStrokes; i++) await p.stroke(L.glyph(rect.left + 50 + i * step, base, 7, 26, 14));
  if (stray) await p.stroke([[rect.left + rect.width - 24, rect.top + rect.height - 14, 0.3], [rect.left + rect.width - 23.5, rect.top + rect.height - 13.6, 0.3], [rect.left + rect.width - 23.4, rect.top + rect.height - 13.5]]);
  await L.settle(page);
  await page.click('#cap-done');
  await page.waitForSelector('#cap[data-state="confirm"]');
  const flags = await page.$$eval('#confirm-qa li', (els) => els.map((e) => e.dataset.flag));
  const label = await page.textContent('#confirm-ok-label');
  await L.settle(page);
  await page.click('#confirm-ok');
  await page.waitForSelector('#cap[data-state="write"]');
  return { flags, label };
}

(async () => {
  await unit();
  const server = await L.start();
  const browser = await L.launch();
  try {
    const { page, cdp, errors } = await L.newApp(browser, server, { hash: '#/erfassen', writer: 'Finn' });
    await page.waitForSelector('#cap[data-state="write"]');
    await page.waitForTimeout(150);
    const chars = (t) => [...t].filter((c) => !/\s/.test(c)).length;

    const t1 = await page.textContent('#cap-prompt');
    const a = await writeLine(page, cdp, chars(t1), true);
    L.check('stray stroke flagged on the confirm screen', a.flags.includes('stray_stroke'), JSON.stringify(a.flags));
    L.check('a normal stroke count is not flagged', !a.flags.some((f) => f.startsWith('stroke_count')), JSON.stringify(a.flags));
    L.check('with flags the accept button says "Trotzdem weiter"', a.label === 'Trotzdem weiter', a.label);

    const t2 = await page.textContent('#cap-prompt');
    const b = await writeLine(page, cdp, 2, false);
    L.check('far-too-short line flagged stroke_count_low', b.flags.includes('stroke_count_low'), JSON.stringify(b.flags));

    const t3 = await page.textContent('#cap-prompt');
    const c = await writeLine(page, cdp, chars(t3), false);
    L.check('a clean line has no flags and says "Ja, weiter"', c.flags.length === 0 && c.label === 'Ja, weiter', JSON.stringify(c));

    const recs = (await L.lines(page)).map((e) => e.record).sort((x, y) => x.seq - y.seq);
    L.check('flagged lines stored with status flagged and their flags', recs[0].status === 'flagged' && recs[0].flags.includes('stray_stroke') && recs[1].flags.includes('stroke_count_low'));
    L.check('clean line stored as accepted', recs[2].status === 'accepted' && recs[2].flags.length === 0);
    L.check('seq counts up within the session', recs.map((r) => r.seq).join() === '0,1,2' && new Set(recs.map((r) => r.session_id)).size === 1);
    L.check('prompts recorded in order', recs[0].prompt.text === t1 && recs[1].prompt.text === t2 && recs[2].prompt.text === t3);
    L.check('no page errors', errors.length === 0, errors.join(' | '));

    // Without coalesced events the pen arrives at frame rate: the capture screen refuses to record.
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx2.addInitScript(() => { delete PointerEvent.prototype.getCoalescedEvents; });
    const page2 = await ctx2.newPage();
    await page2.goto(server.url + '#/erfassen');
    await page2.waitForFunction(() => window.__hwReady);
    await page2.waitForSelector('#cap[data-state="nocaps"]', { timeout: 5000 }).catch(() => {});
    L.check('missing getCoalescedEvents: capture screen blocks with a hint', (await page2.getAttribute('#cap', 'data-state')) === 'nocaps'
      && (await page2.isVisible('#nocaps-text')) && (await page2.textContent('#nocaps-text')).includes('Chrome'));
    await ctx2.close();
  } catch (e) {
    console.error(e); L.check('test ran without exception', false, String(e));
  } finally {
    await browser.close(); await server.close();
  }
  process.exit(L.summary() ? 0 : 1);
})();
