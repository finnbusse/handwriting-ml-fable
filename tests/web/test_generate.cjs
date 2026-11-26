// The Schreiben screen: model download and cache, writing, export, settings, offline.
// Needs the small test model in tests/engine/fixtures (not in git); without it the file is skipped.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('./lib.cjs');

const FIX = path.resolve(__dirname, '..', 'engine', 'fixtures');
if (!fs.existsSync(path.join(FIX, 'model.json')) || !fs.existsSync(path.join(FIX, 'model.bin'))) {
  console.log('SKIP: tests/engine/fixtures has no model.json / model.bin (generate them with scripts/make_engine_fixture.py); Schreiben tests not run');
  process.exit(0);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const BIN1 = fs.readFileSync(path.join(FIX, 'model.bin'));
const MAN1 = JSON.parse(fs.readFileSync(path.join(FIX, 'model.json'), 'utf8'));
// A second "newer" model: one weight differs in its lowest mantissa bit, still a valid model.
const BIN2 = Buffer.from(BIN1); BIN2[0] ^= 1;
const MAN2 = Object.assign({}, MAN1, { sha256: sha256(BIN2) });
// A third one announced with its own checksum, but the file that arrives is damaged.
const BIN3 = Buffer.from(BIN1); BIN3[2] ^= 1;
const MAN3 = Object.assign({}, MAN1, { sha256: sha256(BIN3) });
const BIN3_DAMAGED = Buffer.from(BIN3); BIN3_DAMAGED[100000] ^= 0x55;
const REPO = `/${L.FAKE_USER}/handwriting-fable-model/resolve/main/`;
const http = require('http');

/** Stands in for the CDN host model.bin is redirected to (page.route does not see redirect targets). */
function startCdn(st) {
  const seen = [];
  const srv = http.createServer(async (req, res) => {
    seen.push(req.headers);
    const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': '*', 'access-control-allow-headers': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    st.binGets++;
    if (st.binDelay) await new Promise((r) => setTimeout(r, st.binDelay));
    res.writeHead(200, Object.assign({ 'content-type': 'application/octet-stream', 'content-length': st.bin.length }, cors));
    res.end(st.bin);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) })));
}

/** The model repo as a mock: the files served can be changed while the test runs. */
const closers = [];
async function modelRepo(init = {}) {
  const st = Object.assign({ cdn: null, manifest: MAN1, bin: BIN1, trainedOn: { date: '2026-11-20', lines: 100 }, binDelay: 0, offline: false, missing: false, binGets: 0 }, init);
  st.handler = async (req) => {
    if (st.offline) return 'abort';
    const u = new URL(req.url);
    if (u.pathname === '/api/whoami-v2') return { status: 200, body: { name: L.FAKE_USER } };
    if (!u.pathname.startsWith(REPO)) return null;
    const file = u.pathname.slice(REPO.length);
    if (st.missing) return { status: 404 };
    if (file === 'model.json') return { status: 200, body: JSON.stringify(st.manifest) };
    if (file === 'trained_on.json') return st.trainedOn ? { status: 200, body: st.trainedOn } : { status: 404 };
    if (file === 'model.bin') return { status: 302, headers: { location: `${st.cdn.url}/repos/ab/cd/model.bin?download=true` }, body: '' };
    return { status: 404 };
  };
  st.cdn = await startCdn(st);
  closers.push(st.cdn.close);
  return st;
}

const TEXT_SHORT = 'Liebe Grüße';
const TEXT_LONG = 'Liebe Grüße aus dem Urlaub, das Wetter ist herrlich';

const ready = (page) => page.waitForSelector('#gen-work:not([hidden])', { timeout: 20000 });
const state = (page) => page.evaluate(() => { const d = window.__hw.generate.debug(); return { phase: d.phase, words: d.page ? d.page.words.length : 0, lines: d.page ? d.page.lines : 0, width: d.page ? d.page.width : 0, seed: d.seed, sha: d.sha, bad: d.bad, settled: d.settled, strokes: d.page ? d.page.strokes.length : 0, first: d.page ? Array.from(d.page.strokes[0] || []).slice(0, 30).map((v) => Math.round(v * 1000)) : [] }; });
/** Finished: generation over and the pen has caught up. */
const finished = async (page, timeout = 90000) => L.until(async () => { const s = await state(page); return s.phase === 'idle' && s.words > 0 && s.settled === s.strokes; }, timeout, 100);
/** Number of inked pixels (alpha > 0) on the sheet's ink, and the colour of the first one.
 *  The ink is a stack of strip canvases drawn by a worker (paint-worker.js): its pixels are
 *  read through a copy of the strips put together. */
const ink = (page) => page.evaluate(async () => {
  await window.__hw.generate.painted();
  const c = window.__hw.generate.inkCopy();
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0, rgb = null;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 40) { n++; if (!rgb && d[i] > 200) rgb = [d[i - 3], d[i - 2], d[i - 1]]; }
  return { n, rgb, w: c.width, h: c.height };
});
const type = async (page, text) => { await page.fill('#gen-text', text); };
const writeText = async (page, text) => { await type(page, text); await page.click('#gen-write'); await finished(page); };
const setRange = (page, id, v) => page.evaluate(([i, val]) => { const e = document.getElementById(i); e.value = val; e.dispatchEvent(new Event('input', { bubbles: true })); }, [id, v]);
/** The look sits behind "Stil", the export behind "Speichern". */
const openStyle = async (page) => { if (!(await page.isVisible('#gen-style'))) await page.click('#gen-style-btn'); };
const openSave = async (page) => { if (!(await page.isVisible('#gen-save-menu'))) await page.click('#gen-save'); };
const openMore = async (page) => { await openStyle(page); if (!(await page.isVisible('#gen-more'))) await page.click('#gen-more-btn'); };
const pickInk = async (page, name) => { await openMore(page); await page.click(`#gen-inks [data-ink="${name}"]`); };
const pick = async (page, key, value) => { await openStyle(page); await page.click(`.gen-choice[data-k="${key}"][data-v="${value}"]`); await page.waitForTimeout(80); };
/** The model in the most recently used cache slot (model-store.js keeps up to three). */
const cachedSha = (page) => page.evaluate(async () => {
  const st = window.__hw.store;
  const t = (await st.kvGet('modelSlots', null)) || {};
  const slot = Object.keys(t).sort((a, b) => t[b].usedAt - t[a].usedAt)[0] || 'model';
  const e = await st.kvGet(slot, null);
  return e ? e.manifest.sha256 : null;
});
const infoText = (page) => page.textContent('#gi-text');

async function tabletRun(browser, server) {
  const repo = await modelRepo({ binDelay: 900 });
  const A = await L.newApp(browser, server, { hash: '#/schreiben', signedIn: true, hf: repo.handler });
  const { page, ctx, hfLog, errors } = A;
  const shot = (name) => L.shot(page, `gen-tablet-${name}`);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(server.url).origin }).catch(() => {});

  // ---- first download, with progress ----
  await page.waitForSelector('#gen-model:not([hidden])');
  const seen = new Set();
  await L.until(async () => { const t = await page.textContent('#gm-text'); seen.add(t); return /von 7,7 MB/.test(t); }, 8000, 30);
  L.check('download: progress in MB is shown', [...seen].some((t) => /^Dein Modell wird geladen … \d+,\d von 7,7 MB$/.test(t)), [...seen].join(' | '));
  await shot('01-downloading');
  await ready(page);
  L.check('download: ready, no card any more', !(await page.isVisible('#gen-model')));
  L.check('download: model cached in IndexedDB under its checksum', (await cachedSha(page)) === MAN1.sha256);
  L.check('download: "Modell vom <date>"', (await infoText(page)) === 'Modell vom 20. November 2026', await infoText(page));
  const jsonReq = hfLog.find((e) => e.url.endsWith('/model.json'));
  const cdnReq = repo.cdn.seen.find((h) => h['access-control-request-method'] === undefined) || repo.cdn.seen[0];
  L.check('download: token sent to huggingface.co, not to the CDN redirect target', jsonReq && jsonReq.headers.authorization === `Bearer ${L.FAKE_TOKEN}` && cdnReq && !cdnReq.authorization, JSON.stringify([jsonReq && jsonReq.headers.authorization, cdnReq && cdnReq.authorization]));
  L.check('download: nothing but reads sent to Hugging Face', hfLog.every((e) => ['GET', 'OPTIONS'].includes(e.method)), hfLog.map((e) => e.method).join());
  L.check('empty sheet shows its hint', await page.isVisible('#gen-empty') && (await ink(page)).n === 0);
  L.check('"Schreiben" is enabled, "Nochmal" and exports are not yet', !(await page.isDisabled('#gen-write')) && await page.isDisabled('#gen-again') && await page.isDisabled('#gen-png'));
  await page.waitForTimeout(150);
  await shot('02-ready-empty');

  // ---- short text ----
  await type(page, '');
  await page.click('#gen-write');
  L.check('empty text: asked to type something, nothing starts', (await page.textContent('#gen-note')).includes('Bitte tippe') && (await state(page)).phase === 'idle');
  await type(page, TEXT_SHORT);
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('#gen-busy:not([hidden])', { timeout: 5000 });
  L.check('writing: quiet "schreibt …" state with a cancel button', /schreibt …/.test(await page.textContent('#gen-busy-text')) && await page.isVisible('#gen-cancel'));
  L.check('writing: writing again meanwhile is not possible', await page.isDisabled('#gen-write'));
  await L.until(async () => (await ink(page)).n > 200, 60000, 80);
  await shot('03-writing');
  await finished(page);
  const first = await ink(page);
  L.check('finished: ink on the canvas', first.n > 1500, String(first.n));
  L.check('finished: busy state gone, exports enabled', !(await page.isVisible('#gen-busy')) && !(await page.isDisabled('#gen-png')) && !(await page.isDisabled('#gen-again')));
  L.check('finished: devicePixelRatio-aware canvas', first.w === Math.round((await page.evaluate(() => document.getElementById('gen-paper').clientWidth)) * 2), `canvas ${first.w}px`);
  await shot('04-done-short');

  // ---- long text: several lines; again gives a different page ----
  await setRange(page, 'gen-size', 24);
  await writeText(page, TEXT_LONG);
  const A1 = await state(page);
  L.check('long text wraps into several lines', A1.lines >= 3 && A1.words >= 2, JSON.stringify([A1.lines, A1.words]));
  L.check('no complaints about the writing (or one quiet line)', (await page.isHidden('#gen-bad')) || /unsauber/.test(await page.textContent('#gen-bad')));
  const inkLong = await ink(page);
  L.check('long text: more ink than the short one', inkLong.n > first.n, `${inkLong.n} vs ${first.n}`);
  await shot('05-done-long');
  await page.click('#gen-again');
  await page.waitForSelector('#gen-busy:not([hidden])');
  await finished(page);
  const A2 = await state(page);
  L.check('"Nochmal schreiben": new seed, different strokes', A2.seed !== A1.seed && JSON.stringify(A2.first) !== JSON.stringify(A1.first), JSON.stringify([A1.seed, A2.seed]));
  L.check('"Nochmal schreiben" wrote the old text although the box was not touched', (await page.inputValue('#gen-text')) === TEXT_LONG);

  // ---- colour and size only redraw / lay out again, no generating ----
  const seedBefore = (await state(page)).seed;
  await pickInk(page, 'black');
  await page.waitForTimeout(100);
  const black = await ink(page);
  await pickInk(page, 'blue');
  await page.waitForTimeout(100);
  const blue = await ink(page);
  L.check('ink colour: redrawn at once, same amount of ink', black.rgb && black.rgb[0] < 60 && blue.rgb && blue.rgb[2] > 150 && Math.abs(blue.n - black.n) < 0.02 * black.n, JSON.stringify([black.rgb, blue.rgb, black.n, blue.n]));
  await setRange(page, 'gen-size', 14);
  await page.waitForTimeout(250);
  const small = await state(page);
  L.check('smaller size: laid out again without writing (same pieces, wider page, fewer lines)', small.phase === 'idle' && small.seed === seedBefore && small.width > A2.width && small.lines < A2.lines && small.words === A2.words && small.strokes === A2.strokes, JSON.stringify([A2.width, small.width, A2.lines, small.lines]));
  await setRange(page, 'gen-spacing', 8.5);
  await page.waitForTimeout(250);
  const spaced = await page.evaluate(() => window.__hw.generate.debug().page.height);
  await setRange(page, 'gen-spacing', 5.5);
  await page.waitForTimeout(250);
  const tight = await page.evaluate(() => window.__hw.generate.debug().page.height);
  L.check('line spacing changes the page height', spaced > tight + 2, `${spaced} vs ${tight}`);
  L.check('ink still on the sheet after layout changes', (await ink(page)).n > 1500);

  // ---- resize: the finished page is scaled, not lost ----
  await page.setViewportSize({ width: 900, height: 800 });
  await page.waitForTimeout(300);
  const narrow = await ink(page);
  L.check('window resize: page redrawn to the new width', narrow.n > 1500 && narrow.w === Math.round(await page.evaluate(() => document.getElementById('gen-paper').clientWidth) * 2), JSON.stringify(narrow));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(300);

  // ---- export ----
  const dl = async (sel) => { await openSave(page); const [d] = await Promise.all([page.waitForEvent('download'), page.click(sel)]); return { name: d.suggestedFilename(), data: fs.readFileSync(await d.path()) }; };
  const svg = await dl('#gen-svg');
  const svgText = svg.data.toString('utf8');
  L.check('SVG export: file name, path data, no NaN', /^handschrift-\d{4}-\d{2}-\d{2}\.svg$/.test(svg.name) && /<path d="M[^"]+"/.test(svgText) && !svgText.includes('NaN') && svgText.includes('<svg'), svg.name + ' ' + svgText.slice(0, 80));
  const png = await dl('#gen-png');
  const w = png.data.readUInt32BE(16), h = png.data.readUInt32BE(20);
  L.check('PNG export: a real PNG, crisp and not trivial', /^handschrift-\d{4}-\d{2}-\d{2}\.png$/.test(png.name) && png.data.slice(1, 4).toString() === 'PNG' && w >= 1500 && h > 100 && png.data.length > 20000, `${png.name} ${w}x${h} ${png.data.length} bytes`);
  const today = new Date(); const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  L.check('export file names carry the date', png.name === `handschrift-${ymd}.png`, png.name);
  await openSave(page);
  if (await page.isVisible('#gen-copy')) {
    await page.click('#gen-copy');
    await L.until(async () => /^Kopiert\.|Kopieren hat nicht/.test(await page.textContent('#toast')), 5000);
    L.check('copy: PNG on the clipboard', (await page.textContent('#toast')) === 'Kopiert.', await page.textContent('#toast'));
    const type0 = await page.evaluate(async () => { try { const items = await navigator.clipboard.read(); return items[0].types.join(); } catch (e) { return String(e); } });
    L.check('copy: clipboard holds image/png', type0 === 'image/png', type0);
  } else L.check('copy: hidden where ClipboardItem is missing', true);

  // ---- cancel ----
  await setRange(page, 'gen-size', 16);
  await page.waitForTimeout(150);
  const LONGER = 'Heute war ein langer Tag, aber am Abend sind wir noch an den See gegangen und haben die Enten gefüttert. Danach gab es Pizza.';
  await type(page, LONGER);
  await page.click('#gen-write');
  await L.until(async () => (await state(page)).words > 0, 60000, 100);
  await page.click('#gen-cancel');
  await L.until(async () => (await state(page)).phase === 'idle', 5000, 50);
  const c1 = await state(page);
  await page.waitForTimeout(2500);
  const c2 = await state(page);
  L.check('cancel: stops writing; what was written stays', c1.words > 0 && c1.words < LONGER.split(' ').length && c2.words === c1.words && c2.phase === 'idle', JSON.stringify([c1.words, c2.words]));
  L.check('cancel: a short note, buttons usable again', /Abgebrochen/.test(await page.textContent('#gen-note')) && !(await page.isDisabled('#gen-write')) && (await ink(page)).n > 200);
  await shot('06-cancelled');

  // ---- characters the model cannot write ----
  await writeText(page, 'Hallo § Welt 😀');
  const chars = await page.textContent('#gen-chars');
  L.check('unsupported characters: one quiet hint naming them', chars.includes('„§“') && chars.includes('„😀“') && !chars.includes('„H“'), chars);
  await shot('07-unsupported');
  await type(page, '😀 §');
  await page.click('#gen-write');
  L.check('only unsupported characters: nothing starts, says why', /nichts, was ich schreiben kann/.test(await page.textContent('#gen-note')) && (await state(page)).phase === 'idle');

  // ---- settings are remembered (the text and the controls, not the strokes) ----
  await type(page, 'Guten Morgen');
  await setRange(page, 'gen-bias', 0.9);
  await setRange(page, 'gen-size', 20);
  await setRange(page, 'gen-spacing', 7.5);
  await pickInk(page, 'black');
  await page.waitForTimeout(600);
  const kv = await page.evaluate(() => window.__hw.store.kvGet('generate', null));
  L.check('settings stored', kv && kv.text === 'Guten Morgen' && kv.bias === 0.9 && kv.size === 20 && kv.spacing === 7.5 && kv.look && kv.look.ink === 'black' && !('page' in kv) && !('strokes' in kv), JSON.stringify(kv));

  // ---- reload while Hugging Face is unreachable: the cached model writes ----
  repo.offline = true;
  const binBefore = repo.binGets;
  await page.reload();
  await page.waitForFunction(() => window.__hwReady).then(() => page.evaluate(() => window.__hwReady));
  await ready(page);
  L.check('offline reload: settings restored', (await page.inputValue('#gen-text')) === 'Guten Morgen' && (await page.inputValue('#gen-bias')) === '0.9' && (await page.inputValue('#gen-size')) === '20' && (await page.inputValue('#gen-spacing')) === '7.5' && (await page.getAttribute('#gen-inks [data-ink="black"]', 'aria-checked')) === 'true');
  L.check('offline reload: the strokes are not restored', (await state(page)).words === 0 && (await ink(page)).n === 0);
  L.check('offline reload: cached model in use, no error card', !(await page.isVisible('#gen-model')) && (await infoText(page)) === 'Modell vom 20. November 2026', await infoText(page));
  await page.click('#gen-write');
  await finished(page);
  L.check('offline reload: writes with the cached model', (await ink(page)).n > 1000);
  await shot('08-offline-cached');

  // ---- same manifest online: no new download ----
  repo.offline = false;
  await page.reload();
  await page.waitForFunction(() => window.__hwReady).then(() => page.evaluate(() => window.__hwReady));
  await ready(page);
  await page.waitForTimeout(800);
  L.check('unchanged model: manifest checked, weights not downloaded again', repo.binGets === binBefore && hfLog.some((e) => e.url.endsWith('/model.json')), `${repo.binGets} vs ${binBefore}`);

  // ---- a newer model (different sha): downloaded, checked, replaces the cache ----
  repo.manifest = MAN2; repo.bin = BIN2; repo.trainedOn = { date: '2026-11-24' }; repo.binDelay = 400;
  const oldSha = await cachedSha(page);
  await page.reload();
  await page.waitForFunction(() => window.__hwReady).then(() => page.evaluate(() => window.__hwReady));
  await ready(page);
  await L.until(async () => (await cachedSha(page)) === MAN2.sha256, 20000, 100);
  await L.until(async () => /Neues Modell geladen/.test(await infoText(page)), 10000, 100);
  L.check('newer model: cache replaced after the checksum matched', oldSha === MAN1.sha256 && (await cachedSha(page)) === MAN2.sha256 && repo.binGets === binBefore + 1);
  L.check('newer model: user is told, date is the new one', /^Neues Modell geladen\. Modell vom 24\. November 2026$/.test(await infoText(page)), await infoText(page));
  await shot('09-newer-model');
  await page.click('#gen-write');
  await finished(page);
  L.check('newer model: writes with it', (await ink(page)).n > 1000 && (await state(page)).sha === MAN2.sha256);

  // ---- a damaged download is rejected, the old model stays ----
  repo.manifest = MAN3; repo.bin = BIN3_DAMAGED; repo.binDelay = 0;
  await page.reload();
  await page.waitForFunction(() => window.__hwReady).then(() => page.evaluate(() => window.__hwReady));
  await ready(page);
  await L.until(async () => /beschädigt/.test(await infoText(page)), 20000, 100);
  L.check('damaged model.bin: rejected, old model stays in the cache', (await cachedSha(page)) === MAN2.sha256, await cachedSha(page));
  L.check('damaged model.bin: quiet message', /Das neue Modell war beschädigt und wurde nicht übernommen/.test(await infoText(page)));
  await page.click('#gen-write');
  await finished(page);
  L.check('damaged model.bin: still writes with the old model', (await ink(page)).n > 1000 && (await state(page)).sha === MAN2.sha256);

  L.check('tablet: no page errors', errors.filter((e) => !/Failed to load resource|ERR_/.test(e)).length === 0, errors.join(' | '));
  await ctx.close();
}

async function stateCards(browser, server) {
  // signed out, nothing cached
  {
    const A = await L.newApp(browser, server, { hash: '#/schreiben', hf: (await modelRepo()).handler });
    const { page, ctx, hfLog } = A;
    await page.waitForSelector('#gen-model:not([hidden])');
    L.check('signed out: asks to sign in', (await page.textContent('#gm-text')) === 'Bitte anmelden, damit dein Modell geladen werden kann.' && await page.isVisible('#gm-signin') && !(await page.isVisible('#gen-work')));
    L.check('signed out: no request to Hugging Face', hfLog.length === 0, hfLog.map((e) => e.url).join());
    await L.shot(page, 'gen-tablet-10-signin');
    await page.click('#gm-signin');
    await page.waitForSelector('#dlg-token[open]');
    L.check('signed out: the button opens the sign-in', true);
    await page.fill('#tok-input', L.FAKE_TOKEN);
    await page.click('#tok-ok');
    await ready(page);
    L.check('signing in loads the model without leaving the screen', (await cachedSha(page)) === MAN1.sha256 && !(await page.isVisible('#gen-model')));
    await ctx.close();
  }
  // signed in, no model yet (404)
  {
    const repo = await modelRepo({ missing: true });
    const A = await L.newApp(browser, server, { hash: '#/schreiben', signedIn: true, hf: repo.handler });
    const { page, ctx } = A;
    await page.waitForSelector('#gen-model:not([hidden])');
    await L.until(async () => (await page.textContent('#gm-text')).startsWith('Es gibt noch kein Modell'), 5000);
    L.check('404: "Es gibt noch kein Modell …" with a way to Erfassen', (await page.textContent('#gm-text')) === 'Es gibt noch kein Modell. Schreib zuerst ein paar Zeilen unter Erfassen.' && await page.isVisible('#gm-capture') && await page.isVisible('#gm-retry'));
    await L.shot(page, 'gen-tablet-11-nomodel');
    repo.missing = false;                        // the model appears: "Nochmal prüfen" finds it
    await page.click('#gm-retry');
    await ready(page);
    L.check('404: after the model appears, "Nochmal prüfen" loads it', (await cachedSha(page)) === MAN1.sha256);
    await ctx.close();
  }
  // signed in, repo unreachable and nothing cached: failed + retry
  {
    const repo = await modelRepo({ offline: true });
    const A = await L.newApp(browser, server, { hash: '#/schreiben', signedIn: true, hf: repo.handler });
    const { page, ctx } = A;
    await page.waitForSelector('#gen-model[data-kind="failed"]');
    L.check('no connection, nothing cached: says so and offers a retry', /konnte nicht geladen werden/.test(await page.textContent('#gm-text')) && await page.isVisible('#gm-retry'));
    await L.shot(page, 'gen-tablet-12-failed');
    repo.offline = false;
    await page.click('#gm-retry');
    await ready(page);
    L.check('retry after the connection is back loads the model', (await cachedSha(page)) === MAN1.sha256);
    await ctx.close();
  }
  // damaged download and nothing cached
  {
    const repo = await modelRepo({ manifest: MAN3, bin: BIN3_DAMAGED });
    const A = await L.newApp(browser, server, { hash: '#/schreiben', signedIn: true, hf: repo.handler });
    const { page, ctx } = A;
    await page.waitForSelector('#gen-model[data-kind="checksum"]', { timeout: 20000 });
    L.check('damaged download, nothing cached: message and retry, nothing stored', /beschädigt/.test(await page.textContent('#gm-text')) && await page.isVisible('#gm-retry') && (await cachedSha(page)) === null);
    await ctx.close();
  }
}

// ---------- Stil: pen, stroke width, paper, colours, exports ----------

/** Facts about the two sheet canvases: ink pixels (alpha > 40), their mean brightness, a hash; the paper's lines. */
const sheet = (page) => page.evaluate(async () => {
  await window.__hw.generate.painted();
  const read = (c) => { const t = Object.assign(document.createElement('canvas'), { width: c.width, height: c.height }); t.getContext('2d').drawImage(c, 0, 0); return t.getContext('2d').getImageData(0, 0, c.width, c.height).data; };
  const d = read(window.__hw.generate.inkCopy());
  let n = 0, lum = 0, h = 2166136261;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 40) { n++; lum += (d[i] + d[i + 1] + d[i + 2]) / 3; }
    h = Math.imul(h ^ (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)), 16777619);
  }
  const g = document.getElementById('gen-lines');
  const gd = read(g);
  const at = (x, y) => { const i = 4 * (y * g.width + x); return [gd[i], gd[i + 1], gd[i + 2]]; };
  const bg = at(1, 1);
  const differs = (p) => Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > 12;
  let rows = 0, cols = 0;
  const rowYs = [];
  const x0 = Math.floor(g.width * 0.37), y0 = Math.floor(g.height * 0.61);
  for (let y = 0; y < g.height; y++) if (differs(at(x0, y))) { rows++; rowYs.push(y); }   // horizontal lines crossed going down
  for (let x = 0; x < g.width; x++) if (differs(at(x, y0))) cols++;       // vertical lines crossed going right
  const dbg = window.__hw.generate.debug();
  const baselines = dbg.page && dbg.scale ? [...new Set(dbg.page.words.map((w) => Math.round(w.y * dbg.scale)))] : [];
  return { n, lum: n ? lum / n : 0, hash: h >>> 0, paper: at(Math.floor(g.width / 2), Math.floor(g.height / 2)), bg, rows, cols, rowYs, baselines, runs: dbg.runs, seed: dbg.seed, phase: dbg.phase, look: dbg.look };
});

/** A PNG (Buffer) decoded in the page: size, corner pixel, share of opaque / transparent pixels. */
const pngFacts = (page, buf) => page.evaluate(async (b64) => {
  const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
  const bmp = await createImageBitmap(blob);
  const c = Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let opaque = 0, clear = 0, inked = 0;
  for (let i = 3; i < d.length; i += 4) { if (d[i] === 255) opaque++; if (d[i] === 0) clear++; if (d[i] > 40) inked++; }
  const px = d.length / 4;
  return { w: c.width, h: c.height, corner: Array.from(d.slice(0, 4)), opaque: opaque / px, clear: clear / px, inked: inked / px };
}, buf.toString('base64'));

async function lookRun(browser, server) {
  const repo = await modelRepo();
  const A = await L.newApp(browser, server, { hash: '#/schreiben', signedIn: true, hf: repo.handler });
  const { page, ctx, errors } = A;
  const shot = (name) => L.shot(page, `gen-look-${name}`);
  await ready(page);

  // ---- first time: the look follows the writer's capture sheet ----
  L.check('no capture look: Schreiben\'s own defaults (Fineliner, clearly heavier stroke, blank, dark on light)',
    JSON.stringify((await sheet(page)).look) === JSON.stringify({ pen: 'fineliner', width: 0.32, paper: 'blanko', scheme: 'dark_on_light', ink: 'blueblack' }), JSON.stringify((await sheet(page)).look));
  await page.evaluate(async () => {
    const st = window.__hw.store;
    await st.kvSet('writers', [{ id: 'anna', name: 'Anna' }]);
    await st.kvSet('writer', 'anna');
    await st.kvSet('displayBy', { anna: { pen: 'bleistift', width: 2, paper: 'kariert', scheme: 'light_on_dark' } });
  });
  await page.reload();
  await page.waitForFunction(() => window.__hwReady).then(() => page.evaluate(() => window.__hwReady));
  await ready(page);
  await L.until(async () => (await sheet(page)).look.pen === 'bleistift', 5000, 50);
  let s = await sheet(page);
  L.check('first time: pen, width, paper and colours come from the capture sheet', JSON.stringify(s.look) === JSON.stringify({ pen: 'bleistift', width: 0.32, paper: 'kariert', scheme: 'light_on_dark', ink: 'blue' }) && !(await page.evaluate(() => window.__hw.generate.debug().ownLook)), JSON.stringify(s.look));
  L.check('dark scheme: the sheet element and its paper are dark', s.paper.every((v) => v < 60) && await page.evaluate(() => getComputedStyle(document.getElementById('gen-paper')).backgroundColor) === 'rgb(27, 31, 38)', JSON.stringify(s.paper));
  const hint = await page.evaluate(() => getComputedStyle(document.getElementById('gen-empty')).color);
  L.check('dark scheme: the empty hint is light on the dark sheet', /rgb\((\d+)/.test(hint) && Number(hint.match(/\d+/)[0]) > 120, hint);
  L.check('kariert: horizontal and vertical lines on the empty sheet', s.rows >= 4 && s.cols >= 8, JSON.stringify([s.rows, s.cols]));
  await shot('01-empty-from-capture');

  // ---- write; every option afterwards only redraws ----
  await writeText(page, TEXT_LONG);
  s = await sheet(page);
  L.check('dark scheme: light ink on the dark sheet', s.n > 1500 && s.lum > 150, JSON.stringify([s.n, Math.round(s.lum)]));
  await shot('02-written-from-capture');
  const runs = s.runs, seed = s.seed;

  // each pen draws, and they differ
  const pens = {};
  for (const p of ['fineliner', 'fueller', 'bleistift']) { await pick(page, 'pen', p); pens[p] = await sheet(page); }
  L.check('every pen draws ink', Object.values(pens).every((x) => x.n > 1500), JSON.stringify(Object.values(pens).map((x) => x.n)));
  L.check('the three pens look different', new Set(Object.values(pens).map((x) => x.hash)).size === 3);
  await pick(page, 'pen', 'fineliner');
  L.check('same pen again: exactly the same pixels', (await sheet(page)).hash === pens.fineliner.hash);

  // stroke width: more ink, step by step
  for (const p of ['fineliner', 'fueller']) {
    await pick(page, 'pen', p);
    const ns = [];
    for (const w of [0.14, 0.19, 0.25, 0.32, 0.42]) { await pick(page, 'width', w); ns.push((await sheet(page)).n); }
    L.check(`Strichstärke (${p}): each step inks more`, ns.every((v, i) => i === 0 || v > ns[i - 1] * 1.05), ns.join(' < '));
  }
  await pick(page, 'width', 0.32);

  // paper
  await pick(page, 'paper', 'blanko');
  s = await sheet(page);
  L.check('Blanko: no lines', s.rows === 0 && s.cols === 0, JSON.stringify([s.rows, s.cols]));
  await pick(page, 'paper', 'liniert');
  s = await sheet(page);
  const base = s.baselines.map((y) => s.rowYs.some((r) => Math.abs(r - y) <= 1.5));
  L.check('Liniert: horizontal lines only, one under every line of text', s.rows >= 3 && s.cols === 0 && base.length >= 2 && base.every(Boolean), JSON.stringify([s.rows, s.cols, base]));
  await pick(page, 'paper', 'kariert');
  s = await sheet(page);
  L.check('Kariert: a grid', s.rows >= 6 && s.cols >= 10, JSON.stringify([s.rows, s.cols]));

  // colours
  await pick(page, 'scheme', 'dark_on_light');
  s = await sheet(page);
  L.check('dark on light: light paper, dark ink, the sheet element follows', s.paper.every((v) => v > 200) && s.lum < 110 && (await page.getAttribute('#gen-paper', 'data-scheme')) === 'dark_on_light', JSON.stringify([s.paper, Math.round(s.lum)]));
  await pick(page, 'scheme', 'light_on_dark');
  await openMore(page);
  const inks = [];
  for (const k of ['blueblack', 'black', 'blue']) { await page.click(`#gen-inks [data-ink="${k}"]`); await page.waitForTimeout(80); const x = await sheet(page); inks.push(Math.round(x.lum)); }
  const inkNames = await page.$$eval('#gen-inks [data-ink]', (bs) => bs.map((b) => b.getAttribute('aria-label')));
  L.check('dark sheet: every ink is light, with its own name', inks.every((v) => v > 150) && inkNames.join() === 'Taubenblau,Weiß,Hellblau', JSON.stringify([inks, inkNames]));
  await pick(page, 'pen', 'bleistift');
  L.check('Bleistift: no ink to choose', await page.isHidden('#gen-ink-row'));
  await pick(page, 'pen', 'fineliner');
  await setRange(page, 'gen-size', 14); await page.waitForTimeout(250);
  await setRange(page, 'gen-spacing', 7); await page.waitForTimeout(250);
  s = await sheet(page);
  L.check('none of the options started the network again', s.runs === runs && s.seed === seed && s.phase === 'idle', JSON.stringify([runs, s.runs]));
  await shot('03-options');

  // ---- the animation ends in exactly the pixels of a full redraw ----
  await pick(page, 'pen', 'fueller');
  await pick(page, 'paper', 'liniert');
  await page.click('#gen-write');
  await page.waitForSelector('#gen-busy:not([hidden])');
  let partial = false;
  await L.until(async () => { const d = await page.evaluate(() => { const g = window.__hw.generate.debug(); return [g.settled, g.page ? g.page.strokes.length : 0, g.phase]; }); if (d[2] === 'writing' && d[0] < d[1]) partial = true; return d[2] === 'idle' && d[1] > 0 && d[0] === d[1]; }, 90000, 30);
  const animated = await sheet(page);
  await pick(page, 'pen', 'bleistift');
  await pick(page, 'pen', 'fueller');
  const redrawn = await sheet(page);
  L.check('animation (Füller) ends in exactly the pixels of a full redraw', partial && animated.n > 1500 && animated.hash === redrawn.hash, JSON.stringify([partial, animated.n, redrawn.n]));
  await shot('04-fueller-liniert');

  // ---- export ----
  const dl = async (sel) => { await openSave(page); const [d] = await Promise.all([page.waitForEvent('download'), page.click(sel)]); return { name: d.suggestedFilename(), data: fs.readFileSync(await d.path()) }; };
  const withPaper = await dl('#gen-png');
  const pf = await pngFacts(page, withPaper.data);
  L.check('"Als Bild": opaque, on the dark paper, with ink', pf.opaque === 1 && pf.corner[0] < 60 && pf.corner[3] === 255 && pf.w >= 1500, JSON.stringify(pf));
  const bare = await dl('#gen-ink-png');
  const bf = await pngFacts(page, bare.data);
  L.check('"Ohne Papier": transparent background, only the ink', /-ohne-papier\.png$/.test(bare.name) && bf.corner[3] === 0 && bf.clear > 0.8 && bf.inked > 0.005 && bf.w === pf.w && bf.h === pf.h, JSON.stringify([bare.name, bf]));
  await pick(page, 'pen', 'bleistift');
  const pencilBare = await pngFacts(page, (await dl('#gen-ink-png')).data);
  L.check('"Ohne Papier" with Bleistift: transparent too (the paper is taken out of the grain)', pencilBare.corner[3] === 0 && pencilBare.clear > 0.8 && pencilBare.inked > 0.003, JSON.stringify(pencilBare));
  const svgP = (await dl('#gen-svg')).data.toString('utf8');
  L.check('SVG (Bleistift): paper, lines and grain as vectors and a filter', svgP.includes('<rect width="100%" height="100%" fill="#1B1F26"/>') && /<path d="M0 [\d.]+H/.test(svgP) && svgP.includes('feTurbulence') && !svgP.includes('NaN'), svgP.slice(0, 300));
  await pick(page, 'pen', 'fineliner');
  const svgF = (await dl('#gen-svg')).data.toString('utf8');
  L.check('SVG (Fineliner): one stroke width, the chosen ink', /<g fill="none" stroke="#C9D4FF" stroke-width="3\.84"/.test(svgF), svgF.slice(svgF.indexOf('<g'), svgF.indexOf('<g') + 120));
  await pick(page, 'pen', 'fueller');
  const svgU = (await dl('#gen-svg')).data.toString('utf8');
  L.check('SVG (Füller): several stroke widths', new Set(svgU.match(/stroke-width="[\d.]+"/g)).size >= 4, String(new Set(svgU.match(/stroke-width="[\d.]+"/g)).size));

  // ---- Schreiben keeps its own look from now on ----
  await page.waitForTimeout(500);
  const own = (await sheet(page)).look;
  await page.evaluate(() => window.__hw.store.kvSet('displayBy', { anna: { pen: 'fineliner', width: 0.75, paper: 'linie', scheme: 'dark_on_light' } }));
  await page.reload();
  await page.waitForFunction(() => window.__hwReady).then(() => page.evaluate(() => window.__hwReady));
  await ready(page);
  await page.waitForTimeout(300);
  const back = await sheet(page);
  const checked = await page.$$eval('#gen-style [aria-checked="true"]', (bs) => bs.map((b) => b.dataset.v || b.dataset.ink).join());
  L.check('reload: the look chosen here survives, the capture sheet no longer changes it', JSON.stringify(back.look) === JSON.stringify(own) && checked === 'fueller,0.32,liniert,light_on_dark,blue', JSON.stringify([own, back.look, checked]));
  // a model state on the dark sheet stays readable
  repo.offline = true;
  await page.evaluate(() => window.__hw.store.kvSet('model', null));
  await page.reload();
  await page.waitForFunction(() => window.__hwReady).then(() => page.evaluate(() => window.__hwReady));
  await page.waitForSelector('#gen-model[data-kind="failed"]', { timeout: 20000 });
  const card = await page.evaluate(() => [getComputedStyle(document.getElementById('gm-text')).color, getComputedStyle(document.getElementById('gen-model')).backgroundColor]);
  L.check('dark sheet: a model state reads light on dark', card[0] === 'rgb(230, 233, 238)' && card[1] === 'rgb(27, 31, 38)', JSON.stringify(card));
  await shot('05-state-on-dark');
  L.check('look: no page errors', errors.filter((e) => !/Failed to load resource|ERR_/.test(e)).length === 0, errors.join(' | '));
  await ctx.close();
}

async function phoneAndDark(browser, server) {
  for (const [tag, viewport, dsf, scheme] of [['phone', { width: 412, height: 915 }, 2, 'light'], ['tablet-dark', { width: 1280, height: 800 }, 1, 'dark']]) {
    const repo = await modelRepo({ binDelay: tag === 'phone' ? 700 : 0 });
    const { page, ctx, errors } = await L.newApp(browser, server, { hash: '#/schreiben', signedIn: true, hf: repo.handler, viewport, dsf, colorScheme: scheme });
    const shot = (n) => L.shot(page, `gen-${tag}-${n}`);
    if (tag === 'phone') { await page.waitForSelector('#gen-model:not([hidden])'); await page.waitForTimeout(200); await shot('01-downloading'); }
    await ready(page);
    await page.waitForTimeout(200);
    await shot('02-ready-empty');
    await writeText(page, TEXT_LONG);
    const s = await state(page);
    L.check(`${tag}: long text fills several lines`, s.lines >= 2 && (await ink(page)).n > 1500, JSON.stringify([s.lines, s.width]));
    const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    L.check(`${tag}: no horizontal scrolling`, noScroll);
    await openMore(page);
    await page.waitForTimeout(150);
    const sheetLeft = await page.evaluate(() => { const r = document.getElementById('gen-stage').getBoundingClientRect(); return Math.round(r.height); });
    L.check(`${tag}: Stil and Erweitert open, the sheet stays in view`, sheetLeft >= (tag === 'phone' ? 300 : 200), `${sheetLeft} px of sheet`);
    const styleBox = await page.evaluate(() => { const e = document.getElementById('gen-style'); return [e.clientHeight, e.scrollHeight]; });
    if (tag === 'phone') L.check('phone: the open Stil bar is limited in height and scrolls inside', styleBox[0] <= 0.4 * 915 && styleBox[1] > styleBox[0], JSON.stringify(styleBox));
    await shot('03-style-open');
    const small = await page.evaluate(() => [...document.querySelectorAll('#v-schreiben button, #v-schreiben a.btn, #v-schreiben input[type=range]')].filter((e) => e.offsetParent && !e.hidden).map((e) => { const r = e.getBoundingClientRect(); return [e.id || e.className, Math.round(r.width), Math.round(r.height)]; }).filter(([, w, h]) => h < 47.5 || w < 47.5));
    L.check(`${tag}: touch targets at least 48 px`, small.length === 0, JSON.stringify(small));
    await shot('03-done');
    await page.evaluate(() => { const v = document.getElementById('gen-stage'); v.scrollTop = v.scrollHeight; });
    await page.waitForTimeout(200);
    await shot('04-done-scrolled');
    L.check(`${tag}: no page errors`, errors.filter((e) => !/Failed to load resource|ERR_/.test(e)).length === 0, errors.join(' | '));
    await ctx.close();
  }
}

(async () => {
  const server = await L.start();
  const browser = await L.launch();
  try {
    // GEN_ONLY=lookRun,phoneAndDark runs only those parts (while working on one of them).
    const only = (process.env.GEN_ONLY || '').split(',').filter(Boolean);
    for (const part of [tabletRun, stateCards, lookRun, phoneAndDark]) if (!only.length || only.includes(part.name)) await part(browser, server);
  } catch (e) {
    console.error(e); L.check('test ran without exception', false, String(e));
  } finally {
    await browser.close(); await server.close();
    for (const c of closers) await c().catch(() => {});
  }
  process.exit(L.summary() ? 0 : 1);
})();
