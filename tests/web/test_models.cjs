// Schreiben with several model versions in the repo (models/index.json, hw/models.py):
//   "Neuestes" = the current writer's newest (or the newest of all), following new
//   versions by itself; a chosen version, remembered, downloaded once and cached
//   (at most three on the device); a chosen version that disappears; the status line
//   with date and time; the sheet keeps its text on a switch; an old repo without an
//   index; touch targets; screenshots.
// Needs the small test model in tests/engine/fixtures (not in git); skipped without it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('./lib.cjs');

const FIX = path.resolve(__dirname, '..', 'engine', 'fixtures');
if (!fs.existsSync(path.join(FIX, 'model.json')) || !fs.existsSync(path.join(FIX, 'model.bin'))) {
  console.log('SKIP: tests/engine/fixtures has no model.json / model.bin (generate them with scripts/make_engine_fixture.py); model version tests not run');
  process.exit(0);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const BIN0 = fs.readFileSync(path.join(FIX, 'model.bin'));
const MAN0 = JSON.parse(fs.readFileSync(path.join(FIX, 'model.json'), 'utf8'));
const REPO = `/${L.FAKE_USER}/handwriting-fable-model/resolve/main/`;

/** A valid model that differs from the fixture in one low bit (k = 1, 2, ...). */
function variant(k) {
  const bin = Buffer.from(BIN0); bin[4 * k] ^= 1;
  return { bin, manifest: Object.assign({}, MAN0, { sha256: sha256(bin) }) };
}

function version(k, id, o) {
  const v = variant(k);
  return Object.assign(v, { entry: Object.assign({ id, path: `models/${id}`, lines_only: false, note: null, rounds: 30, best_round: 20, score: -1.9, sha256: v.manifest.sha256, bytes: v.manifest.bytes }, o) });
}

const V1 = version(1, 'hw-rnn-model-finn-20261124-100000', { writer: 'finn', created: '2026-11-24T10:00:00Z', lines: 100 });
const V2 = version(2, 'hw-rnn-model-anna-20261125-120000', { writer: 'anna', created: '2026-11-25T12:00:00Z', lines: 40, note: 'Probe' });
const V3 = version(3, 'hw-rnn-model-finn-20261126-014800', { writer: 'finn', created: '2026-11-26T01:48:00Z', lines: 143, note: 'mit neuen Zeilen' });
const V4 = version(4, 'hw-rnn-model-finn-20261126-090000', { writer: 'finn', created: '2026-11-26T09:00:00Z', lines: 150 });
const ROOT_V = variant(9);

function repo(init = {}) {
  const st = Object.assign({ versions: [V1, V2, V3], index: true, gets: [] }, init);
  st.handler = async (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/api/whoami-v2') return { status: 200, body: { name: L.FAKE_USER } };
    if (!u.pathname.startsWith(REPO)) return null;
    const file = u.pathname.slice(REPO.length);
    st.gets.push(file);
    const nf = { status: 404, headers: { 'x-error-code': 'EntryNotFound' } };
    if (file === 'models/index.json') {
      if (!st.index) return nf;
      const models = st.versions.map((v) => v.entry).sort((a, b) => b.created.localeCompare(a.created));
      return { status: 200, body: { format: 1, updated: '2026-11-26T09:00:00Z', models } };
    }
    const root = st.index ? st.versions.slice().sort((a, b) => b.entry.created.localeCompare(a.entry.created))[0] : ROOT_V;
    const m = /^models\/([^/]+)\/(.+)$/.exec(file);
    const v = m ? st.versions.find((x) => x.entry.id === m[1]) : root;
    const name = m ? m[2] : file;
    if (!v) return nf;
    if (name === 'model.json') return { status: 200, body: JSON.stringify(v.manifest) };
    if (name === 'model.bin') return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: v.bin };
    if (name === 'trained_on.json') return { status: 200, body: { lines: v.entry ? v.entry.lines : 90, date: v.entry ? v.entry.created : '2026-11-20' } };
    return nf;
  };
  return st;
}

const dbg = (page) => page.evaluate(() => window.__hw.generate.debug());
const info = (page) => page.textContent('#gi-text');
const ready = (page) => page.waitForSelector('#gen-work:not([hidden])', { timeout: 20000 });
const openMore = async (page) => {
  if (!(await page.isVisible('#gen-style'))) await page.click('#gen-style-btn');
  if (!(await page.isVisible('#gen-more'))) await page.click('#gen-more-btn');
};
const options = (page) => page.$$eval('#gen-model-pick option', (o) => o.map((x) => [x.value, x.textContent]));
const slots = (page) => page.evaluate(async () => {
  const st = window.__hw.store;
  const t = (await st.kvGet('modelSlots', null)) || {};
  const out = {};
  for (const k of ['model', 'model.2', 'model.3', 'model.4']) { const e = await st.kvGet(k, null); out[k] = e ? e.manifest.sha256 : null; }
  return { table: t, out };
});
const binGets = (r, v) => r.gets.filter((f) => f === `${v.entry.path}/model.bin`).length;
const localWhen = (page, iso) => page.evaluate((s) => { const d = new Date(s); return `${d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long' })}, ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr`; }, iso);
const until = (fn, ms = 20000) => L.until(fn, ms, 80);

async function setWriters(page) {
  await page.evaluate(() => window.__hw.store.kvSet('writers', [{ id: 'finn', name: 'Finn' }, { id: 'anna', name: 'Anna' }]));
}

async function main(browser, server) {
  const r = repo();
  const A = await L.newApp(browser, server, { signedIn: true, hf: r.handler, writer: 'Finn' });
  const { page, ctx } = A;
  await setWriters(page);
  await page.click('a[data-route="schreiben"]');
  await ready(page);
  await until(async () => (await dbg(page)).version === V3.entry.id);
  L.check('newest: the current writer\'s newest version is used', (await dbg(page)).sha === V3.manifest.sha256);
  L.check('status line: date and time of the version in use', (await info(page)) === `Modell vom ${await localWhen(page, V3.entry.created)}`, await info(page));
  L.check('newest: the files come from its folder', binGets(r, V3) === 1 && r.gets.includes(`${V3.entry.path}/model.json`) && !r.gets.includes('model.bin'));

  await openMore(page);
  const opts = await options(page);
  L.check('list: "Neuestes" first, then every version, newest first', JSON.stringify(opts.map((o) => o[0])) === JSON.stringify(['newest', V3.entry.id, V2.entry.id, V1.entry.id]), JSON.stringify(opts));
  L.check('list: date, time, lines and note', /^26\. Nov\. 2026, \d\d:48 · 143 Zeilen · mit neuen Zeilen$/.test(opts[1][1]), opts[1][1]);
  L.check('list: another writer is named', / · 40 Zeilen · Probe · Anna$/.test(opts[2][1]) && !/Finn/.test(opts[1][1] + opts[3][1]), opts[2][1]);
  L.check('list: "Neuestes" is selected', (await page.inputValue('#gen-model-pick')) === 'newest');
  const box = await page.$eval('#gen-model-pick', (e) => { const b = e.getBoundingClientRect(); return [b.width, b.height]; });
  L.check('list: at least 48 px to touch', box[0] >= 48 && box[1] >= 48, JSON.stringify(box));
  await L.shot(page, 'models-01-list-tablet');

  // write something, then switch: the text on the sheet stays
  await page.fill('#gen-text', 'Liebe Grüße');
  await page.click('#gen-write');
  await until(async () => { const d = await dbg(page); return d.phase === 'idle' && d.page && d.settled === d.page.strokes.length; }, 90000);
  const before = await dbg(page);
  await page.selectOption('#gen-model-pick', V1.entry.id);
  await until(async () => (await dbg(page)).version === V1.entry.id);
  const after = await dbg(page);
  L.check('switch: downloaded once, in use', binGets(r, V1) === 1 && after.sha === V1.manifest.sha256);
  L.check('switch: the sheet keeps its text until written again', after.runs === before.runs && after.page && after.page.strokes.length === before.page.strokes.length);
  L.check('switch: the status line says which model is in use', (await info(page)) === `Jetzt in Gebrauch: Modell vom ${await localWhen(page, V1.entry.created)}`, await info(page));

  // remembered across a reload, from the cache
  await page.reload(); await page.waitForFunction(() => window.__hwReady);
  await ready(page);
  await until(async () => (await dbg(page)).version === V1.entry.id && (await dbg(page)).models.length === 3);
  L.check('remembered: the chosen version after reopening, not downloaded again', (await dbg(page)).choice === V1.entry.id && binGets(r, V1) === 1);
  await openMore(page);
  L.check('remembered: the list shows it', (await page.inputValue('#gen-model-pick')) === V1.entry.id);

  // cache bound: four versions seen, three kept
  await page.selectOption('#gen-model-pick', V2.entry.id);
  await until(async () => (await dbg(page)).version === V2.entry.id);
  r.versions.push(V4);                                     // a new training arrives
  await page.selectOption('#gen-model-pick', 'newest');
  await until(async () => (await dbg(page)).version === V4.entry.id);
  const s = await slots(page);
  const kept = Object.values(s.out).filter(Boolean);
  L.check('cache: at most three versions on the device', Object.keys(s.table).length === 3 && kept.length === 3 && s.out['model.4'] === null, JSON.stringify(s));
  // used in this order: V3, V1 (and again after the reload), V2, V4: V3 is the one not used for longest
  L.check('cache: the least recently used one went', !kept.includes(V3.manifest.sha256) && [V1, V2, V4].every((v) => kept.includes(v.manifest.sha256)), JSON.stringify(kept));
  L.check('newest: follows a new version by itself', (await dbg(page)).sha === V4.manifest.sha256);

  // newest follows without a choice being made
  const V5 = version(5, 'hw-rnn-model-finn-20261126-120000', { writer: 'finn', created: '2026-11-26T12:00:00Z', lines: 160 });
  r.versions.push(V5);
  await page.evaluate(() => window.__hw.generate.refresh());
  await until(async () => (await dbg(page)).version === V5.entry.id);
  L.check('newest: a newer version is loaded at the next look', /^Neues Modell geladen\. Modell vom /.test(await info(page)), await info(page));

  // a chosen version that disappears
  await page.selectOption('#gen-model-pick', V3.entry.id);
  await until(async () => (await dbg(page)).version === V3.entry.id);
  r.versions = r.versions.filter((v) => v !== V3);
  await page.evaluate(() => window.__hw.generate.refresh());
  await until(async () => (await dbg(page)).version === V5.entry.id);
  L.check('gone: falls back to the newest and says so in one sentence', (await info(page)) === `Das gewählte Modell gibt es nicht mehr. Jetzt schreibt das neueste: Modell vom ${await localWhen(page, V5.entry.created)}`, await info(page));
  L.check('gone: the choice is "Neuestes" again, also after reopening', (await dbg(page)).choice === 'newest'
    && (await page.evaluate(async () => (await window.__hw.store.kvGet('modelChoice', null)).id)) === 'newest');
  await L.shot(page, 'models-02-gone');
  const errs = A.errors.filter((e) => !/Failed to load resource|ERR_|net::/.test(e));
  L.check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

async function otherWriterAndOldRepo(browser, server) {
  // Anna writes now: "Neuestes" is her newest, not the newest of all
  const r = repo();
  let A = await L.newApp(browser, server, { signedIn: true, hf: r.handler, writer: 'Anna' });
  await setWriters(A.page);
  await A.page.click('a[data-route="schreiben"]');
  await ready(A.page);
  await until(async () => (await dbg(A.page)).version === V2.entry.id);
  L.check('newest per writer: Anna gets her own newest', (await dbg(A.page)).sha === V2.manifest.sha256);
  await openMore(A.page);
  const opts = await options(A.page);
  L.check('per writer: Finn\'s versions are named, Anna\'s are not', / · Finn$/.test(opts[1][1]) && !/Anna/.test(opts[2][1]), JSON.stringify(opts));
  await A.ctx.close();

  // a writer without any version: the newest of all
  const r2 = repo();
  A = await L.newApp(browser, server, { signedIn: true, hf: r2.handler, writer: 'Ben' });
  await A.page.click('a[data-route="schreiben"]');
  await ready(A.page);
  await until(async () => (await dbg(A.page)).version === V3.entry.id);
  L.check('newest without own versions: the newest of all', true);
  await A.ctx.close();

  // an old repo without models/index.json: the root model, no list
  const r3 = repo({ index: false });
  A = await L.newApp(browser, server, { signedIn: true, hf: r3.handler, hash: '#/schreiben' });
  await ready(A.page);
  await until(async () => (await dbg(A.page)).sha === ROOT_V.manifest.sha256);
  await openMore(A.page);
  L.check('no index: the root model as before, no "Modell" list', !(await A.page.isVisible('#gen-model-row')) && (await info(A.page)) === 'Modell vom 20. November 2026', await info(A.page));
  await A.ctx.close();
}

async function looks(browser, server) {
  for (const [scheme, vp, tag] of [['light', { width: 412, height: 915 }, 'phone'], ['dark', { width: 412, height: 915 }, 'phone-dark'], ['dark', { width: 1280, height: 800 }, 'tablet-dark']]) {
    const r = repo();
    const { page, ctx } = await L.newApp(browser, server, { signedIn: true, hf: r.handler, writer: 'Finn', viewport: vp, colorScheme: scheme, dsf: vp.width < 500 ? 2.625 : 2 });
    await setWriters(page);
    await page.click('a[data-route="schreiben"]');
    await ready(page);
    await until(async () => (await dbg(page)).version === V3.entry.id);
    await openMore(page);
    await page.evaluate(() => document.getElementById('gen-model-row').scrollIntoView({ block: 'center' }));
    const small = await page.evaluate(() => [...document.querySelectorAll('#gen-more button, #gen-more select, #gen-more input')]
      .filter((e) => e.checkVisibility()).map((e) => { const b = e.getBoundingClientRect(); return [e.id || e.className, Math.round(b.width), Math.round(b.height)]; })
      .filter(([, w, h]) => w < 47.5 || h < 47.5));
    L.check(`${tag}: touch targets in "Erweitert" at least 48 px`, small.length === 0, JSON.stringify(small));
    L.check(`${tag}: no horizontal scrolling`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await L.shot(page, `models-10-${tag}`);
    await ctx.close();
  }
}

(async () => {
  const server = await L.start();
  const browser = await L.launch();
  try {
    await main(browser, server);
    await otherWriterAndOldRepo(browser, server);
    await looks(browser, server);
  } catch (e) {
    console.error(e); L.check('test ran without exception', false, String(e && e.stack || e));
  } finally {
    await browser.close(); await server.close();
  }
  process.exit(L.summary() ? 0 : 1);
})();
