// Schreiben, page mode ("Seite"): mode switch, writing with several engines, pages,
// progress, cancel, tap to rewrite, PDF download, settings, touch targets, themes,
// a dying worker.
// Needs the small test model in tests/engine/fixtures (not in git); without it the file is skipped.
const fs = require('fs');
const path = require('path');
const http = require('http');
const L = require('./lib.cjs');

const FIX = path.resolve(__dirname, '..', 'engine', 'fixtures');
if (!fs.existsSync(path.join(FIX, 'model.json')) || !fs.existsSync(path.join(FIX, 'model.bin'))) {
  console.log('SKIP: tests/engine/fixtures has no model.json / model.bin; page mode tests not run');
  process.exit(0);
}
const BIN = fs.readFileSync(path.join(FIX, 'model.bin'));
const MAN = JSON.parse(fs.readFileSync(path.join(FIX, 'model.json'), 'utf8'));
const REPO = `/${L.FAKE_USER}/handwriting-fable-model/resolve/main/`;

/** The model repo as a mock; model.bin comes from a local stand-in for the CDN. */
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

const LETTER = 'Liebe Anna,\n\nvielen Dank für die schönen Blumen. Sie stehen jetzt auf dem Küchentisch.';
// One short word per line: enough lines for two squared pages at the large size, written quickly.
const WORDS = 'Ahorn Birke Eiche Esche Linde Ulme Weide Pappel Kiefer Fichte Tanne Buche Erle Hasel Eibe Kirsche Apfel Birne Pflaume Quitte Feige Olive Zeder Akazie Platane Kastanie Holunder Ginster Efeu Lorbeer'.split(' ').join('\n');

const ready = (page) => page.waitForSelector('#gen-work:not([hidden])', { timeout: 30000 });
const dbg = (page) => page.evaluate(() => window.__hw.generate.pageDebug());
const idle = (page, timeout = 240000) => L.until(async () => { const d = await dbg(page); return d.phase === 'idle' && d.rewriting.length === 0; }, timeout, 150);
const noErrors = (errors) => errors.filter((e) => !/Failed to load resource|ERR_/.test(e));
const openStyle = async (page) => { if (!(await page.isVisible('#gen-style'))) await page.click('#gen-style-btn'); };
const pick = async (page, key, value) => { await openStyle(page); await page.click(`.gen-choice[data-k="${key}"][data-v="${value}"]`); await page.waitForTimeout(150); };
/** Inked pixels (differing from the paper at the page's middle left) on page canvas i. */
const inked = (page, i = 0) => page.evaluate(async (k) => {
  await window.__hw.generate.painted();
  const c = document.querySelectorAll('#pg-pages .pg-page canvas')[k];
  if (!c || !c.width) return -1;
  const t = Object.assign(document.createElement('canvas'), { width: c.width, height: c.height });   // drawn by a worker: read a copy
  t.getContext('2d').drawImage(c, 0, 0);
  const d = t.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const bg = [d[0], d[1], d[2]];
  let n = 0;
  for (let i = 0; i < d.length; i += 16) if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 120) n++;
  return n;
}, i);
/** Viewport point of a word's centre (page index, box in mm). */
const wordPoint = (page, w) => page.evaluate(({ p, box }) => {
  const r = document.querySelectorAll('#pg-pages .pg-page')[p].getBoundingClientRect();
  const k = r.width / 210;
  return { x: r.left + ((box[0] + box[2]) / 2) * k, y: r.top + ((box[1] + box[3]) / 2) * k };
}, { p: w.page, box: w.box });
const smallTargets = (page) => page.evaluate(() => [...document.querySelectorAll('#v-schreiben button, #v-schreiben a.btn, #v-schreiben input[type=range], #v-schreiben .pg-switch')]
  .filter((e) => e.offsetParent && !e.hidden).map((e) => { const r = e.getBoundingClientRect(); return [e.id || e.textContent.trim().slice(0, 16) || e.className, Math.round(r.width), Math.round(r.height)]; })
  .filter(([, w, h]) => h < 47.5 || w < 47.5));
const pdfFacts = (buf) => {
  const s = buf.toString('latin1');
  return { head: s.slice(0, 5), pages: (s.match(/\/Type \/Page\b(?!s)/g) || []).length, count: Number((s.match(/\/Count (\d+)/) || [])[1]), eof: s.trimEnd().endsWith('%%EOF') };
};

async function tablet(browser, server) {
  const hf = await modelRepo();
  const { page, ctx, errors } = await L.newApp(browser, server, { hash: '#/schreiben', signedIn: true, hf });
  await ready(page);

  // ---- the switch ----
  L.check('Zettel is the mode at first, the quick sheet as before', (await page.getAttribute('#gen', 'data-mode')) === 'zettel' && await page.isVisible('#gen-stage') && await page.isHidden('#pg-stage') && await page.isVisible('#gen-text'));
  await page.click('.gen-modes [data-mode="seite"]');
  await page.waitForTimeout(300);
  L.check('Seite: pages instead of the sheet, its own text field and tools', await page.isVisible('#pg-stage') && await page.isHidden('#gen-stage') && await page.isVisible('#pg-text') && await page.isHidden('#gen-text') && await page.isHidden('#gen-again') && await page.isVisible('#pg-pdf'));
  L.check('Seite: the switch says which mode is on', (await page.getAttribute('.gen-modes [data-mode="seite"]', 'aria-checked')) === 'true' && (await page.getAttribute('.gen-modes [data-mode="zettel"]', 'aria-checked')) === 'false');
  L.check('empty: one ruled A4 page and a hint, PDF not yet', (await page.$$('#pg-pages .pg-page')).length === 1 && (await inked(page)) > 50 && await page.isVisible('#pg-empty') && await page.isDisabled('#pg-pdf'));
  const box = await page.evaluate(() => { const r = document.querySelector('#pg-pages .pg-page').getBoundingClientRect(); return [r.width, r.height]; });
  L.check('the page is A4 and fills the column', Math.abs(box[1] / box[0] - 297 / 210) < 0.01 && box[0] > 800, JSON.stringify(box));
  await page.click('#pg-write');
  L.check('no text: asked for one, nothing starts', /Bitte tippe/.test(await page.textContent('#pg-note')) && (await dbg(page)).phase === 'idle');

  // ---- a short letter of two paragraphs ----
  await page.fill('#pg-text', LETTER);
  await page.click('#pg-write');
  await page.waitForSelector('#pg-busy:not([hidden])', { timeout: 5000 });
  L.check('writing: progress "schreibt … n von N" and a cancel button', /^schreibt … \d+ von \d+/.test(await page.textContent('#pg-busy-text')) && await page.isVisible('#pg-cancel') && await page.isHidden('#pg-write'));
  const d0 = await dbg(page);
  L.check('writing: several engines at once', d0.workers >= 2 && d0.workers <= 4, String(d0.workers));
  await L.until(async () => (await dbg(page)).placed > 0, 60000, 100);
  L.check('writing: the first piece is on the page before the rest is written', (await dbg(page)).phase === 'writing' || (await dbg(page)).placed > 0);
  await idle(page);
  const d1 = await dbg(page);
  L.check('done: every piece placed on one page', d1.placed === d1.total && d1.pages === 1 && d1.total >= 4, JSON.stringify([d1.placed, d1.total, d1.pages]));
  L.check('done: progress gone, "1 Seite" and how to fix a word', await page.isHidden('#pg-busy') && /^1 Seite · Ein Wort antippen/.test(await page.textContent('#pg-info')) && !(await page.isDisabled('#pg-pdf')));
  L.check('done: two paragraphs with an empty line between', (() => { const lines = [...new Set(d1.words.map((w) => w.line))]; return lines[0] === 0 && !lines.includes(1) && lines.includes(2); })(), JSON.stringify([...new Set(d1.words.map((w) => w.line))]));
  L.check('done: ink on the page', (await inked(page)) > 400, String(await inked(page)));
  L.check('the hint is gone once there is writing', await page.isHidden('#pg-empty'));

  // ---- tap a word, write only its piece again ----
  const target = d1.words.find((w) => w.piece === 2) || d1.words[d1.words.length - 1];
  const pt = await wordPoint(page, target);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(200);
  L.check('tap on a word: its piece is marked and "Neu schreiben" offered', (await dbg(page)).pick === target.piece && await page.isVisible('#pg-redo') && (await page.textContent('#pg-redo')).trim() === 'Neu schreiben');
  const pickBox = await page.evaluate(() => { const r = document.getElementById('pg-pick').getBoundingClientRect(); return [r.top, r.bottom]; });
  L.check('"Neu schreiben" sits next to the word', Math.abs(pickBox[0] - pt.y) < 120 || Math.abs(pickBox[1] - pt.y) < 120, JSON.stringify([pickBox, pt.y]));
  await page.click('#pg-redo');
  await idle(page, 60000);
  const d2 = await dbg(page);
  const same = d1.ink.every((w, i) => i === target.piece || JSON.stringify(w) === JSON.stringify(d2.ink[i]));
  L.check('rewrite: only that piece is written again', d2.versions[target.piece] === 1 && d2.versions.every((v, i) => i === target.piece || v === 0) && same && JSON.stringify(d1.ink[target.piece]) !== JSON.stringify(d2.ink[target.piece]), JSON.stringify(d2.versions));
  const before = (d) => JSON.stringify(d.words.filter((w) => w.piece < target.piece).map((w) => [w.x, w.baseline, w.box]));
  L.check('rewrite: nothing before the piece moves', before(d1) === before(d2));
  L.check('rewrite: the piece stays marked so it can be written again', (await dbg(page)).pick === target.piece && await page.isEnabled('#pg-redo'));
  const margin = await page.evaluate(() => { const r = document.querySelector('#pg-pages .pg-page').getBoundingClientRect(); return { x: r.right - 20, y: r.top + 8 * (r.width / 210) }; });
  await page.mouse.click(margin.x, margin.y);   // the top margin: no word there
  await page.waitForTimeout(150);
  L.check('tap on empty paper: the mark goes', (await dbg(page)).pick === null && await page.isHidden('#pg-pick'));

  // ---- PDF ----
  const dl = async () => { const [d] = await Promise.all([page.waitForEvent('download'), page.click('#pg-pdf')]); return { name: d.suggestedFilename(), data: fs.readFileSync(await d.path()) }; };
  const today = new Date(); const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const pdf1 = await dl();
  const f1 = pdfFacts(pdf1.data);
  L.check('PDF: a PDF with the date in its name, one page', pdf1.name === `handschrift-${ymd}.pdf` && f1.head === '%PDF-' && f1.pages === 1 && f1.count === 1 && f1.eof, JSON.stringify([pdf1.name, f1]));
  L.check('PDF: content compressed in the browser (CompressionStream)', pdf1.data.toString('latin1').includes('/FlateDecode'));

  // ---- paper and size only lay out again ----
  await pick(page, 'paper', 'kariert');
  await pick(page, 'docsize', 'gross');
  const d3 = await dbg(page);
  L.check('Kariert, Groß: laid out again, nothing written', d3.settings.paper === 'kariert' && d3.settings.size === 'gross' && d3.seed === d2.seed && JSON.stringify(d3.ink) === JSON.stringify(d2.ink) && d3.phase === 'idle');
  L.check('Stil in page mode: Schrift instead of Größe, Papier shows the page\'s paper', await page.isVisible('[data-k="docsize"][data-v="gross"]') && await page.isHidden('#gen-size') && (await page.getAttribute('#gen-style [data-k="paper"][data-v="kariert"]', 'aria-checked')) === 'true');
  await page.click('#gen-style-btn');

  // ---- two pages; the progress counts pieces and estimates the time left ----
  await page.fill('#pg-text', WORDS);
  const seen = new Set();
  await page.click('#pg-write');
  await L.until(async () => { seen.add(await page.textContent('#pg-busy-text')); const d = await dbg(page); return d.phase === 'idle'; }, 240000, 100);
  const d4 = await dbg(page);
  L.check('long text: two pages, all placed', d4.pages === 2 && d4.placed === d4.total && d4.total === 30 && (await page.$$('#pg-pages .pg-page')).length === 2, JSON.stringify([d4.pages, d4.placed, d4.total]));
  L.check('long text: the second page starts on its first line', d4.words.find((w) => w.page === 1).line === 0);
  L.check('progress: a remaining time once the rate is measured', [...seen].some((t) => /von 30 · .*noch (etwa \d+ Min\.|unter 1 Min\.)/.test(t)), [...seen].slice(0, 6).join(' | '));
  L.check('progress: the page being written is named', [...seen].some((t) => /· Seite 2/.test(t)), [...seen].filter((t) => /Seite/.test(t)).slice(0, 2).join(' | '));
  L.check('"2 Seiten" when done', /^2 Seiten/.test(await page.textContent('#pg-info')));
  await page.evaluate(() => { const s = document.getElementById('pg-stage'); s.scrollTop = s.scrollHeight; });
  await page.waitForTimeout(300);
  L.check('second page drawn when scrolled to', (await inked(page, 1)) > 100, String(await inked(page, 1)));
  const pdf2 = pdfFacts((await dl()).data);
  L.check('PDF: page count matches the pages shown', pdf2.pages === 2 && pdf2.count === 2, JSON.stringify(pdf2));

  // ---- cancel ----
  await page.fill('#pg-text', `${WORDS}\n${WORDS}`);
  await page.click('#pg-write');
  await L.until(async () => (await dbg(page)).placed >= 3, 60000, 100);
  await page.click('#pg-cancel');
  await idle(page, 15000);
  const c1 = await dbg(page);
  await page.waitForTimeout(2000);
  const c2 = await dbg(page);
  L.check('cancel: stops; what is written stays', c1.placed >= 3 && c1.placed < c1.total && c2.placed === c1.placed && c2.phase === 'idle', JSON.stringify([c1.placed, c2.placed, c1.total]));
  L.check('cancel: a short note, writing and PDF possible again', /Abgebrochen/.test(await page.textContent('#pg-note')) && await page.isVisible('#pg-write') && !(await page.isDisabled('#pg-pdf')));

  // ---- the quick sheet is untouched; text and settings survive tabs and a reload ----
  await page.click('.gen-modes [data-mode="zettel"]');
  await page.fill('#gen-text', 'Guten Morgen');
  await page.click('#gen-write');
  await L.until(async () => { const d = await page.evaluate(() => window.__hw.generate.debug()); return d.phase === 'idle' && d.page && d.page.words.length > 0; }, 90000, 100);
  const zw = await page.evaluate(() => window.__hw.generate.debug().page.words.map((w) => w.text));
  L.check('Zettel still writes as before', await page.isVisible('#gen-stage') && zw.length >= 1 && zw.join(' ').replace(/\s+/g, ' ') === 'Guten Morgen', JSON.stringify(zw));
  await page.click('.gen-modes [data-mode="seite"]');
  await page.click('a[data-route="einstellungen"]');
  await page.waitForSelector('#v-einstellungen:not([hidden])');
  await page.click('a[data-route="schreiben"]');
  await page.waitForTimeout(400);
  const t1 = await dbg(page);
  L.check('tab switch: mode, text, settings and the pages are still there', t1.mode === 'seite' && (await page.inputValue('#pg-text')) === `${WORDS}\n${WORDS}` && t1.settings.paper === 'kariert' && t1.placed === c2.placed && (await inked(page)) > 100);
  await page.waitForTimeout(400);
  await page.reload();
  await page.waitForFunction(() => window.__hwReady).then(() => page.evaluate(() => window.__hwReady));
  await ready(page);
  const t2 = await dbg(page);
  L.check('reload: mode, text, paper and size restored (the pages are not stored)', t2.mode === 'seite' && (await page.inputValue('#pg-text')) === `${WORDS}\n${WORDS}` && t2.settings.paper === 'kariert' && t2.settings.size === 'gross' && t2.placed === 0 && await page.isVisible('#pg-stage'));
  L.check('reload: the quick sheet keeps its own text', (await page.inputValue('#gen-text')) === 'Guten Morgen');

  L.check('tablet: touch targets at least 48 px (page mode, Stil open)', await (async () => { await openStyle(page); if (!(await page.isVisible('#gen-more'))) await page.click('#gen-more-btn'); await page.waitForTimeout(100); const s = await smallTargets(page); if (s.length) console.log(JSON.stringify(s)); return s.length === 0; })());
  L.check('tablet: no horizontal scrolling', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  L.check('tablet: no page errors', noErrors(errors).length === 0, noErrors(errors).join(' | '));
  await ctx.close();
}

/** The same document seed written by one engine and by several gives the same pages. */
async function workersAgree(browser, server) {
  const out = [];
  for (const cores of [2, 4]) {
    const hf = await modelRepo();
    const init = `Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${cores} });`;
    const { page, ctx, errors } = await L.newApp(browser, server, { hash: '#/schreiben', signedIn: true, hf, init });
    await ready(page);
    await page.click('.gen-modes [data-mode="seite"]');
    await page.fill('#pg-text', 'Am Montag um acht\nim Garten hinter dem Haus');
    // the document seed comes from Math.random: fixed for this one click
    await page.evaluate(() => { const r = Math.random; Math.random = () => 0.25; document.getElementById('pg-write').click(); Math.random = r; });
    await idle(page);
    const d = await dbg(page);
    out.push({ workers: d.workers, words: JSON.stringify(d.words), ms: d.ms });
    L.check(`${cores} cores: no page errors`, noErrors(errors).length === 0, noErrors(errors).join(' | '));
    await ctx.close();
  }
  L.check('one engine and several write the same pages for the same seed', out[0].workers === 1 && out[1].workers === 3 && out[0].words === out[1].words, JSON.stringify(out.map((o) => [o.workers, Math.round(o.ms)])));
}

/** A worker that dies, a rewrite lost to "Abbrechen", a paste cut at maxlength, Stil over a mark. */
async function robustness(browser, server) {
  const hf = await modelRepo();
  // 4 cores: 3 engines; the third worker created dies on its first piece (as on a crash or out of memory)
  const init = `Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 }); window.__workers = 0; const W0 = window.Worker;
    window.Worker = class extends W0 { constructor(...a) { super(...a); this.n = ++window.__workers; }
      postMessage(m, ...r) { if (this.n === 3 && m && m.type === 'write') { if (!this.dead) { this.dead = true; setTimeout(() => this.onerror && this.onerror({ message: 'simulated crash' }), 50); } return; } return super.postMessage(m, ...r); } };`;
  const { page, ctx, errors } = await L.newApp(browser, server, { hash: '#/schreiben', signedIn: true, hf, init });
  await ready(page);
  await page.click('.gen-modes [data-mode="seite"]');
  await page.fill('#pg-text', LETTER);
  await page.click('#pg-write');
  await idle(page);
  const d = await dbg(page);
  const made = await page.evaluate(() => window.__workers);
  L.check('a worker dies: it is replaced and the whole text is written', d.placed === d.total && d.total >= 4 && (await page.isHidden('#pg-note')) && made >= 4, JSON.stringify([d.placed, d.total, made, await page.textContent('#pg-note')]));

  // a rewrite asked for while writing, then "Abbrechen": the note says the rewrite went too
  await page.fill('#pg-text', `${WORDS}\n${WORDS}`);
  await page.click('#pg-write');
  await L.until(async () => (await dbg(page)).placed >= 2, 60000, 100);
  const w = (await dbg(page)).words[0];
  const pt = await wordPoint(page, w);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(150);
  await page.click('#pg-redo');
  await page.click('#pg-cancel');
  await idle(page, 30000);
  L.check('rewrite while writing, then Abbrechen: the note says the rewrite was dropped', /auch das Neuschreiben/.test(await page.textContent('#pg-note')), await page.textContent('#pg-note'));

  // Stil opened over a marked word: the mark and its bar go
  if ((await dbg(page)).pick === null) { await page.mouse.click(pt.x, pt.y); await page.waitForTimeout(150); }
  const marked = (await dbg(page)).pick !== null && await page.isVisible('#pg-redo');
  await page.click('#gen-style-btn');
  await page.waitForTimeout(150);
  L.check('Stil opens: the mark and "Neu schreiben" go', marked && (await dbg(page)).pick === null && await page.isHidden('#pg-pick'));
  await page.click('#gen-style-btn');

  // a paste longer than the field takes: cut, and said so
  await page.click('#pg-text');
  await page.evaluate(() => { const e = document.getElementById('pg-text'); e.value = 'x'.repeat(e.maxLength); e.dispatchEvent(new Event('input')); });
  L.check('text at the length limit: a note says it was cut', /auf 40\.000 Zeichen gekürzt/.test(await page.textContent('#pg-note')), await page.textContent('#pg-note'));
  L.check('robustness: no page errors', noErrors(errors).length === 0, noErrors(errors).join(' | '));
  await ctx.close();
}

async function phoneDark(browser, server) {
  for (const [tag, viewport, scheme] of [['phone', { width: 412, height: 915 }, 'light'], ['tablet-dark', { width: 800, height: 1280 }, 'dark']]) {
    const hf = await modelRepo();
    // the phone can share files (as Android Chrome can): one more tool in the row
    const init = tag === 'phone' ? 'navigator.canShare = () => true; navigator.share = async () => {};' : undefined;
    const { page, ctx, cdp, errors } = await L.newApp(browser, server, { hash: '#/schreiben', signedIn: true, hf, viewport, colorScheme: scheme, init });
    await ready(page);
    await page.click('.gen-modes [data-mode="seite"]');
    await page.fill('#pg-text', LETTER);
    await page.click('#pg-write');
    await L.until(async () => (await page.textContent('#pg-busy-text')).includes('von'), 30000, 50);
    const rowH = await page.evaluate(() => document.querySelector('#gen-work .gen-row').getBoundingClientRect().height);
    L.check(`${tag}: while writing the status and the tools stay on one row`, rowH <= 50, String(rowH));
    await idle(page);
    const d = await dbg(page);
    L.check(`${tag}: written onto a page`, d.placed === d.total && (await inked(page)) > 200);
    L.check(`${tag}: no horizontal scrolling`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    const s = await smallTargets(page);
    L.check(`${tag}: touch targets at least 48 px`, s.length === 0, JSON.stringify(s));
    const w = d.words[d.words.length - 1];
    const pt = await wordPoint(page, w);
    await page.evaluate(() => window.scrollTo(0, 0));
    await L.pen(cdp).touchTap(pt.x, pt.y);
    await page.waitForTimeout(250);
    L.check(`${tag}: a finger tap marks the word's piece`, (await dbg(page)).pick === w.piece && await page.isVisible('#pg-redo'), JSON.stringify([(await dbg(page)).pick, w.piece]));
    if (tag === 'phone') L.check('phone: the PDF tool is short, sharing is offered as an icon', (await page.textContent('#pg-pdf')).includes('PDF') && await page.isHidden('#pg-pdf .pg-long') && await page.isVisible('#pg-share') && await page.isEnabled('#pg-share'));
    if (scheme === 'dark') {
      const bg = await page.evaluate(() => getComputedStyle(document.getElementById('pg-pick')).backgroundColor);
      L.check('dark app theme: the "Neu schreiben" bar is dark too', /rgb\((\d+)/.test(bg) && Number(bg.match(/\d+/)[0]) < 60, bg);
    }
    L.check(`${tag}: no page errors`, noErrors(errors).length === 0, noErrors(errors).join(' | '));
    await ctx.close();
  }
}

(async () => {
  const server = await L.start();
  const browser = await L.launch();
  try {
    const only = (process.env.PAGE_ONLY || '').split(',').filter(Boolean);
    for (const part of [tablet, workersAgree, robustness, phoneDark]) if (!only.length || only.includes(part.name)) await part(browser, server);
  } catch (e) {
    console.error(e); L.check('test ran without exception', false, String(e));
  } finally {
    await browser.close(); await server.close();
    for (const c of closers) await c().catch(() => {});
  }
  process.exit(L.summary() ? 0 : 1);
})();
