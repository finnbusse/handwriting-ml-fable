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
/** Number of inked pixels (alpha > 0) on the sheet canvas, and the colour of the first one. */
const ink = (page) => page.evaluate(() => {
  const c = document.getElementById('gen-canvas');
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
const pickInk = async (page, name) => { await openStyle(page); await page.click(`#gen-inks [data-ink="${name}"]`); };
const cachedSha = (page) => page.evaluate(async () => { const e = await window.__hw.store.kvGet('model', null); return e ? e.manifest.sha256 : null; });
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
  L.check('settings stored', kv && kv.text === 'Guten Morgen' && kv.bias === 0.9 && kv.size === 20 && kv.spacing === 7.5 && kv.ink === 'black' && !('page' in kv) && !('strokes' in kv), JSON.stringify(kv));

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
    await tabletRun(browser, server);
    await stateCards(browser, server);
    await phoneAndDark(browser, server);
  } catch (e) {
    console.error(e); L.check('test ran without exception', false, String(e));
  } finally {
    await browser.close(); await server.close();
    for (const c of closers) await c().catch(() => {});
  }
  process.exit(L.summary() ? 0 : 1);
})();
