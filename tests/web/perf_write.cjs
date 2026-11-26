// Schreiben stays fluid with longer texts: counts that do not depend on the machine's load
// (canvas calls, whole-page redraws, whole-sheet copies), plus generous time budgets.
//   - Seite, Bleistift, two pages: a page is not drawn anew for every piece that arrives;
//     scrolling the finished pages draws nothing and blocks nothing; one redrawn page takes a
//     bounded number of canvas calls per word.
//   - Seite, Bleistift, a document with marks over two pages: scrolling its finished pages
//     draws nothing and blocks nothing for 50 ms; while it is written, the budget of the
//     plain pages above (the layout of a piece runs on the page; on a loaded 4-core machine
//     the plain pages too have tasks of 50-120 ms then).
//   - Zettel, a sheet of many lines: a frame of the writing animation draws on a small part
//     of the ink (paint-worker.js: STRIP), and never copies the whole sheet.
// Canvas calls are counted on the page and in the paint worker (paint-worker.js), so the
// same checks hold wherever the drawing runs.
// Needs the small test model in tests/engine/fixtures (not in git); without it the file is skipped.
const fs = require('fs');
const path = require('path');
const http = require('http');
const L = require('./lib.cjs');

const FIX = path.resolve(__dirname, '..', 'engine', 'fixtures');
if (!fs.existsSync(path.join(FIX, 'model.json')) || !fs.existsSync(path.join(FIX, 'model.bin'))) {
  console.log('SKIP: tests/engine/fixtures has no model.json / model.bin; perf tests not run');
  process.exit(0);
}
const BIN = fs.readFileSync(path.join(FIX, 'model.bin'));
const MAN = JSON.parse(fs.readFileSync(path.join(FIX, 'model.json'), 'utf8'));
const REPO = `/${L.FAKE_USER}/handwriting-fable-model/resolve/main/`;

const closers = [];
async function modelRepo() {
  const srv = http.createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': '*', 'access-control-allow-headers': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    res.writeHead(200, Object.assign({ 'content-type': 'application/octet-stream', 'content-length': BIN.length }, cors));
    res.end(BIN);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }));
  const cdn = `http://127.0.0.1:${srv.address().port}`;
  return async (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/api/whoami-v2') return { status: 200, body: { name: L.FAKE_USER } };
    if (!u.pathname.startsWith(REPO)) return null;
    const file = u.pathname.slice(REPO.length);
    if (file === 'model.json') return { status: 200, body: JSON.stringify(MAN) };
    if (file === 'trained_on.json') return { status: 200, body: { date: '2026-11-20', lines: 100 } };
    if (file === 'model.bin') return { status: 302, headers: { location: `${cdn}/m/model.bin` }, body: '' };
    return { status: 404 };
  };
}

// Counters, the same on the page (2D canvases) and in a paint worker (OffscreenCanvas):
// stroke / fill calls, whole-canvas paper fills (= a page drawn from scratch), copies
// covering at least half of a large canvas (= the sheet copied), and per task the pixels of
// the canvases drawn on (a canvas drawn on is handed to the compositor whole).
const COUNTERS = `(() => {
  const C = { stroke: 0, fill: 0, pages: 0, copies: 0, tasks: [] };
  let touched = null;
  const touch = (cv) => {
    if (!touched) { touched = new Set(); setTimeout(() => { let px = 0; for (const c of touched) px += c.width * c.height; C.tasks.push(px); touched = null; }, 0); }
    touched.add(cv);
  };
  const wrap = (P) => {
    if (!P) return;
    for (const m of ['stroke', 'fill', 'fillRect', 'clearRect', 'drawImage']) {
      const f = P[m];
      P[m] = function (...a) {
        const w = this.canvas.width, h = this.canvas.height;
        touch(this.canvas);
        if (m === 'stroke' || m === 'fill') C[m]++;
        else if (m === 'clearRect') { /* only touched */ } else if (m === 'fillRect') { if (w > 100 && a[2] >= 0.99 * w && a[3] >= 0.99 * h) C.pages++; }
        else if (w * h >= 4e5) { const dw = a.length > 5 ? a[7] : a.length > 3 ? a[3] : a[0].width, dh = a.length > 5 ? a[8] : a.length > 3 ? a[4] : a[0].height; if (dw * dh >= 0.5 * w * h) C.copies++; }
        return f.apply(this, a);
      };
    }
  };
  wrap(self.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype);
  wrap(self.OffscreenCanvasRenderingContext2D && OffscreenCanvasRenderingContext2D.prototype);
  return C;
})()`;
const PAGE_INIT = `window.__count = ${COUNTERS};
window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push([e.startTime, e.duration]); }).observe({ type: 'longtask' });
window.__painters = []; const W0 = window.Worker;
window.Worker = class extends W0 { constructor(u, o) { super(u, o); if (String(u).includes('paint-worker')) window.__painters.push(this); } };`;
const WORKER_PRELUDE = `const __count = ${COUNTERS};
self.addEventListener('message', (e) => { if (e.data && e.data.count) self.postMessage({ count: { ...__count, tasks: [...__count.tasks] } }); });\n`;

/** Page and worker counters added up. */
const counts = (page) => page.evaluate(async () => {
  const all = [{ ...window.__count }];
  for (const w of window.__painters) {
    all.push(await new Promise((r) => { const h = (e) => { if (e.data && e.data.count) { w.removeEventListener('message', h); r(e.data.count); } }; w.addEventListener('message', h); w.postMessage({ count: true }); }));
  }
  const sum = { stroke: 0, fill: 0, pages: 0, copies: 0, tasks: [] };
  for (const c of all) for (const k of Object.keys(sum)) if (k === 'tasks') sum.tasks.push(c.tasks.length); else sum[k] += c[k];
  sum.list = all.map((c) => c.tasks);
  return sum;
});
/** Counts since b; tasks: the pixels drawn on per task since b. */
const minus = (a, b) => Object.fromEntries(Object.keys(a).filter((k) => k !== 'list').map((k) => [k, k === 'tasks' ? a.list.flatMap((t, i) => t.slice(b.tasks[i] || 0)) : a[k] - b[k]]));
const settled = async (page) => { await page.waitForTimeout(400); if (await page.evaluate(() => !!window.__hw.generate.painted)) await page.evaluate(() => window.__hw.generate.painted()); };
/** The longest task on the page that started after `t` (an entry arrives after its task ends). */
const longSince = (page, t) => page.evaluate((s) => Math.round(Math.max(0, ...window.__long.filter(([at]) => at >= s).map(([, d]) => d))), t);
const now = (page) => page.evaluate(() => performance.now());

// One short word per line: two squared pages at the large size with few pieces (as test_page_mode).
const WORDS = 'Ahorn Birke Eiche Esche Linde Ulme Weide Pappel Kiefer Fichte Tanne Buche Erle Hasel Eibe Kirsche Apfel Birne Pflaume Quitte Feige Olive Zeder Akazie Platane Kastanie Holunder Ginster Efeu Lorbeer Ulme Linde Eiche Buche'.split(' ');

async function open(browser, server, cores = 4) {
  const hf = await modelRepo();
  const routes = (ctx) => ctx.route(/paint-worker\.js$/, async (route) => {
    const resp = await route.fetch();
    route.fulfill({ response: resp, body: WORKER_PRELUDE + (await resp.text()), headers: { ...resp.headers(), 'content-type': 'application/javascript' } });
  });
  const init = `Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${cores} }); ${PAGE_INIT}`;
  const app = await L.newApp(browser, server, { hash: '#/schreiben', signedIn: true, hf, init, routes, dsf: 2.5 });
  await app.page.waitForSelector('#gen-work:not([hidden])', { timeout: 30000 });
  return app;
}
const openStyle = async (page) => { if (!(await page.isVisible('#gen-style'))) await page.click('#gen-style-btn'); };
const pick = async (page, key, value) => { await openStyle(page); await page.click(`.gen-choice[data-k="${key}"][data-v="${value}"]`); await page.waitForTimeout(150); };
const closeStyle = async (page) => { if (await page.isVisible('#gen-style')) await page.click('#gen-style-btn'); };
/** Writing state from the page itself (cheap: no debug objects while measuring). */
const progress = (page) => page.evaluate(() => {
  const m = /(\d+) von (\d+)/.exec(document.getElementById('pg-busy-text').textContent || '');
  return { writing: !document.getElementById('pg-busy').hidden, done: m ? +m[1] : 0, total: m ? +m[2] : 0 };
});

async function pages(browser, server) {
  const { page, ctx, errors } = await open(browser, server);
  await pick(page, 'pen', 'bleistift');
  await page.click('.gen-modes [data-mode="seite"]');
  await pick(page, 'paper', 'kariert');
  await pick(page, 'docsize', 'gross');
  await closeStyle(page);
  await page.fill('#pg-text', WORDS.join('\n'));
  await page.evaluate(() => document.getElementById('pg-text').blur());

  // ---- writing: pages grow by their new words ----
  const c0 = await counts(page);
  const l0 = await now(page);
  await page.click('#pg-write');
  let p = await progress(page);
  for (let k = 0; !p.writing && k < 50; k++) { await page.waitForTimeout(100); p = await progress(page); }
  // the typical letter size is fixed once the first 12 pieces are there (document.js:
  // TYPICAL_PIECES); before that the first page may be drawn anew, after it never
  while (p.writing && p.done < 20) { await page.waitForTimeout(100); p = await progress(page); }
  const c1 = await counts(page);
  const later = p.total - p.done;
  await L.until(async () => !(await progress(page)).writing, 300000, 150);
  await penDone(page);      // and the pen ("Schreiben zeigen") through
  await settled(page);
  const c2 = await counts(page);
  const d = await page.evaluate(() => window.__hw.generate.pageDebug());
  const fresh = minus(c2, c1).pages;
  L.check('Seite: two pages written', d.pages === 2 && d.placed === d.total && d.total === WORDS.length, JSON.stringify([d.pages, d.placed, d.total]));
  L.check(`Seite: no page drawn anew for each of the last ${later} pieces (at most once per page)`, later >= 8 && fresh <= 2, JSON.stringify({ later, fresh, before: minus(c1, c0).pages }));
  const writingLong = await longSince(page, l0);
  L.check('Seite: no task over 250 ms on the page while writing', writingLong <= 250, `${writingLong} ms`);

  // ---- a finished page redrawn (another pen): bounded canvas calls per word ----
  await page.evaluate(() => { document.getElementById('pg-stage').scrollTop = 0; });
  await page.waitForTimeout(300);
  await pick(page, 'pen', 'fineliner');
  await settled(page);
  const r0 = await counts(page);
  const t0 = Date.now();
  await pick(page, 'pen', 'bleistift');
  await settled(page);
  const redrawMs = Date.now() - t0;
  const r1 = minus(await counts(page), r0);
  const words = d.words.filter((w) => w.page < r1.pages).length;
  const perWord = (r1.stroke + r1.fill) / Math.max(1, words);
  L.check('Bleistift: a redrawn page takes at most 40 canvas calls per word', r1.pages >= 1 && words > 10 && perWord <= 40, JSON.stringify({ pages: r1.pages, words, calls: r1.stroke + r1.fill, perWord: Math.round(perWord) }));
  L.check('Bleistift: a pen change is on the pages within 3 s', redrawMs < 3000, `${redrawMs} ms`);
  await closeStyle(page);

  // ---- scrolling the finished pages: nothing drawn, nothing blocked ----
  const s0 = await counts(page);
  const l1 = await now(page);
  const box = await page.evaluate(() => { const r = document.getElementById('pg-stage').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await page.mouse.move(box[0], box[1]);
  for (const sign of [1, -1, 1, -1]) {
    for (let k = 0; k < 40; k++) { await page.mouse.wheel(0, 60 * sign); await page.waitForTimeout(16); }
  }
  await settled(page);
  const s1 = minus(await counts(page), s0);
  const moved = await page.evaluate(() => document.getElementById('pg-stage').scrollHeight > 2 * document.getElementById('pg-stage').clientHeight);
  L.check('scrolling finished pages draws nothing (no page drawn anew, no canvas call)', moved && s1.pages === 0 && s1.stroke + s1.fill === 0 && s1.tasks.length === 0, JSON.stringify({ ...s1, tasks: s1.tasks.length }));
  const scrollLong = await longSince(page, l1);
  L.check('scrolling finished pages: no task over 100 ms', scrollLong <= 100, `${scrollLong} ms`);
  L.check('Seite: no errors', errors.filter((e) => !/Failed to load resource|ERR_/.test(e)).length === 0, errors.join(' | '));
  await ctx.close();
}

// A document with marks over two squared pages: a header line, headings, lists, check boxes,
// arrows, boxes, highlighter, colour, strike-throughs and rules.
const RICH = `# {datum} {mitte} Wiederholung\n${[1, 2, 3].map((n) => `## Teil ${n}
Die ==Zelle== ist die *kleinste* Einheit.
- Kern und Plasma
  - Erbgut im Kern
- [x] Text gelesen
- [ ] Skizze zeichnen
Licht -> Zucker
> Merke: alles Leben aus Zellen
Das ist [wichtig]{rot} und ~~falsch~~.
---`).join('\n')}`;

async function rich(browser, server) {
  const { page, ctx, errors } = await open(browser, server);
  await pick(page, 'pen', 'bleistift');
  await page.click('.gen-modes [data-mode="seite"]');
  await pick(page, 'paper', 'kariert');
  await pick(page, 'docsize', 'gross');
  await closeStyle(page);
  await page.fill('#pg-text', RICH);
  await page.evaluate(() => document.getElementById('pg-text').blur());
  const l0 = await now(page);
  await page.click('#pg-write');
  await page.waitForTimeout(500);
  await L.until(async () => !(await progress(page)).writing, 300000, 150);
  await penDone(page);      // and the pen ("Schreiben zeigen") through
  await settled(page);
  const writingLong = await longSince(page, l0);
  const d = await page.evaluate(() => window.__hw.generate.pageDebug());
  L.check('rich: a document of two pages written', d.format === 'markdown' && d.pages === 2 && d.placed === d.total, JSON.stringify([d.format, d.pages, d.placed, d.total]));
  console.log(`      rich, Bleistift: longest task on the page while writing ${writingLong} ms`);
  L.check('rich, Bleistift: no task over 250 ms on the page while writing', writingLong <= 250, `${writingLong} ms`);
  await page.evaluate(() => { document.getElementById('pg-stage').scrollTop = 0; });
  await settled(page);
  const s0 = await counts(page);
  const l1 = await now(page);
  const box = await page.evaluate(() => { const r = document.getElementById('pg-stage').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await page.mouse.move(box[0], box[1]);
  for (const sign of [1, -1, 1, -1]) {
    for (let k = 0; k < 40; k++) { await page.mouse.wheel(0, 60 * sign); await page.waitForTimeout(16); }
  }
  await settled(page);
  const s1 = minus(await counts(page), s0);
  const scrollLong = await longSince(page, l1);
  console.log(`      rich, Bleistift: longest task on the page while scrolling ${scrollLong} ms`);
  L.check('rich, Bleistift: scrolling the finished pages draws nothing, no task over 50 ms', s1.pages === 0 && s1.stroke + s1.fill === 0 && scrollLong <= 50, JSON.stringify({ scrollLong, pages: s1.pages, calls: s1.stroke + s1.fill }));
  L.check('rich: no errors', errors.filter((e) => !/Failed to load resource|ERR_/.test(e)).length === 0, errors.join(' | '));
  await ctx.close();
}

// Frame times on the page: every requestAnimationFrame interval from start to stop.
const framesOn = (page) => page.evaluate(() => { window.__ft = []; window.__ftOn = true; let last = performance.now(); const f = (t) => { window.__ft.push(t - last); last = t; if (window.__ftOn) requestAnimationFrame(f); }; requestAnimationFrame(f); });
const framesOff = (page) => page.evaluate(() => { window.__ftOn = false; const a = window.__ft.slice(1).sort((x, y) => x - y); return { frames: a.length, p95: Math.round(a[Math.floor(0.95 * (a.length - 1))] || 0), within34: a.length ? +(a.filter((x) => x <= 34).length / a.length).toFixed(3) : 0 }; });
// done writing and the pen done, read from the page itself (the debug object is too heavy to
// ask for while frames are measured on a slowed CPU)
const penDone = (page) => L.until(async () => page.evaluate(() => document.getElementById('pg-busy').hidden && document.getElementById('pg-now').hidden && !document.getElementById('pg-write').hidden), 600000, 250);
const THROTTLE = 4;

// A five-page document with lists, boxes, marks and a table (218 pieces): its layout takes
// 14-23 ms in Node, so 60-90 ms on a CPU slowed 4x, once per frame while pieces arrive.
const LONG = `# {datum} {mitte} Wiederholung\n${[1, 2, 3, 4, 5, 6].map((n) => `## Abschnitt ${n}
Die ==Zelle== ist die *kleinste* Einheit des Lebens und hat viele Teile.
- Kern und Plasma mit vielen kleinen Teilen
  - Erbgut im Kern liegt dort sicher
- [x] Text gelesen und verstanden
- [ ] Skizze zeichnen bis Montag
1. erster Punkt der Liste
2. zweiter Punkt der Liste
Licht -> Zucker und Sauerstoff
> Merke: alles Leben kommt aus Zellen, das ist wichtig.
> Auch Pflanzen bestehen aus Zellen.
Das ist [wichtig]{rot} und ~~falsch~~ und **fett** gesetzt.

| Teil | Aufgabe |
|---|---|
| Kern | steuert die Zelle |
| Wand | gibt Halt |

---`).join('\n')}`;

/** Part 3: a long structured document with the Bleistift and the pen, on a CPU slowed 4x:
 *  writing, an update and scrolling keep every task on the page under 50 ms and 95 % of the
 *  frames within 34 ms; the layout runs in its worker (pen.js). */
async function longDoc(browser, server) {
  // one engine: on this 4-core machine shared with other jobs, three engines, the paint and
  // the layout worker leave the page's thread too little to measure what it does itself
  const { page, ctx, cdp, errors } = await open(browser, server, 2);
  await pick(page, 'pen', 'bleistift');
  await page.click('.gen-modes [data-mode="seite"]');
  await closeStyle(page);
  await page.fill('#pg-text', LONG);
  await page.evaluate(() => document.getElementById('pg-text').blur());
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  const phase = async (name, act) => {
    const t = await now(page);
    await framesOn(page);
    await act();
    const f = await framesOff(page), long = await longSince(page, t);
    console.log(`      ${name} (CPU / ${THROTTLE}): longest task ${long} ms, frames ${f.frames}, p95 ${f.p95} ms, ${Math.round(100 * f.within34)} % within 34 ms`);
    return { ...f, long };
  };
  const w = await phase('writing five pages', async () => { await page.click('#pg-write'); await page.waitForTimeout(500); await penDone(page); });
  const d = await page.evaluate(() => window.__hw.generate.pageDebug());
  L.check('long document: five pages, all placed, written with the pen', d.pages >= 5 && d.placed === d.total && d.pen.used && d.pen.log.length > 0, JSON.stringify([d.pages, d.placed, d.total]));
  // what the layout costs here, on the page (it runs in the worker while writing)
  const lay = await page.evaluate(() => { const ts = []; for (let k = 0; k < 3; k++) { const a = performance.now(); window.__hw.generate.pageDebug().scratch(); ts.push(performance.now() - a); } return ts.map(Math.round); });
  console.log(`      one layout of the whole document on the page (CPU / ${THROTTLE}, with the debug read around it): ${lay.join(', ')} ms`);
  L.check('long document, writing: no task over 50 ms, 95 % of the frames within 34 ms', w.long <= 50 && w.within34 >= 0.95, JSON.stringify(w));
  const u = await phase('update (one line changed)', async () => {
    await page.evaluate(() => { const t = document.getElementById('pg-text'); t.value = t.value.replace('## Abschnitt 3', '## Abschnitt drei'); t.dispatchEvent(new Event('input')); });
    await page.click('#pg-write');
    await page.waitForTimeout(300);
    await penDone(page);
  });
  const d2 = await page.evaluate(() => window.__hw.generate.pageDebug());
  L.check('long document, update: only the changed piece written', d2.pen.asked >= 1 && d2.pen.asked <= 2 && d2.placed === d2.total, JSON.stringify([d2.pen.asked, d2.pen.kept]));
  L.check('long document, update: no task over 50 ms, 95 % of the frames within 34 ms', u.long <= 50 && u.within34 >= 0.95, JSON.stringify(u));
  await page.evaluate(() => { document.getElementById('pg-stage').scrollTop = 0; });
  await settled(page);
  const box = await page.evaluate(() => { const r = document.getElementById('pg-stage').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await page.mouse.move(box[0], box[1]);
  const s = await phase('scrolling', async () => { for (const sign of [1, -1]) for (let k = 0; k < 60; k++) { await page.mouse.wheel(0, 90 * sign); await page.waitForTimeout(16); } await page.waitForTimeout(300); });
  L.check('long document, scrolling: no task over 50 ms, 95 % of the frames within 34 ms', s.long <= 50 && s.within34 >= 0.95, JSON.stringify(s));
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  L.check('long document: no errors', errors.filter((e) => !/Failed to load resource|ERR_/.test(e)).length === 0, errors.join(' | '));
  await ctx.close();
}

/** One Bleistift page written with the pen on a CPU slowed 4x. */
async function penPage(browser, server) {
  const { page, ctx, cdp, errors } = await open(browser, server, 2);
  await pick(page, 'pen', 'bleistift');
  await page.click('.gen-modes [data-mode="seite"]');
  await closeStyle(page);
  await page.fill('#pg-text', WORDS.join(' '));
  await page.evaluate(() => document.getElementById('pg-text').blur());
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  const t = await now(page);
  await framesOn(page);
  await page.click('#pg-write');
  await page.waitForTimeout(500);
  await penDone(page);
  const f = await framesOff(page), long = await longSince(page, t);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const d = await page.evaluate(() => window.__hw.generate.pageDebug());
  console.log(`      Bleistift page with the pen (CPU / ${THROTTLE}): longest task ${long} ms, frames ${f.frames}, p95 ${f.p95} ms, ${Math.round(100 * f.within34)} % within 34 ms, ${d.pen.log.length} strokes by the pen`);
  L.check('Bleistift page with the pen: no task over 50 ms, 95 % of the frames within 34 ms', d.pen.log.length > 20 && long <= 50 && f.within34 >= 0.95, JSON.stringify({ long, ...f }));
  L.check('Bleistift page with the pen: no errors', errors.filter((e) => !/Failed to load resource|ERR_/.test(e)).length === 0, errors.join(' | '));
  await ctx.close();
}

async function sheet(browser, server) {
  const { page, ctx, errors } = await open(browser, server);
  await pick(page, 'pen', 'bleistift');
  await closeStyle(page);
  // one short word per line: a sheet many lines tall from few pieces
  await page.fill('#gen-text', WORDS.slice(0, 24).join('\n'));
  await page.evaluate(() => document.getElementById('gen-text').blur());
  const c0 = await counts(page);
  const l0 = await now(page);
  await page.click('#gen-write');
  await page.evaluate(() => { window.__frames = 0; const f = () => { window.__frames++; requestAnimationFrame(f); }; requestAnimationFrame(f); });
  await L.until(async () => { const g = await page.evaluate(() => { const x = window.__hw.generate.debug(); return { phase: x.phase, settled: x.settled, n: x.page ? x.page.strokes.length : 0 }; }); return g.phase === 'idle' && g.n > 0 && g.settled === g.n; }, 300000, 150);
  await settled(page);
  const frames = await page.evaluate(() => window.__frames);
  const c1 = minus(await counts(page), c0);
  L.check(`Zettel: the animation does not copy the whole sheet per frame (${frames} frames)`, frames > 60 && c1.copies <= 10, JSON.stringify({ frames, copies: c1.copies }));
  // A canvas drawn on is handed to the compositor whole: with the sheet as one canvas every
  // frame handed over all of it.  Tasks that draw on half the sheet or more (the paper as it
  // grows, a new resolution) stay rare.
  const sheetPx = await page.evaluate(() => { const g = window.__hw.generate.debug(); return Math.round(g.page.width * g.scale) * Math.round(g.page.height * g.scale); });
  const big = c1.tasks.filter((px) => px >= sheetPx / 2).length;
  L.check('Zettel: a frame of the writing animation draws on a small part of the sheet', sheetPx > 6e6 && c1.tasks.length > 60 && big <= 0.05 * c1.tasks.length, JSON.stringify({ sheetMpx: +(sheetPx / 1e6).toFixed(1), tasks: c1.tasks.length, halfOrMore: big }));
  const writingLong = await longSince(page, l0);
  L.check('Zettel: no task over 250 ms on the page while writing', writingLong <= 250, `${writingLong} ms`);
  L.check('Zettel: no errors', errors.filter((e) => !/Failed to load resource|ERR_/.test(e)).length === 0, errors.join(' | '));
  await ctx.close();
}

(async () => {
  const server = await L.start();
  const browser = await L.launch();
  const only = process.argv.slice(2);
  try {
    // the long document takes six minutes with one engine of the small test model, more than
    // run.cjs gives a file: asked for by name (node tests/web/perf_write.cjs longDoc) or PERF_LONG=1
    if (!only.length && !process.env.PERF_LONG) console.log('SKIP longDoc: node tests/web/perf_write.cjs longDoc (or PERF_LONG=1) runs it');
    for (const part of [pages, rich, sheet, penPage, longDoc]) if (only.length ? only.includes(part.name) : part !== longDoc || process.env.PERF_LONG) await part(browser, server);
  } catch (e) {
    console.error(e);
    L.check('no exception', false, String(e && e.message));
  }
  await browser.close();
  await server.close();
  for (const c of closers) await c();
  process.exit(L.summary() ? 0 : 1);
})();
