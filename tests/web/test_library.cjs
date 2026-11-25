// "Meine Zeilen" (#/zeilen) against a stateful fake of a private dataset: commits really
// store files and understand deletedFile, the tree listing pages through them, files can
// be downloaded (only with the token).
//   A  listing merged with local lines, newest first; portions; lazy images; fallbacks
//   B  correct the text of a line that is only in the dataset
//   C  correct a local, verified line (local copy updated, stays verified)
//   D  correct a line that still waits (no commit; it goes up with the new text)
//   G  delete a line that still waits (nothing in the dataset: no commit, tombstone)
//   E  delete a local, verified line: files gone, tombstone, never uploaded again, progress
//   F  delete a line that is only in the dataset: metadata.jsonl rewritten without its row
//   H  failures (offline, 5xx, network, 401, failed listing) change nothing
//   I  a failed listing keeps the lines on the screen
//   M  an upload that waited for the lock does not bring a deleted line back
//   J  another writer's files and other sessions are never touched
//   K  touch targets, L screenshots (phone and tablet, light and dark)
const crypto = require('crypto');
const L = require('./lib.cjs');

const REPO = `${L.FAKE_USER}/handwriting-fable`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- fake dataset ----------
function fakeHub() {
  const hub = {
    files: new Map(),     // path -> {content, encoding}
    log: [],              // commits: {kind, summary, adds, dels, status}
    reqs: [],             // every request: {method, path, auth}
    pageSize: 100,
    uploadMode: 'ok',     // "Erfassung" commits: ok | 500
    libMode: 'ok',        // library commits: ok | 500 | network | 401
    treeMode: 'ok',       // ok | 500 | network
    treeDelay: 0,
    tokenValid: true,
  };
  const api = `/api/datasets/${REPO}`;
  const resolve = `/datasets/${REPO}/resolve/main/`;
  hub.handler = async (req) => {
    const u = new URL(req.url);
    const auth = req.headers.authorization || '';
    hub.reqs.push({ method: req.method, path: decodeURIComponent(u.pathname), auth });
    const authed = auth === `Bearer ${L.FAKE_TOKEN}` && hub.tokenValid;
    if (u.pathname === '/api/whoami-v2') return authed ? { status: 200, body: { name: L.FAKE_USER } } : { status: 401 };
    // A private dataset: without the token it does not exist.
    if (!authed) return { status: 401, headers: { 'x-error-message': 'Invalid credentials' } };
    if (u.pathname.startsWith(`${api}/tree/main/`)) {
      const prefix = decodeURIComponent(u.pathname.slice(`${api}/tree/main/`.length)).replace(/\/$/, '');
      if (hub.treeDelay) await sleep(hub.treeDelay);
      if (hub.treeMode === '500') return { status: 500 };
      if (hub.treeMode === 'network') return 'abort';
      const all = [...hub.files.keys()].filter((p) => p.startsWith(`${prefix}/`)).sort();
      if (!all.length) return { status: 404, headers: { 'x-error-code': 'EntryNotFound' } };
      const cursor = Number(u.searchParams.get('cursor') || 0);
      const page = all.slice(cursor, cursor + hub.pageSize).map((p) => ({ type: 'file', path: p, size: 1 }));
      const next = cursor + hub.pageSize < all.length
        ? { link: `<https://huggingface.co${u.pathname}?recursive=true&expand=false&cursor=${cursor + hub.pageSize}>; rel="next"` } : {};
      return { status: 200, headers: next, body: page };
    }
    if (u.pathname.startsWith(resolve)) {
      const p = decodeURIComponent(u.pathname.slice(resolve.length));
      const f = hub.files.get(p);
      if (!f) return { status: 404, headers: { 'x-error-code': 'EntryNotFound' } };
      return f.encoding === 'base64'
        ? { status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from(f.content, 'base64') }
        : { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: f.content };
    }
    if (u.pathname === `${api}/commit/main`) {
      const nd = req.body.split('\n').map((l) => JSON.parse(l));
      const summary = nd[0].value.summary;
      const adds = nd.filter((x) => x.key === 'file').map((x) => x.value);
      const dels = nd.filter((x) => x.key === 'deletedFile').map((x) => x.value.path);
      const unknown = nd.slice(1).filter((x) => !['file', 'deletedFile'].includes(x.key));
      const kind = summary.startsWith('Erfassung') ? 'upload' : summary.startsWith('Vorschau') ? 'preview' : 'library';
      const entry = { kind, summary, adds, dels, paths: adds.map((f) => f.path).concat(dels) };
      hub.log.push(entry);
      const mode = kind === 'upload' ? hub.uploadMode : kind === 'library' ? hub.libMode : 'ok';
      if (unknown.length) { entry.status = 400; return { status: 400 }; }
      if (mode === '500') { entry.status = 500; return { status: 500 }; }
      if (mode === 'network') { entry.status = 0; return 'abort'; }
      if (mode === '401') { entry.status = 401; return { status: 401 }; }
      // Like the Hub (presumably): deleting a file that is not there fails the whole commit.
      if (dels.some((p) => !hub.files.has(p))) { entry.status = 404; return { status: 404, headers: { 'x-error-code': 'EntryNotFound' } }; }
      for (const f of adds) hub.files.set(f.path, { content: f.content, encoding: f.encoding });
      for (const p of dels) hub.files.delete(p);
      entry.status = 200;
      return { status: 200, body: { success: true, commitOid: 'b'.repeat(40) } };
    }
    return null;
  };
  hub.snapshot = (filter = () => true) => new Map([...hub.files].filter(([p]) => filter(p)).map(([p, f]) => [p, f.content]));
  hub.libCommits = () => hub.log.filter((c) => c.kind === 'library');
  return hub;
}

const sameMap = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

// ---------- synthetic records: a few looped "words" ----------
let clock = Date.parse('2026-10-01T08:00:00.000Z');
function record({ writer = 'finn', name = 'Finn', session, prompt, text }) {
  clock += 61000;
  const words = text.split(/\s+/).slice(0, 7);
  const strokes = [];
  let x = 40; let t = 0;
  for (const w of words) {
    const xs = []; const ys = []; const ts = []; const ps = [];
    const steps = Math.max(1, w.length) * 8;
    for (let i = 0; i <= steps; i++) {
      const a = (i / 8) * Math.PI * 2;
      xs.push(x + (i / 8) * 11 + Math.sin(a) * 3.5); ys.push(200 - (1 - Math.cos(a)) * 5 * (/[A-ZÄÖÜbdfhklt]/.test(w[Math.floor(i / 8)] || '') ? 2 : 1));
      ts.push(t); ps.push(0.4); t += 2.0833;
    }
    strokes.push({ x: xs, y: ys, t: ts, p: ps, tiltX: xs.map(() => 0), tiltY: xs.map(() => 20), buttons: 1, end: 'up', up: null });
    x += w.length * 11 + 12; t += 120;
  }
  return {
    schema: 'hwline/v1', id: crypto.randomUUID(), session_id: session, seq: 0,
    writer_id: writer, writer_name: name, created_at: new Date(clock).toISOString(), tz_offset_min: 60,
    app: { name: 'handwriting-capture', version: 'test' },
    prompt: { id: prompt, set: 'de-core@2', text, lang: 'de' }, text, status: 'accepted',
    attempt: 1, edits: { undo: 0, clear: 0 }, flags: [],
    time: { unit: 'ms', base: 'first_pen_down', t0_epoch_ms: clock, source: 'event.timeStamp', resolution_ms: 0.1 },
    coord: { unit: 'css_px', origin: 'canvas_top_left', y_down: true, canvas_css: [1200, 400], canvas_px: [2400, 800], dpr: 2 },
    guides: { baseline_y: 200, pen: 'fineliner', paper: 'linie' },
    screen: {}, device: { ua: 'test' },
    pointer: { type: 'pen', api: 'pointerrawupdate', pen_only: true, rate_hz: 480 },
    strokes, anomalies: {},
  };
}
const rawPath = (r) => `raw/v1/${r.writer_id}/${r.session_id}/${r.prompt.id}__${r.id}.json`;
const pngPath = (r) => `preview/${r.writer_id}/${r.session_id}/${r.prompt.id}__${r.id}.png`;
const metaPath = (r) => `preview/${r.writer_id}/${r.session_id}/metadata.jsonl`;

/** Put records into the fake dataset, with preview PNGs and metadata.jsonl made by the app's own code. */
async function seed(page, hub, recs, { previews = true } = {}) {
  for (const r of recs) hub.files.set(rawPath(r), { content: JSON.stringify(r), encoding: 'utf-8' });
  if (!previews) return;
  const out = await page.evaluate(async (rs) => {
    const pv = await import('./js/preview.js');
    const pngs = [];
    for (const r of rs) pngs.push(pv.base64(await pv.renderPng(r)));
    const by = {};
    for (const r of rs) (by[`${r.writer_id}/${r.session_id}`] = by[`${r.writer_id}/${r.session_id}`] || []).push(r);
    const metas = Object.entries(by).map(([k, list]) => [`preview/${k}/metadata.jsonl`, pv.metadataJsonl(list)]);
    return { pngs, metas };
  }, recs);
  recs.forEach((r, i) => hub.files.set(pngPath(r), { content: out.pngs[i], encoding: 'base64' }));
  for (const [p, text] of out.metas) {
    const old = hub.files.get(p);
    hub.files.set(p, { content: (old ? old.content : '') + text, encoding: 'utf-8' });
  }
}

const put = (page, recs) => page.evaluate(async (rs) => { for (const r of rs) await window.__hw.store.putLine(r); }, recs);
const entry = (page, id) => page.evaluate((i) => window.__hw.store.getLine(i), id);
const COUNT_DELETES = () => {
  window.__idbDeletes = 0;
  for (const m of ['delete', 'clear']) {
    const orig = IDBObjectStore.prototype[m];
    IDBObjectStore.prototype[m] = function (...a) { window.__idbDeletes++; return orig.apply(this, a); };
  }
};

async function openLibrary(page) {
  await page.evaluate(() => { location.hash = '#/zeilen'; });
  await page.waitForSelector('#v-zeilen:not([hidden])');
  await L.until(() => page.evaluate(() => window.__hw.library.remoteState !== 'loading'), 20000);
}
async function leaveAndOpen(page) {
  await page.evaluate(() => { location.hash = '#/einstellungen'; });
  await page.waitForSelector('#v-einstellungen:not([hidden])');
  await openLibrary(page);
}
const items = (page) => page.evaluate(() => window.__hw.library.items.map((x) => ({ id: x.id, text: x.text, date: x.date, state: x.state, promptId: x.promptId, remote: x.remote, edited: x.edited })));

/** Open a line's dialog, scrolling its row into view (rendering more portions if needed). */
async function openRow(page, id) {
  await page.evaluate(() => { document.getElementById('toast').hidden = true; });   // so the next toast is a new one
  for (let i = 0; i < 40 && !(await page.$(`li[data-id="${id}"]`)); i++) {
    await page.click('#lib-more');
    await page.waitForTimeout(30);
  }
  await page.$eval(`li[data-id="${id}"]`, (el) => el.scrollIntoView({ block: 'center' }));
  await page.click(`li[data-id="${id}"] .lib-item`);
  await page.waitForSelector('#dlg-line[open]');
}
async function waitToast(page, text) {
  await L.until(() => page.evaluate((t) => !document.getElementById('toast').hidden && document.getElementById('toast').textContent === t, text), 10000);
}
async function closeDialog(page) {
  if (await page.$('#dlg-line[open]')) await page.click('#ld-close');
  await page.waitForSelector('#dlg-line:not([open])', { state: 'attached' });
}

/** Every visible button/link inside sel is at least 48 x 48 CSS px. */
async function smallTargets(page, sel) {
  return page.evaluate((s) => [...document.querySelectorAll(`${s} button, ${s} a`)].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && (r.width < 48 || r.height < 48);
  }).map((el) => `${el.id || el.className || el.textContent.trim()} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`), sel);
}

(async () => {
  const server = await L.start();
  const browser = await L.launch();
  try {
    const hub = fakeHub();
    hub.uploadMode = '500';   // the waiting lines stay waiting until the test lets them go
    const { page, ctx, errors } = await L.newApp(browser, server, { signedIn: true, hf: hub.handler, writer: 'Finn', init: COUNT_DELETES, viewport: { width: 1280, height: 800 } });
    const prompts = await page.evaluate(() => window.__hw.app.prompts.prompts.map((p) => ({ id: p.id, text: p.text })));
    const P = (i) => prompts[i - 1];

    // ---- the dataset: 500 lines in 25 sessions with previews, 12 without, another writer
    const remoteRecs = [];
    for (let s = 1; s <= 25; s++) for (let k = 1; k <= 20; k++) {
      const n = (s - 1) * 20 + k;
      remoteRecs.push(record({ session: `s${String(s).padStart(2, '0')}`, prompt: P(n).id, text: P(n).text }));
    }
    const noPreview = [];
    for (let n = 501; n <= 512; n++) noPreview.push(record({ session: 'np', prompt: P(n).id, text: P(n).text }));
    const lv = record({ session: 'lv', prompt: P(513).id, text: P(513).text });            // here and there, verified
    const q1 = record({ session: 'lq', prompt: P(514).id, text: P(514).text });            // waiting
    const q2 = record({ session: 'lq', prompt: P(515).id, text: P(515).text });            // waiting
    const lena = [];
    for (let k = 1; k <= 20; k++) lena.push(record({ writer: 'lena', name: 'Lena', session: 'ls1', prompt: P(k).id, text: P(k).text }));
    const lenaLocal = record({ writer: 'lena', name: 'Lena', session: 'ls2', prompt: P(30).id, text: P(30).text });
    await seed(page, hub, remoteRecs);
    await seed(page, hub, noPreview, { previews: false });
    await seed(page, hub, [lv]);
    await seed(page, hub, lena);
    await put(page, [lv, q1, q2, lenaLocal]);
    await page.evaluate(async (id) => {
      const s = window.__hw.store;
      await s.markSent([id], 'testwriter'); await s.markVerified([id]); await s.markPreviewed([id]);
    }, lv.id);
    const isLena1 = (p) => p.includes('/lena/ls1/');
    const lenaBefore = hub.snapshot(isLena1);
    // Start the app again, as the writer would: the progress comes from the local lines and one listing.
    await page.reload();
    await page.waitForFunction(() => window.__hwReady).then(() => page.evaluate(() => window.__hwReady));
    await page.evaluate(() => window.__hw.outbox.verify('manual'));

    // ================= A: listing, portions, lazy images =================
    await page.waitForSelector('#cap-total');
    const capBefore = await page.textContent('#cap-total');
    L.check('A: capture screen says how many lines were written, as a link to Meine Zeilen',
      capBefore === '515 Zeilen geschrieben' && (await page.getAttribute('#cap-total', 'href')) === '#/zeilen', capBefore);
    const t0 = Date.now();
    await page.click('#cap-total');
    await page.waitForSelector('#v-zeilen:not([hidden])');
    await L.until(() => page.evaluate(() => window.__hw.library.remoteState === 'ok'), 20000);
    const loadMs = Date.now() - t0;
    const all = await items(page);
    L.check('A: every line of this writer: 500 + 12 in the dataset, 1 in both, 2 waiting', all.length === 515, String(all.length));
    L.check('A: no line of another writer', !all.some((x) => lena.concat([lenaLocal]).some((r) => r.id === x.id)));
    const dates = all.map((x) => x.date);
    L.check('A: newest first, every line has a date', dates.every(Boolean) && dates.every((d, i) => i === 0 || dates[i - 1] >= d), dates.slice(0, 4).join());
    L.check('A: the waiting lines come first (newest) and are marked', all[0].id === q2.id && all[1].id === q1.id && all[0].state === 'queued'
      && (await page.textContent(`li[data-id="${q2.id}"] .lib-meta`)).includes('wartet aufs Hochladen'));
    L.check('A: count at the top', (await page.textContent('#lib-count')) === '515 Zeilen, davon 2 warten aufs Hochladen', await page.textContent('#lib-count'));
    L.check('A: texts from metadata.jsonl for lines that are not on this device', all.find((x) => x.id === remoteRecs[100].id).text === remoteRecs[100].text);
    L.check('A: lines without preview get text and date from their raw record', all.filter((x) => noPreview.some((r) => r.id === x.id)).every((x) => x.text && x.date));
    L.check(`A: list ready in reasonable time with 515 lines (${loadMs} ms)`, loadMs < 15000, String(loadMs));
    const rows0 = await page.$$eval('#lib-list > li', (l) => l.length);
    L.check('A: only one portion is rendered at first (30 rows)', rows0 === 30, String(rows0));
    await page.waitForTimeout(600);
    const pngReqs = () => hub.reqs.filter((r) => r.path.includes('/resolve/') && r.path.endsWith('.png')).length;
    const n0 = pngReqs();
    L.check('A: images are loaded lazily (only those near the screen)', n0 <= 20, String(n0));
    // scroll down: the next portion appears by itself, its images load
    await page.evaluate(() => { const v = document.getElementById('v-zeilen'); v.scrollTop = v.scrollHeight; });
    await L.until(() => page.evaluate(() => document.querySelectorAll('#lib-list > li').length >= 60), 5000).catch(() => {});
    const rows1 = await page.$$eval('#lib-list > li', (l) => l.length);
    L.check('A: scrolling to the end shows the next portion', rows1 >= 60 && rows1 < 515, String(rows1));
    await page.waitForTimeout(500);
    L.check('A: images of the new rows load when they come into view', pngReqs() > n0, `${n0} -> ${pngReqs()}`);
    await page.$eval(`li[data-id="${remoteRecs[499].id}"]`, (el) => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(500);
    L.check('A: preview PNGs are used where they exist', hub.reqs.some((r) => r.path.endsWith(`${remoteRecs[499].id}.png`)));
    const imgsOk = await page.evaluate((ids) => ids.map((id) => { const i = document.querySelector(`li[data-id="${id}"] img`); return !!(i && !i.hidden && i.src.startsWith('blob:') && i.naturalWidth > 0); }), [q2.id, noPreview[11].id, remoteRecs[499].id]);
    L.check('A: a waiting line is drawn from the local record, a line without preview from its raw JSON, others from the PNG', imgsOk.every(Boolean), JSON.stringify(imgsOk));
    L.check('A: no PNG requested for a line without preview', !hub.reqs.some((r) => r.path.includes(noPreview[11].id) && r.path.endsWith('.png')));
    await page.click('#lib-more');
    L.check('A: "Weitere Zeilen zeigen" adds one more portion', (await page.$$eval('#lib-list > li', (l) => l.length)) === rows1 + 30);
    L.check('A: every request carries the token (private dataset)', hub.reqs.every((r) => r.auth === `Bearer ${L.FAKE_TOKEN}`), hub.reqs.filter((r) => !r.auth).map((r) => r.path).join());
    L.check('A: opening the screen commits nothing', hub.libCommits().length === 0);

    // ================= B: correct a line that is only in the dataset =================
    const rb = remoteRecs[499];   // s25, prompt 500
    const metaB0 = hub.files.get(metaPath(rb)).content;
    const pngB0 = hub.files.get(pngPath(rb)).content;
    const othersB = hub.snapshot((p) => p !== rawPath(rb) && p !== metaPath(rb));
    await page.evaluate(() => { document.getElementById('v-zeilen').scrollTop = 0; });
    await openRow(page, rb.id);
    await L.until(() => page.evaluate(() => document.getElementById('ld-prompt').textContent !== ''));
    L.check('B: the dialog shows the prompt and the text in a field', (await page.textContent('#ld-prompt')) === rb.prompt.text && (await page.inputValue('#ld-text')) === rb.text);
    await page.waitForFunction(() => { const i = document.getElementById('ld-img'); return !i.hidden && i.naturalWidth > 0; });
    const fixed = rb.text.replace(/[.!?]$/, '') + ' (korrigiert)';
    await page.fill('#ld-text', fixed);
    await page.click('#ld-save');
    await waitToast(page, 'Text gespeichert.');
    const cB = hub.libCommits();
    L.check('B: one commit with the raw JSON and the session\'s metadata.jsonl', cB.length === 1 && cB[0].status === 200
      && JSON.stringify(cB[0].adds.map((f) => f.path).sort()) === JSON.stringify([metaPath(rb), rawPath(rb)].sort()) && cB[0].dels.length === 0, JSON.stringify(cB.map((c) => c.paths)));
    const recB = JSON.parse(hub.files.get(rawPath(rb)).content);
    L.check('B: text changed, prompt text kept, edit recorded', recB.text === fixed && recB.prompt.text === rb.prompt.text
      && recB.text_edit && recB.text_edit.original === rb.text && recB.text_edit.count === 1 && !Number.isNaN(Date.parse(recB.text_edit.at)), JSON.stringify(recB.text_edit));
    L.check('B: strokes and everything else unchanged', JSON.stringify(Object.assign({}, recB, { text: rb.text, text_edit: undefined })) === JSON.stringify(Object.assign({}, rb, { text_edit: undefined })));
    L.check('B: the record is schema-valid', L.schemaErrors(recB).length === 0, L.schemaErrors(recB).join());
    L.check('B: and valid for hwline.js', (await page.evaluate(async (r) => (await import('./js/capture/hwline.js')).validate(r), recB)).length === 0);
    const metaB1 = hub.files.get(metaPath(rb)).content;
    const l0 = metaB0.split('\n'); const l1 = metaB1.split('\n');
    const changedRows = l0.map((l, i) => (l === l1[i] ? null : i)).filter((i) => i !== null);
    L.check('B: metadata.jsonl: exactly that row changed (text), the others byte-identical', l0.length === l1.length && changedRows.length === 1
      && JSON.parse(l1[changedRows[0]]).text === fixed && JSON.parse(l1[changedRows[0]]).file_name === `${rb.prompt.id}__${rb.id}.png`, JSON.stringify(changedRows));
    L.check('B: the preview image is unchanged, nothing else touched', hub.files.get(pngPath(rb)).content === pngB0 && sameMap(othersB, hub.snapshot((p) => p !== rawPath(rb) && p !== metaPath(rb))));
    L.check('B: the list shows the new text and that it was corrected', (await page.textContent(`li[data-id="${rb.id}"] .lib-text`)) === fixed
      && (await page.textContent(`li[data-id="${rb.id}"] .lib-meta`)).includes('Text korrigiert'));
    L.check('B: no local copy was made of a line that is not on this device', (await entry(page, rb.id)) === null);

    // ================= C: correct a local, verified line =================
    await openRow(page, lv.id);
    await page.fill('#ld-text', 'Anders geschrieben als gedacht');
    await page.click('#ld-save');
    await waitToast(page, 'Text gespeichert.');
    await openRow(page, lv.id);
    await page.fill('#ld-text', 'Anders geschrieben als gedacht.');
    await page.click('#ld-save');
    await waitToast(page, 'Text gespeichert.');
    const eC = await entry(page, lv.id);
    const recC = JSON.parse(hub.files.get(rawPath(lv)).content);
    L.check('C: dataset and local copy are the same corrected record', recC.text === 'Anders geschrieben als gedacht.' && JSON.stringify(eC.record) === JSON.stringify(recC));
    L.check('C: a second correction counts up and keeps the original', recC.text_edit.count === 2 && recC.text_edit.original === lv.text && recC.prompt.text === lv.prompt.text);
    L.check('C: the local line stays verified', eC.state === 'verified');
    const rowC = JSON.parse(hub.files.get(metaPath(lv)).content.trim());
    L.check('C: its metadata row has the new text', rowC.text === recC.text);
    L.check('C: two commits, each with 2 files of that session only', hub.libCommits().slice(1).every((c) => c.adds.length === 2 && c.paths.every((p) => p.includes('/finn/lv/'))));

    // ================= D: correct a waiting line =================
    const nCommits = hub.log.length;
    await openRow(page, q2.id);
    await page.fill('#ld-text', 'Geändert, bevor er hochgeladen wurde');
    await page.click('#ld-save');
    await waitToast(page, 'Text gespeichert.');
    const eD = await entry(page, q2.id);
    L.check('D: a waiting line is corrected on the device only (no commit)', hub.log.length === nCommits && eD.state === 'queued' && eD.record.text === 'Geändert, bevor er hochgeladen wurde' && eD.record.text_edit.original === q2.text);

    // ================= G: delete a waiting line (not in the dataset) =================
    await openRow(page, q1.id);
    await page.click('#ld-delete');
    L.check('G: delete asks first, in plain words', !(await page.isHidden('#ld-confirm'))
      && (await page.textContent('#ld-confirm')).includes('Sie wird aus dem Datensatz entfernt und nicht mehr fürs Lernen verwendet. Der Satz kommt wieder dran, damit du ihn neu schreiben kannst.'));
    await page.click('#ld-keep');
    L.check('G: "Behalten" goes back without changing anything', !(await page.isHidden('#ld-edit')) && (await entry(page, q1.id)).state === 'queued');
    await page.click('#ld-delete');
    await page.click('#ld-really');
    await waitToast(page, 'Zeile gelöscht.');
    const eG = await entry(page, q1.id);
    L.check('G: a line the dataset does not have: no commit, a tombstone, the record kept', hub.libCommits().length === 3 && eG.state === 'deleted' && eG.record.id === q1.id && eG.deleted && eG.deleted.from_state === 'queued');
    L.check('G: looked at the session folders before deciding', hub.reqs.some((r) => r.path.endsWith('/tree/main/raw/v1/finn/lq')));

    // ================= E: delete a local, verified line =================
    await openRow(page, lv.id);
    await page.click('#ld-delete');
    await page.click('#ld-really');
    await waitToast(page, 'Zeile gelöscht.');
    const cE = hub.libCommits().slice(-1)[0];
    L.check('E: one commit deleting the raw file, the PNG and (last row) metadata.jsonl', cE.status === 200
      && JSON.stringify(cE.dels.slice().sort()) === JSON.stringify([metaPath(lv), pngPath(lv), rawPath(lv)].sort()) && cE.adds.length === 0, JSON.stringify(cE.paths));
    L.check('E: the files are gone from the dataset', !hub.files.has(rawPath(lv)) && !hub.files.has(pngPath(lv)));
    const eE = await entry(page, lv.id);
    L.check('E: on the device: a tombstone with the record', eE.state === 'deleted' && eE.record.id === lv.id && eE.deleted.from_state === 'verified');
    L.check('E: gone from the list', !(await items(page)).some((x) => x.id === lv.id) && !(await page.$(`li[data-id="${lv.id}"]`)));

    // ================= F: delete a line that is only in the dataset =================
    const rf = remoteRecs[480];   // s25, prompt 481
    const metaF0 = hub.files.get(metaPath(rf)).content;
    const othersF = hub.snapshot((p) => ![rawPath(rf), pngPath(rf), metaPath(rf)].includes(p));
    await openRow(page, rf.id);
    await page.click('#ld-delete');
    await page.click('#ld-really');
    await waitToast(page, 'Zeile gelöscht.');
    const cF = hub.libCommits().slice(-1)[0];
    L.check('F: one commit: raw + PNG deleted, metadata.jsonl rewritten', JSON.stringify(cF.dels.slice().sort()) === JSON.stringify([pngPath(rf), rawPath(rf)].sort())
      && cF.adds.length === 1 && cF.adds[0].path === metaPath(rf), JSON.stringify(cF.paths));
    const metaF1 = hub.files.get(metaPath(rf)).content;
    const kept = metaF0.split('\n').filter((l) => l && !l.includes(rf.id));
    L.check('F: metadata.jsonl without that row, the other 19 rows byte-identical', metaF1 === kept.map((l) => `${l}\n`).join('') && kept.length === 19);
    L.check('F: nothing else in the dataset changed', sameMap(othersF, hub.snapshot((p) => ![rawPath(rf), pngPath(rf), metaPath(rf)].includes(p))));
    L.check('F: no local entry is made for it', (await entry(page, rf.id)) === null);
    L.check('F: count says 512 now', (await page.textContent('#lib-count')) === '512 Zeilen, davon 1 wartet aufs Hochladen', await page.textContent('#lib-count'));

    // ---- progress, counts, verify(), uploads ----
    await page.evaluate(() => window.__hw.outbox.verify('manual'));
    const prog = await page.evaluate(async () => {
      const a = window.__hw.app;
      const { nextPrompt } = await import('./js/prompts.js');
      const done = new Set([...a.localDone, ...a.remoteDone]);
      return { local: [...a.localDone], remote: a.remoteDone.size, next: nextPrompt(a.prompts.prompts, done, a.skipped).id, done: [...done] };
    });
    L.check('E/F/G: deleted prompts do not count as written', !prog.done.includes(P(513).id) && !prog.done.includes(P(514).id) && !prog.done.includes(P(481).id) && prog.done.includes(P(515).id), prog.local.join());
    L.check('E/F/G: the first deleted prompt is offered again', prog.next === P(481).id, prog.next);
    await page.evaluate(() => { location.hash = '#/erfassen'; });
    await page.waitForSelector('#cap[data-state="write"]');
    L.check('E: "N Zeilen geschrieben" counts 3 fewer', (await page.textContent('#cap-total')) === '512 Zeilen geschrieben', await page.textContent('#cap-total'));
    const cnt = await page.evaluate(() => window.__hw.store.counts());
    L.check('E: counts: deleted lines are not in the total, not waiting, not safe', cnt.total === 2 && cnt.deleted === 2 && cnt.queued === 2 && cnt.verified === 0, JSON.stringify(cnt));
    // Now let uploads through: the waiting lines go up, the deleted ones never.
    hub.uploadMode = 'ok';
    await page.evaluate(() => window.__hw.outbox.flush('manual'));
    await L.until(async () => (await entry(page, q2.id)).state !== 'queued', 10000);
    await page.evaluate(() => window.__hw.outbox.verify('manual'));
    await page.evaluate(() => window.__hw.outbox.checkNow());
    await page.waitForTimeout(300);
    const uploaded = hub.log.filter((c) => c.kind === 'upload' && c.status === 200).flatMap((c) => c.paths);
    L.check('E: verify() and flush() never upload a deleted line again', !uploaded.includes(rawPath(lv)) && !uploaded.includes(rawPath(q1)) && !hub.files.has(rawPath(lv)) && !hub.files.has(rawPath(q1)), uploaded.join());
    L.check('D: the corrected waiting line went up with its new text', JSON.parse(hub.files.get(rawPath(q2)).content).text === 'Geändert, bevor er hochgeladen wurde');
    const previewed = hub.log.filter((c) => c.kind === 'preview').flatMap((c) => c.paths);
    L.check('E: no preview is written for a deleted line', !previewed.some((p) => p.includes(lv.id) || p.includes(q1.id)));
    L.check('E: tombstones stay tombstones after verify', (await entry(page, lv.id)).state === 'deleted' && (await entry(page, q1.id)).state === 'deleted');
    await page.evaluate(() => { location.hash = '#/einstellungen'; });
    await page.waitForSelector('#v-einstellungen:not([hidden])');
    await page.evaluate(() => window.__hw.updateStatus());
    await page.waitForTimeout(150);
    const safeMain = await page.textContent('#safe-main');
    L.check('E: status texts count only the lines that are not deleted', safeMain === 'Alle 2 Zeilen sind sicher gespeichert.', safeMain);
    const backup = await page.evaluate(() => window.__hw.store.backupJsonl());
    L.check('E: the backup leaves deleted lines out', !backup.includes(lv.id) && !backup.includes(q1.id) && backup.includes(q2.id));
    L.check('Settings: a way to Meine Zeilen', (await page.getAttribute('#open-lines', 'href')) === '#/zeilen');

    // ================= H: failures change nothing =================
    await openLibrary(page);
    const rh = remoteRecs[470];
    const tryAction = async (label, action, setup, undo, errSel, want) => {
      const before = hub.snapshot();
      const local = JSON.stringify(await page.evaluate(() => window.__hw.store.allLines()));
      await setup();
      await openRow(page, rh.id);
      if (action === 'save') { await page.fill('#ld-text', 'Sollte nicht ankommen'); await page.click('#ld-save'); }
      else { await page.click('#ld-delete'); await page.click('#ld-really'); }
      await page.waitForSelector(`${errSel}:not([hidden])`, { timeout: 10000 });
      const msg = await page.textContent(errSel);
      await undo();
      const same = sameMap(before, hub.snapshot()) && local === JSON.stringify(await page.evaluate(() => window.__hw.store.allLines()));
      L.check(`H: ${label}: nothing changed, calm message`, same && msg.includes(want) && msg.includes('nichts geändert'), msg);
      L.check(`H: ${label}: the line is still listed, the dialog stays open`, (await items(page)).some((x) => x.id === rh.id) && !!(await page.$('#dlg-line[open]')));
      await closeDialog(page);
    };
    const noop = async () => {};
    for (const action of ['save', 'delete']) {
      const errSel = action === 'save' ? '#ld-err' : '#ld-cerr';
      await tryAction(`${action} offline`, action, () => ctx.setOffline(true), () => ctx.setOffline(false), errSel, 'Keine Verbindung');
      await tryAction(`${action} 500`, action, async () => { hub.libMode = '500'; }, async () => { hub.libMode = 'ok'; }, errSel, 'antwortet gerade nicht');
      await tryAction(`${action} network error`, action, async () => { hub.libMode = 'network'; }, async () => { hub.libMode = 'ok'; }, errSel, 'Keine Verbindung');
      await tryAction(`${action} 401 (token no longer valid)`, action, async () => { hub.libMode = '401'; hub.tokenValid = false; }, async () => { hub.libMode = 'ok'; hub.tokenValid = true; }, errSel, 'Anmeldung');
    }
    await tryAction('delete: session listing fails', 'delete', async () => { hub.treeMode = '500'; }, async () => { hub.treeMode = 'ok'; }, '#ld-cerr', 'antwortet gerade nicht');
    L.check('H: still signed in after a failed action', await page.evaluate(() => !!window.__hw.hf.getAuth()));
    await page.evaluate(() => { const t = document.getElementById('toast'); t.hidden = true; });

    // ================= I: a failed listing keeps the lines on screen =================
    const nBefore = (await items(page)).length;
    hub.treeMode = '500';
    await leaveAndOpen(page);
    const failedState = await page.evaluate(() => window.__hw.library.remoteState);
    const nFail = (await items(page)).length;
    L.check('I: listing fails: the same lines are still there (last complete listing)', failedState === 'failed' && nFail === nBefore, `${failedState} ${nFail} vs ${nBefore}`);
    L.check('I: and the screen says so calmly, with "Nochmal laden"', (await page.textContent('#lib-note-text')).includes('konnten gerade nicht geladen werden') && !(await page.isHidden('#lib-reload')));
    hub.treeMode = 'network';
    await page.click('#lib-reload');
    await L.until(() => page.evaluate(() => window.__hw.library.remoteState !== 'loading'));
    L.check('I: a network error on the listing: lines stay too', (await items(page)).length === nBefore && (await page.textContent('#lib-note-text')).startsWith('Keine Verbindung'));
    hub.treeMode = 'ok';
    await page.click('#lib-reload');
    await L.until(() => page.evaluate(() => window.__hw.library.remoteState === 'ok'));
    L.check('I: "Nochmal laden" loads again', (await items(page)).length === nBefore && (await page.isHidden('#lib-note')));

    // ================= M: an upload waiting for the lock cannot bring a deleted line back =================
    const q3 = record({ session: 'lq2', prompt: P(520).id, text: P(520).text });
    hub.uploadMode = '500';
    await put(page, [q3]);
    await leaveAndOpen(page);
    hub.uploadMode = 'ok';
    hub.treeDelay = 700;
    await openRow(page, q3.id);
    await page.click('#ld-delete');
    await page.click('#ld-really');
    await page.waitForTimeout(100);
    await page.evaluate(() => { window.__hw.outbox.flush('manual'); });
    await waitToast(page, 'Zeile gelöscht.');
    hub.treeDelay = 0;
    await page.waitForTimeout(500);
    await page.evaluate(() => window.__hw.outbox.flush('manual'));
    await page.waitForTimeout(300);
    L.check('M: a line deleted while its upload waited is not uploaded', !hub.files.has(rawPath(q3)) && (await entry(page, q3.id)).state === 'deleted');

    // ================= J: other writers and sessions untouched =================
    L.check('J: the other writer\'s files are byte-identical', sameMap(lenaBefore, hub.snapshot(isLena1)));
    const scopes = hub.libCommits().every((c) => { const s = new Set(c.paths.map((p) => p.replace(/^raw\/v1\/|^preview\//, '').split('/').slice(0, 2).join('/'))); return s.size === 1 && !c.paths.some((p) => p.includes('/lena/')); });
    L.check('J: every library commit touches one writer\'s one session only', scopes);
    L.check('J: no commit outside the library deletes anything', hub.log.filter((c) => c.kind !== 'library').every((c) => c.dels.length === 0));
    L.check('J: the other writer\'s local line is untouched', (await entry(page, lenaLocal.id)).state === 'sent' || (await entry(page, lenaLocal.id)).state === 'verified');

    // ================= K: touch targets =================
    await page.evaluate(() => { location.hash = '#/zeilen'; });
    await page.waitForSelector('#v-zeilen:not([hidden])');
    L.check('K: list: every button and link is at least 48x48', (await smallTargets(page, '#v-zeilen')).length === 0, (await smallTargets(page, '#v-zeilen')).join(', '));
    await openRow(page, remoteRecs[10].id);
    L.check('K: dialog: every button is at least 48x48', (await smallTargets(page, '#dlg-line')).length === 0, (await smallTargets(page, '#dlg-line')).join(', '));
    await page.click('#ld-delete');
    L.check('K: confirmation: every button is at least 48x48', (await smallTargets(page, '#dlg-line')).length === 0, (await smallTargets(page, '#dlg-line')).join(', '));
    await page.click('#ld-keep');
    await closeDialog(page);
    await page.evaluate(() => { location.hash = '#/erfassen'; });
    await page.waitForSelector('#cap[data-state="write"]');
    const capBox = await page.$eval('#cap-total', (el) => { const r = el.getBoundingClientRect(); return [r.width, r.height]; });
    L.check('K: "N Zeilen geschrieben" is at least 48x48 to touch', capBox[0] >= 48 && capBox[1] >= 48, capBox.join('x'));
    L.check('no delete() or clear() on IndexedDB', (await page.evaluate(() => window.__idbDeletes)) === 0);
    L.check('no page errors', errors.filter((e) => !/Failed to load resource|ERR_/.test(e)).length === 0, errors.join(' | '));
    await ctx.close();

    // ================= L: screenshots =================
    for (const [tag, viewport, dsf] of [['phone', { width: 412, height: 915 }, 2.625], ['tablet', { width: 1280, height: 800 }, 2]]) {
      for (const colorScheme of ['light', 'dark']) {
        const h2 = fakeHub();
        h2.uploadMode = '500';
        const app2 = await L.newApp(browser, server, { signedIn: true, hf: h2.handler, writer: 'Finn', viewport, dsf, colorScheme });
        const pg = app2.page;
        const recs = [];
        for (let n = 1; n <= 40; n++) recs.push(record({ session: `x${Math.ceil(n / 20)}`, prompt: P(n).id, text: P(n).text }));
        await seed(pg, h2, recs.slice(0, 38));
        await put(pg, recs.slice(38));
        await pg.evaluate(() => window.__hw.outbox.verify('manual'));
        await openLibrary(pg);
        await pg.waitForTimeout(700);
        const name = `library-${tag}-${colorScheme}`;
        await pg.mouse.move(1, viewport.height - 1);
        await L.shot(pg, `${name}-list`);
        const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        L.check(`L ${tag} ${colorScheme}: no horizontal scrolling`, overflow <= 0, String(overflow));
        L.check(`L ${tag} ${colorScheme}: touch targets`, (await smallTargets(pg, '#v-zeilen')).length === 0, (await smallTargets(pg, '#v-zeilen')).join(', '));
        await openRow(pg, recs[35].id);
        await pg.waitForFunction(() => { const i = document.getElementById('ld-img'); return !i.hidden && i.naturalWidth > 0; });
        await pg.waitForTimeout(150);
        await L.shot(pg, `${name}-dialog`);
        await pg.click('#ld-delete');
        await pg.waitForTimeout(100);
        await L.shot(pg, `${name}-confirm`);
        await pg.click('#ld-keep');
        await closeDialog(pg);
        await pg.evaluate(() => { location.hash = '#/erfassen'; });
        await pg.waitForSelector('#cap[data-state="write"]');
        await pg.waitForTimeout(200);
        await L.shot(pg, `${name}-capture-link`);
        await app2.ctx.close();
      }
    }
  } catch (e) {
    console.error(e); L.check('test ran without exception', false, String(e));
  } finally {
    await browser.close(); await server.close();
  }
  process.exit(L.summary() ? 0 : 1);
})();
