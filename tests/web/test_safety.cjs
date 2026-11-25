// Verified storage and the Dataset Viewer preview, against a stateful fake of the
// dataset: commits really store files, the tree listing pages through them.
//   - states queued -> sent -> verified; only a listing makes a line "safe"
//   - reconciliation: a line the server lost is uploaded again; failed listings change nothing
//   - preview: a second commit after the raw one, exact layout and columns, best effort
//   - status texts, "Jetzt prüfen", flush when the page is hidden, nothing ever deleted
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const L = require('./lib.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const PY = path.join(ROOT, 'scripts', 'rebuild_preview.py');
const PY_COLUMNS = JSON.parse(/^COLUMNS = (\[[^\]]*\])/m.exec(fs.readFileSync(PY, 'utf8'))[1].replace(/\s+/g, ' '));
const INT_COLS = ['strokes', 'points'];
const NUM_COLS = ['seconds', 'pen_rate_hz'];

// ---------- fake dataset ----------
function fakeHub() {
  const hub = {
    files: new Map(),        // path -> {content, encoding}
    log: [],                 // every commit in order: {kind: 'raw'|'preview', paths, status}
    tree: [],                // tree request URLs
    pageSize: 2,
    rawMode: 'ok',           // ok | drop (200 but not stored) | 500
    previewMode: 'ok',       // ok | 500 | 413 | network | hang
    treeMode: 'ok',          // ok | 500 | network | page2-500 | garbage | 401repo
  };
  hub.handler = async (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/api/whoami-v2') return { status: 200, body: { name: L.FAKE_USER } };
    if (u.pathname === `/api/datasets/${L.FAKE_USER}/handwriting-fable/tree/main/raw/v1`) {
      hub.tree.push(req.url);
      const cursor = Number(u.searchParams.get('cursor') || 0);
      if (hub.treeMode === '500') return { status: 500 };
      if (hub.treeMode === 'network') return 'abort';
      if (hub.treeMode === '401repo') return { status: 401, headers: { 'x-error-code': 'RepoNotFound' } };
      if (hub.treeMode === 'garbage') return { status: 200, body: '{"error":"x"}' };
      if (hub.treeMode === 'page2-500' && cursor > 0) return { status: 500 };
      const all = [...hub.files.keys()].filter((p) => p.startsWith('raw/v1/')).sort();
      const page = all.slice(cursor, cursor + hub.pageSize).map((p) => ({ type: 'file', path: p, size: 1 }));
      const next = cursor + hub.pageSize < all.length
        ? { link: `<https://huggingface.co${u.pathname}?recursive=true&expand=false&cursor=${cursor + hub.pageSize}>; rel="next"` } : {};
      return { status: 200, headers: next, body: page };
    }
    if (u.pathname === `/api/datasets/${L.FAKE_USER}/handwriting-fable/commit/main`) {
      const nd = req.body.split('\n').map((l) => JSON.parse(l));
      const files = nd.filter((x) => x.key === 'file').map((x) => x.value);
      const kind = files.every((f) => f.path.startsWith('preview/')) ? 'preview' : 'raw';
      const entry = { kind, paths: files.map((f) => f.path), files, summary: nd[0].value.summary };
      hub.log.push(entry);
      const mode = kind === 'raw' ? hub.rawMode : hub.previewMode;
      if (mode === '500') { entry.status = 500; return { status: 500 }; }
      if (mode === '413') { entry.status = 413; return { status: 413, headers: { 'x-error-message': 'Payload too large' } }; }
      if (mode === 'network') { entry.status = 0; return 'abort'; }
      if (mode === 'hang') { entry.status = -1; return new Promise(() => {}); }
      entry.status = 200;
      if (mode !== 'drop') for (const f of files) hub.files.set(f.path, f);
      return { status: 200, body: { success: true, commitOid: 'a'.repeat(40) } };
    }
    return null;
  };
  return hub;
}

// ---------- synthetic records ----------
let clock = Date.parse('2026-11-20T10:00:00.000Z');
function record({ writer = 'finn', name = 'Finn', session, prompt, flags = [], width = 400 }) {
  clock += 61000;
  const n = 60;
  const x = []; const y = []; const t = []; const p = [];
  for (let i = 0; i < n; i++) {
    x.push(100 + (width * i) / (n - 1)); y.push(200 - 40 * Math.abs(Math.sin(i / 5)));
    t.push(i * 2.0833); p.push(0.4);
  }
  const s2 = { x: [100 + width + 20, 100 + width + 30], y: [200, 160], t: [400, 410.5], p: [0.4, 0.4], tiltX: [0, 0], tiltY: [20, 20], buttons: 0, end: 'up', up: null };
  const dot = { x: [100 + width / 2], y: [130], t: [2345.6], p: [0.4], tiltX: [0], tiltY: [20], buttons: 0, end: 'up', up: null };
  return {
    schema: 'hwline/v1', id: crypto.randomUUID(), session_id: session, seq: 0,
    writer_id: writer, writer_name: name, created_at: new Date(clock).toISOString(), tz_offset_min: 60,
    app: { name: 'handwriting-capture', version: 'test' },
    prompt: { id: prompt, set: 'de-core', text: `Satz „${prompt}“ mit Umlauten: äöü ß`, lang: 'de' },
    text: `Satz „${prompt}“ mit Umlauten: äöü ß`, status: flags.length ? 'flagged' : 'accepted',
    attempt: 1, edits: { undo: 0, clear: 0 }, flags,
    time: { unit: 'ms', base: 'first_pen_down', t0_epoch_ms: clock, source: 'event.timeStamp', resolution_ms: 0.1 },
    coord: { unit: 'css_px', origin: 'canvas_top_left', y_down: true, canvas_css: [1200, 400], canvas_px: [2400, 800], dpr: 2 },
    guides: writer === 'finn' ? { baseline_y: 200, pen: 'S Pen' } : null,
    screen: {}, device: { ua: 'test' },
    pointer: { type: 'pen', api: 'pointerrawupdate', pen_only: true, rate_hz: 480.25 },
    strokes: [{ x, y, t, p, tiltX: x.map(() => 0), tiltY: x.map(() => 20), buttons: 0, end: 'up', up: null }, s2, dot],
    anomalies: {},
  };
}

const put = (page, recs) => page.evaluate(async (rs) => { for (const r of rs) await window.__hw.store.putLine(r); }, recs);
const states = (page) => page.evaluate(async () => Object.fromEntries((await window.__hw.store.allLines()).map((e) => [e.id, e.state])));
const entries = (page) => page.evaluate(() => window.__hw.store.allLines());
/** Pretend these lines were sent a while ago (past the grace period of a fresh upload). */
const age = (page, ids, ms = 120000) => page.evaluate(([ids, ms]) => new Promise((resolve, reject) => {
  const r = indexedDB.open('handschrift');
  r.onsuccess = () => {
    const t = r.result.transaction('lines', 'readwrite'); const s = t.objectStore('lines');
    for (const id of ids) {
      const g = s.get(id);
      g.onsuccess = () => { const e = g.result; e.uploaded_at = new Date(Date.now() - ms).toISOString(); s.put(e); };
    }
    t.oncomplete = () => { r.result.close(); resolve(); }; t.onerror = () => reject(t.error);
  };
}), [ids, ms]);

// Counts every delete()/clear() on any object store: the app must never call them.
const COUNT_DELETES = () => {
  window.__idbDeletes = 0;
  for (const m of ['delete', 'clear']) {
    const orig = IDBObjectStore.prototype[m];
    IDBObjectStore.prototype[m] = function (...a) { window.__idbDeletes++; return orig.apply(this, a); };
  }
};

function pngInfo(b64) {
  const b = Buffer.from(b64, 'base64');
  const sig = b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { sig, ihdr: b.slice(12, 16).toString('latin1') === 'IHDR', width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length };
}

/** meta_row() and render() of the Python script for the same records (null if Python is not usable). */
function pythonReference(recs) {
  const code = `
import importlib.util, json, sys, types, io
try:
    import huggingface_hub  # noqa
except Exception:
    m = types.ModuleType('huggingface_hub'); m.CommitOperationAdd = m.HfApi = m.snapshot_download = None
    sys.modules['huggingface_hub'] = m
spec = importlib.util.spec_from_file_location('rp', sys.argv[1]); rp = importlib.util.module_from_spec(spec); spec.loader.exec_module(rp)
out = []
for rec in json.load(sys.stdin):
    name = rec['prompt']['id'] + '__' + rec['id'] + '.png'
    row = rp.meta_row(name, rec)
    png = rp.render([s for s in rec['strokes'] if len(s['x'])])
    out.append({'line': json.dumps({k: row[k] for k in rp.COLUMNS}, ensure_ascii=False), 'w': int.from_bytes(png[16:20], 'big'), 'h': int.from_bytes(png[20:24], 'big')})
print(json.dumps(out))
`;
  const r = spawnSync('python3', ['-c', code, PY], { input: JSON.stringify(recs), encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) { console.log('python reference not available:', (r.stderr || '').split('\n').slice(-3).join(' ')); return null; }
  return JSON.parse(r.stdout);
}

(async () => {
  const server = await L.start();
  const browser = await L.launch();
  try {
    // ================= A: preview after raw, exact layout =================
    {
      const hub = fakeHub();
      const { page, ctx, errors } = await L.newApp(browser, server, { signedIn: true, hf: hub.handler, init: COUNT_DELETES, viewport: { width: 1280, height: 800 } });
      const recs = [
        record({ session: 's1', prompt: 'de-core-0002' }),
        record({ session: 's1', prompt: 'de-core-0001', flags: ['low_rate', 'stray_stroke'] }),
        record({ session: 's2', prompt: 'de-core-0003', writer: 'lena', name: 'Lena', width: 1500 }),
      ];
      recs[2].pointer = { type: 'pen', api: 'pointermove' };   // rate_hz left out: 0.0
      await put(page, recs);
      await page.evaluate(() => window.__hw.outbox.flush('manual'));
      await L.until(async () => (await entries(page)).every((e) => e.preview_at && e.state === 'verified'), 10000);
      const kinds = hub.log.map((c) => c.kind);
      L.check('A: one raw commit, then one separate preview commit', kinds.join() === 'raw,preview', kinds.join());
      const raw = hub.log[0]; const pv = hub.log[1];
      L.check('A: the raw commit holds only raw/v1 files', raw.paths.length === 3 && raw.paths.every((p) => /^raw\/v1\//.test(p)), raw.paths.join());
      const want = recs.map((r) => `preview/${r.writer_id}/${r.session_id}/${r.prompt.id}__${r.id}.png`)
        .concat(['preview/finn/s1/metadata.jsonl', 'preview/lena/s2/metadata.jsonl']).sort();
      L.check('A: preview paths are preview/<writer>/<session>/<prompt>__<id>.png + metadata.jsonl per session', JSON.stringify([...pv.paths].sort()) === JSON.stringify(want), pv.paths.join());
      L.check('A: images go as base64 file entries, metadata as utf-8', pv.files.every((f) => (f.path.endsWith('.png') ? f.encoding === 'base64' : f.encoding === 'utf-8')));
      L.check('A: lines are verified only after the listing saw them', (await entries(page)).every((e) => e.verified_at && e.state === 'verified'));

      // metadata.jsonl
      const meta = pv.files.find((f) => f.path === 'preview/finn/s1/metadata.jsonl').content;
      const lines = meta.split('\n');
      L.check('A: metadata.jsonl has one row per line of the session, newline-terminated', lines.length === 3 && lines[2] === '', JSON.stringify(meta).slice(0, 200));
      const rows = lines.filter(Boolean).map((l) => JSON.parse(l));
      L.check('A: column names and order are exactly COLUMNS of rebuild_preview.py', rows.every((r) => JSON.stringify(Object.keys(r)) === JSON.stringify(PY_COLUMNS)), JSON.stringify(Object.keys(rows[0])));
      const typesOk = (r) => PY_COLUMNS.every((k) => (INT_COLS.includes(k) ? Number.isInteger(r[k]) : NUM_COLS.includes(k) ? typeof r[k] === 'number' : typeof r[k] === 'string'));
      L.check('A: every row has every column with the right type', rows.every(typesOk), JSON.stringify(rows[0]));
      L.check('A: rows sorted by date', rows[0].date < rows[1].date && rows[0].prompt === 'de-core-0002', rows.map((r) => r.date).join());
      const r1 = rows[1];
      L.check('A: row values (file_name, writer, date UTC, prompt, status, notes, counts)',
        r1.file_name === `de-core-0001__${recs[1].id}.png` && r1.writer === 'Finn' && r1.date === recs[1].created_at.slice(0, 19).replace('T', ' ')
        && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(r1.date) && r1.prompt === 'de-core-0001' && r1.status === 'flagged'
        && r1.notes === 'low_rate, stray_stroke' && r1.strokes === 3 && r1.points === 63 && r1.seconds === 2.3 && r1.pen_rate_hz === 480.2
        && r1.pen === 'S Pen' && r1.paper === '' && rows[0].notes === '', JSON.stringify(r1));
      const lenaRow = JSON.parse(pv.files.find((f) => f.path === 'preview/lena/s2/metadata.jsonl').content);
      L.check('A: unknown pen/paper/rate are "" and 0.0, written as a float like Python', lenaRow.pen === '' && lenaRow.paper === '' && lenaRow.pen_rate_hz === 0
        && /"pen_rate_hz": 0\.0,/.test(pv.files.find((f) => f.path === 'preview/lena/s2/metadata.jsonl').content));

      // PNGs
      const pngs = pv.files.filter((f) => f.path.endsWith('.png')).map((f) => Object.assign({ path: f.path }, pngInfo(f.content)));
      L.check('A: PNG signature and IHDR', pngs.every((p) => p.sig && p.ihdr), JSON.stringify(pngs));
      L.check('A: PNG 150 px high, width proportional within 300..2400', pngs.every((p) => p.height === 150 && p.width >= 300 && p.width <= 2400), pngs.map((p) => `${p.width}x${p.height}`).join());
      const finnPng = pngs.find((p) => p.path.includes(recs[0].id)); const lenaPng = pngs.find((p) => p.path.includes(recs[2].id));
      L.check('A: a longer line gives a wider image', lenaPng.width > finnPng.width * 2, `${finnPng.width} vs ${lenaPng.width}`);
      const pix = await page.evaluate(async (b64) => {
        const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        const img = await createImageBitmap(new Blob([u], { type: 'image/png' }));
        const c = new OffscreenCanvas(img.width, img.height); const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, img.width, img.height).data;
        let ink = 0; let white = 0; let minX = 1e9; let maxX = -1;
        for (let i = 0; i < d.length; i += 4) {
          const x = (i / 4) % img.width;
          if (d[i] < 90 && d[i + 2] < 120) { ink++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
          if (d[i] === 255 && d[i + 1] === 255 && d[i + 2] === 255) white++;
        }
        return { ink, white, n: d.length / 4, minX, maxX, w: img.width, corner: [d[0], d[1], d[2], d[3]] };
      }, pv.files.find((f) => f.path.includes(recs[0].id) && f.path.endsWith('.png')).content);
      L.check('A: the image has dark ink pixels on a white background', pix.ink > 200 && pix.white > pix.n * 0.7 && pix.corner.join() === '255,255,255,255', JSON.stringify(pix));
      L.check('A: ink is cropped with padding on both sides', pix.minX > 10 && pix.maxX < pix.w - 10, JSON.stringify(pix));

      // Same as the Python script
      const ref = pythonReference(recs);
      if (ref) {
        const js = recs.map((r) => {
          const f = pv.files.find((x) => x.path === `preview/${r.writer_id}/${r.session_id}/metadata.jsonl`);
          return f.content.split('\n').find((l) => l.includes(r.id));
        });
        L.check('A: metadata lines are byte-identical to rebuild_preview.py meta_row', ref.every((x, i) => x.line === js[i]), `${ref[1].line}\n  js: ${js[1]}`);
        const sz = recs.map((r) => pngs.find((p) => p.path.includes(r.id)));
        L.check('A: image size matches rebuild_preview.py render (+-1 px)', ref.every((x, i) => Math.abs(x.w - sz[i].width) <= 1 && x.h === sz[i].height), JSON.stringify(ref.map((x) => [x.w, x.h])) + ' js ' + JSON.stringify(sz.map((p) => [p.width, p.height])));
      }

      // A second batch in s1: metadata.jsonl rebuilt from all local lines of the session.
      const more = [record({ session: 's1', prompt: 'de-core-0004' })];
      await put(page, more);
      await page.evaluate(() => window.__hw.outbox.flush('manual'));
      await L.until(async () => (await entries(page)).every((e) => e.preview_at && e.state === 'verified'), 10000);
      const pv2 = hub.log[hub.log.length - 1];
      L.check('A: next batch: raw then preview again', hub.log.map((c) => c.kind).join() === 'raw,preview,raw,preview');
      L.check('A: the second preview commit has only the new image + that session\'s metadata', pv2.paths.length === 2 && pv2.paths.includes('preview/finn/s1/metadata.jsonl'));
      const meta2 = pv2.files.find((f) => f.path.endsWith('metadata.jsonl')).content.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      L.check('A: rebuilt metadata.jsonl has all 3 lines of s1', meta2.length === 3 && meta2.map((r) => r.prompt).join() === 'de-core-0002,de-core-0001,de-core-0004', meta2.map((r) => r.prompt).join());
      L.check('A: no delete() or clear() on IndexedDB', (await page.evaluate(() => window.__idbDeletes)) === 0);
      L.check('A: no page errors', errors.filter((e) => !/Failed to load resource|ERR_/.test(e)).length === 0, errors.join(' | '));
      await ctx.close();
    }

    // ================= B: preview fails, raw still counts =================
    {
      const hub = fakeHub();
      const app = await L.newApp(browser, server, { signedIn: true, hf: hub.handler, init: COUNT_DELETES });
      let { page } = app;
      const { ctx } = app;
      for (const mode of ['500', '413', 'network']) {
        hub.previewMode = mode;
        const before = hub.log.length;
        const recs = [record({ session: `b-${mode}`, prompt: 'de-core-0001' }), record({ session: `b-${mode}`, prompt: 'de-core-0002' })];
        await put(page, recs);
        await page.evaluate(() => window.__hw.outbox.flush('manual'));
        await page.evaluate(() => window.__hw.outbox.previews('manual'));   // past the back-off of the round before
        await L.until(async () => hub.log.slice(before).some((c) => c.kind === 'preview') && !(await page.evaluate(() => window.__hw.outbox.status().previewRunning)), 10000);
        await L.until(async () => { const s = await states(page); return recs.every((r) => s[r.id] === 'verified'); }, 10000);
        const es = (await entries(page)).filter((e) => recs.some((r) => r.id === e.id));
        L.check(`B ${mode}: raw lines count as uploaded (verified), none queued again`, es.every((e) => e.state === 'verified' && e.requeues === 0), es.map((e) => e.state).join());
        L.check(`B ${mode}: preview still to do`, es.every((e) => !e.preview_at));
        L.check(`B ${mode}: no raw commit repeated`, hub.log.slice(before).filter((c) => c.kind === 'raw').length === 1, hub.log.slice(before).map((c) => c.kind + c.status).join());
        const st = await page.evaluate(() => window.__hw.outbox.status());
        L.check(`B ${mode}: no upload error for the writer`, !st.lastError && !st.notBefore, JSON.stringify(st.lastError));
        if (mode === '413') {
          const pv = hub.log.slice(before).filter((c) => c.kind === 'preview').map((c) => c.paths.filter((x) => x.endsWith('.png')).length);
          L.check('B 413: a refused preview batch is split down to single lines', pv[0] > 1 && pv.filter((n) => n === 1).length === pv[0], pv.join());
        }
      }
      await page.evaluate(() => { location.hash = '#/einstellungen'; });
      await page.waitForSelector('#v-einstellungen:not([hidden])');
      await page.evaluate(() => window.__hw.updateStatus());
      await page.waitForTimeout(100);
      L.check('B: status shows all 6 lines safe, no error, despite missing previews', (await page.textContent('#safe-main')) === 'Alle 6 Zeilen sind sicher gespeichert.'
        && (await page.isHidden('#safe-help')) && !(await page.getAttribute('#waiting', 'class')).includes('problem'), await page.textContent('#safe-main'));
      // Later raw uploads are not blocked by the failing preview.
      hub.previewMode = '500';
      const before = hub.log.length;
      const late = record({ session: 'b-late', prompt: 'de-core-0009' });
      await put(page, [late]);
      await page.evaluate(() => window.__hw.outbox.flush('manual'));
      await L.until(async () => (await states(page))[late.id] === 'verified', 10000);
      L.check('B: a later raw upload goes through while previews keep failing', hub.log.slice(before)[0].kind === 'raw' && hub.log.slice(before)[0].status === 200);

      // A preview commit that hangs is given up, raw lines behind it still go up.
      hub.previewMode = 'hang';
      await page.evaluate(() => window.__hw.outbox.setPreviewTimeout(1500));
      await page.evaluate(() => { window.__hw.outbox.previews('manual'); });
      await L.until(() => hub.log.some((c) => c.status === -1), 10000);
      const behind = record({ session: 'b-late', prompt: 'de-core-0010' });
      await put(page, [behind]);
      const t0 = Date.now();
      await page.evaluate(() => window.__hw.outbox.flush('manual'));
      await L.until(async () => (await states(page))[behind.id] === 'verified', 10000);
      L.check('B: a hanging preview commit holds raw lines back at most until its time-out', Date.now() - t0 < 5000 && hub.log.filter((c) => c.kind === 'raw' && c.paths.includes(store_path(behind))).length === 1, `${Date.now() - t0} ms`);

      // Reload between the two commits: the preview commit hangs, the page goes away.
      await page.evaluate(() => window.__hw.outbox.setPreviewTimeout(600000));
      const hangRecs = [record({ session: 'b-hang', prompt: 'de-core-0001' })];
      await put(page, hangRecs);
      const hung = hub.log.filter((c) => c.status === -1).length;
      await page.evaluate(() => window.__hw.outbox.flush('manual'));
      await page.evaluate(() => { window.__hw.outbox.previews('manual'); });   // past the back-off
      await L.until(() => hub.log.filter((c) => c.status === -1).length > hung, 10000);
      const n0 = (await entries(page)).length;
      hub.previewMode = 'ok';
      await page.reload();
      await page.waitForFunction(() => window.__hwReady).then(() => page.evaluate(() => window.__hwReady));
      // On start, every uploaded line without a preview gets one.
      await L.until(async () => (await entries(page)).every((e) => e.preview_at), 15000);
      const es = await entries(page);
      L.check('B: reload between raw and preview commit loses nothing', es.length === n0 && es.every((e) => e.state === 'verified'), `${es.length}/${n0}`);
      L.check('B: after the restart the previews of all 10 lines are in the dataset', es.every((e) => hub.files.has(`preview/${e.writer_id}/${e.record.session_id}/${e.prompt_id}__${e.id}.png`)));
      L.check('B: ... with a metadata.jsonl for each session', ['b-500', 'b-413', 'b-network', 'b-late', 'b-hang'].every((s) => hub.files.has(`preview/finn/${s}/metadata.jsonl`)
        && hub.files.get(`preview/finn/${s}/metadata.jsonl`).content.split('\n').filter(Boolean).length === (s === 'b-hang' ? 1 : 2)));
      L.check('B: the raw lines were never uploaded twice', hub.log.filter((c) => c.kind === 'raw').length === 6, hub.log.map((c) => c.kind).join());
      L.check('B: no delete() or clear() on IndexedDB', (await page.evaluate(() => window.__idbDeletes)) === 0);
      await ctx.close();
    }

    // ================= C: reconciliation =================
    {
      const hub = fakeHub();
      hub.pageSize = 3;
      const { page, ctx, errors } = await L.newApp(browser, server, { signedIn: true, hf: hub.handler, init: COUNT_DELETES });
      const recs = [];
      for (let i = 0; i < 4; i++) recs.push(record({ session: 'c1', prompt: `de-core-000${i + 1}` }));
      for (let i = 0; i < 3; i++) recs.push(record({ session: 'c2', prompt: `de-core-000${i + 1}`, writer: 'lena', name: 'Lena' }));
      await put(page, recs);
      await page.evaluate(() => window.__hw.outbox.flush('manual'));
      await L.until(async () => Object.values(await states(page)).every((s) => s === 'verified'), 10000);
      L.check('C: listing pages through 7 files 3 at a time (Link: rel="next")', hub.tree.some((u) => u.includes('cursor=3')) && hub.tree.some((u) => u.includes('cursor=6')), hub.tree.length + ' calls');
      L.check('C: lines of both writers verified', Object.values(await states(page)).length === 7);
      await page.evaluate(() => { location.hash = '#/einstellungen'; });
      await page.waitForSelector('#v-einstellungen:not([hidden])');
      await L.until(async () => (await page.textContent('#safe-main')) === 'Alle 7 Zeilen sind sicher gespeichert.', 3000).catch(() => {});
      L.check('C: "Alle 7 Zeilen sind sicher gespeichert."', (await page.textContent('#safe-main')) === 'Alle 7 Zeilen sind sicher gespeichert.', await page.textContent('#safe-main'));
      L.check('C: time of the last check is shown', /^Zuletzt geprüft: heute, \d\d:\d\d Uhr\.$/.test(await page.textContent('#safe-check-text')), await page.textContent('#safe-check-text'));
      L.check('C: top bar says all lines are safe', (await page.textContent('#waiting-text')) === 'Alle 7 Zeilen sicher gespeichert'
        && (await page.getAttribute('#waiting-icon', 'href')) === '#i-cloud-check' && !(await page.isHidden('#waiting')));
      await L.shot(page, 'safety-tablet-all-safe');

      // A failed or partial listing changes nothing, even with files really gone.
      const lostF = recs[1]; const lostL = recs[5];
      hub.files.delete(store_path(lostF)); hub.files.delete(store_path(lostL));
      await age(page, recs.map((r) => r.id));
      const snap = JSON.stringify(await states(page));
      for (const mode of ['500', 'network', 'page2-500', 'garbage', '401repo']) {
        hub.treeMode = mode;
        const before = hub.log.length;
        const r = await page.evaluate(() => window.__hw.outbox.verify('manual'));
        await page.waitForTimeout(150);
        L.check(`C: listing ${mode}: no state changes, nothing uploaded`, !r.ok && JSON.stringify(await states(page)) === snap && hub.log.length === before, JSON.stringify(r));
      }
      await page.evaluate(() => window.__hw.updateStatus());
      await page.waitForTimeout(100);
      L.check('C: a failed check is said calmly', (await page.textContent('#safe-check-text')).startsWith('Die Prüfung hat gerade nicht geklappt, es wird später noch einmal versucht. Zuletzt geprüft: heute'), await page.textContent('#safe-check-text'));
      L.check('C: ... and the lines still count as safe (they were seen before)', (await page.textContent('#safe-main')) === 'Alle 7 Zeilen sind sicher gespeichert.');

      // "Jetzt prüfen" with a complete listing: the 2 lost lines (two writers) go up again.
      hub.treeMode = 'ok';
      const before = hub.log.length;
      await page.click('#safe-check');
      await L.until(async () => hub.log.slice(before).some((c) => c.kind === 'raw'), 10000);
      const re = hub.log.slice(before).find((c) => c.kind === 'raw');
      L.check('C: "Jetzt prüfen" re-uploads exactly the lost lines of both writers', JSON.stringify([...re.paths].sort()) === JSON.stringify([store_path(lostF), store_path(lostL)].sort()), re.paths.join());
      await L.until(async () => Object.values(await states(page)).every((s) => s === 'verified'), 10000);
      L.check('C: ... and they are verified again afterwards', hub.files.has(store_path(lostF)) && hub.files.has(store_path(lostL)));
      const es = await entries(page);
      L.check('C: re-uploaded lines count their re-upload', es.find((e) => e.id === lostF.id).requeues === 1 && es.find((e) => e.id === recs[0].id).requeues === 0);
      await L.until(async () => (await entries(page)).every((e) => e.preview_at), 10000);
      L.check('C: the re-uploaded lines get their preview again', hub.log.slice(before).some((c) => c.kind === 'preview' && c.paths.some((p) => p.includes(lostF.id))));

      // The server answers 2xx but loses the file: "sent", "wird noch geprüft", then uploaded again.
      hub.rawMode = 'drop';
      const ghost = record({ session: 'c1', prompt: 'de-core-0009' });
      await put(page, [ghost]);
      await page.evaluate(() => window.__hw.outbox.flush('manual'));
      await L.until(async () => (await states(page))[ghost.id] === 'sent', 5000);
      await page.evaluate(() => window.__hw.outbox.verify('manual'));
      await page.evaluate(() => window.__hw.updateStatus());
      await page.waitForTimeout(150);
      L.check('C: a line just sent but not listed yet stays "sent" (not queued again at once)', (await states(page))[ghost.id] === 'sent');
      L.check('C: "1 Zeile wird noch geprüft."', (await page.textContent('#safe-pending')) === '1 Zeile wird noch geprüft.' && (await page.textContent('#safe-main')) === '7 von 8 Zeilen sind sicher gespeichert.'
        && (await page.textContent('#safe-local')) === 'Alle anderen sind auf diesem Gerät gespeichert.', await page.textContent('#safe-main'));
      L.check('C: top bar: "1 Zeile wird geprüft"', (await page.textContent('#waiting-text')) === '1 Zeile wird geprüft');
      await L.shot(page, 'safety-tablet-checking');
      hub.rawMode = 'ok';
      await age(page, [ghost.id]);
      const before2 = hub.log.length;
      await page.click('#safe-check');
      await L.until(async () => (await states(page))[ghost.id] === 'verified', 10000);
      L.check('C: the lost line was uploaded again and is now verified', hub.log.slice(before2).filter((c) => c.kind === 'raw').length === 1 && hub.files.has(store_path(ghost)));
      await L.until(async () => (await page.textContent('#safe-main')) === 'Alle 8 Zeilen sind sicher gespeichert.', 3000).catch(() => {});
      L.check('C: "Alle 8 Zeilen sind sicher gespeichert."', (await page.textContent('#safe-main')) === 'Alle 8 Zeilen sind sicher gespeichert.', await page.textContent('#safe-main'));

      // Progress comes from the same listing: no second listing for it.
      const t0 = hub.tree.length;
      await page.evaluate(() => window.__hw.outbox.verify('manual'));
      L.check('C: one check = one listing (3 pages for 8 files)', hub.tree.length - t0 === 3, String(hub.tree.length - t0));
      L.check('C: progress of every writer from that listing', await page.evaluate(() => window.__hw.app.remoteAll.finn.size === 5 && window.__hw.app.remoteAll.lena.size === 3));

      // Hidden page / pagehide: waiting lines go up (best effort).
      const one = record({ session: 'c1', prompt: 'de-core-0010' });
      await put(page, [one]);
      const before3 = hub.log.length;
      await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
      await L.until(async () => hub.log.slice(before3).some((c) => c.kind === 'raw' && c.paths.includes(store_path(one))), 5000);
      L.check('C: the page going hidden uploads a waiting line', true);
      const two = record({ session: 'c1', prompt: 'de-core-0011' });
      await put(page, [two]);
      await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
      await L.until(async () => hub.log.some((c) => c.kind === 'raw' && c.paths.includes(store_path(two))), 5000);
      L.check('C: pagehide uploads a waiting line', true);
      await L.until(async () => Object.values(await states(page)).every((s) => s === 'verified'), 10000);
      L.check('C: nothing ever deleted locally (10 lines, no delete()/clear())', (await entries(page)).length === 10 && (await page.evaluate(() => window.__idbDeletes)) === 0);
      L.check('C: no page errors', errors.filter((e) => !/Failed to load resource|ERR_/.test(e)).length === 0, errors.join(' | '));
      await ctx.close();
    }

    // ================= D: status texts =================
    {
      const hub = fakeHub();
      const { page, ctx } = await L.newApp(browser, server, { signedIn: true, hf: hub.handler });
      const T = (s) => page.evaluate((s) => window.__hw.safetyTexts(s), s);
      const base = { c: { total: 47, queued: 0, sent: 0, verified: 47, rejected: 0 }, st: { running: false, lastError: null, checking: false, checkProblem: null }, auth: true, offline: false, lastCheck: { at: Date.now() }, waitedMs: 0 };
      const w = (o) => Object.assign({}, base, o, { c: Object.assign({}, base.c, o.c || {}), st: Object.assign({}, base.st, o.st || {}) });
      let t = await T(base);
      L.check('D: all verified', t.main === 'Alle 47 Zeilen sind sicher gespeichert.' && t.level === 'ok' && t.barSafe && /^Zuletzt geprüft: heute, \d\d:\d\d Uhr\.$/.test(t.check), JSON.stringify(t));
      t = await T(w({ c: { queued: 3, verified: 44 } }));
      L.check('D: waiting', t.queued === '3 Zeilen warten auf das Hochladen.' && t.main === '44 von 47 Zeilen sind sicher gespeichert.' && t.barLong === '3 Zeilen warten aufs Hochladen' && !t.help, JSON.stringify(t));
      t = await T(w({ c: { sent: 2, verified: 45 } }));
      L.check('D: being checked', t.pending === '2 Zeilen werden noch geprüft.' && t.barLong === '2 Zeilen werden geprüft' && t.level === 'wait', JSON.stringify(t));
      t = await T(w({ offline: true, lastCheck: null }));
      L.check('D: offline, never checked', t.check === 'Noch nicht geprüft (offline).', t.check);
      t = await T(w({ offline: true, lastCheck: { at: Date.now() - 86400000 } }));
      L.check('D: offline with an earlier check: its time', /^Noch nicht geprüft \(offline\)\. Zuletzt geprüft: gestern, \d\d:\d\d Uhr\.$/.test(t.check), t.check);
      t = await T(w({ c: { queued: 1, verified: 46 }, st: { lastError: { kind: 'network' } }, waitedMs: 5 * 60000 }));
      L.check('D: short network outage: calm, no help box, no "problem"', t.queued.includes('Keine Verbindung') && !t.help && !t.barProblem, JSON.stringify(t));
      t = await T(w({ c: { queued: 3, verified: 44 }, auth: false, waitedMs: 3 * 3600000 }));
      L.check('D: signed out for hours: what to do', t.help.startsWith('Seit über 3 Stunden konnten 3 Zeilen nicht hochgeladen werden. Sie sind auf diesem Gerät gespeichert und gehen nicht verloren.') && t.help.includes('Melde dich') && t.level === 'help', t.help);
      t = await T(w({ c: { queued: 1, verified: 46 }, st: { lastError: { kind: 'notfound' } }, waitedMs: 3 * 86400000 }));
      L.check('D: dataset missing for days: what to do', t.help.startsWith('Seit über 3 Tagen konnte 1 Zeile nicht hochgeladen werden. Sie ist auf diesem Gerät gespeichert') && t.help.includes('„Jetzt hochladen“'), t.help);
      t = await T(w({ c: { total: 0, verified: 0 } }));
      L.check('D: no lines yet: indicator hidden', t.main === 'Noch keine Zeilen auf diesem Gerät.' && t.barEmpty);
      t = await T(w({ st: { checking: true } }));
      L.check('D: check running', t.check === 'Wird gerade geprüft …');
      // Offline for real: the check says so and touches nothing.
      await ctx.setOffline(true);
      const r = await page.evaluate(() => window.__hw.outbox.verify('manual'));
      await page.evaluate(() => { location.hash = '#/einstellungen'; });
      await page.waitForSelector('#v-einstellungen:not([hidden])');
      await page.evaluate(() => window.__hw.updateStatus());
      await page.waitForTimeout(100);
      L.check('D: offline check: "Noch nicht geprüft (offline)." shown', !r.ok && r.kind === 'offline' && (await page.textContent('#safe-check-text')).startsWith('Noch nicht geprüft (offline).'), await page.textContent('#safe-check-text'));
      await ctx.setOffline(false);
      await ctx.close();
    }

    // ================= F: a device with lines from the previous version (DB v1) =================
    {
      const hub = fakeHub();
      const ctx = await browser.newContext({ locale: 'de-DE' });
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*' };
      await ctx.route(/^https:\/\/([a-z0-9-]+\.)?huggingface\.co\//, async (route, request) => {
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        const r = await hub.handler({ method: request.method(), url: request.url(), headers: request.headers(), body: request.postData() });
        if (!r || r === 'abort') return route.abort('connectionrefused');
        return route.fulfill({ status: r.status, headers: Object.assign({ 'content-type': 'application/json' }, cors, r.headers || {}), body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body === undefined ? {} : r.body) });
      });
      await ctx.addInitScript(([token, name]) => {
        if (!localStorage.getItem('hw.auth')) localStorage.setItem('hw.auth', JSON.stringify({ token, name, source: 'token', expiresAt: null }));
      }, [L.FAKE_TOKEN, L.FAKE_USER]);
      await ctx.addInitScript(COUNT_DELETES);
      const page = await ctx.newPage();
      await page.goto(new URL('manifest.webmanifest', server.url).href);
      const old = [record({ session: 'f1', prompt: 'de-core-0001' }), record({ session: 'f1', prompt: 'de-core-0002' })];
      // v1 database: one line 'uploaded' (but lost on the server since), one 'queued'.
      await page.evaluate((recs) => new Promise((resolve, reject) => {
        const r = indexedDB.open('handschrift', 1);
        r.onupgradeneeded = () => { const s = r.result.createObjectStore('lines', { keyPath: 'id' }); s.createIndex('state', 'state'); r.result.createObjectStore('kv'); };
        r.onsuccess = () => {
          const t = r.result.transaction('lines', 'readwrite');
          recs.forEach((rec, i) => t.objectStore('lines').put({ id: rec.id, path: `raw/v1/${rec.writer_id}/${rec.session_id}/${rec.prompt.id}__${rec.id}.json`, prompt_id: rec.prompt.id, writer_id: rec.writer_id,
            state: i === 0 ? 'uploaded' : 'queued', created_at: rec.created_at, uploaded_at: i === 0 ? '2026-01-01T00:00:00.000Z' : null, record: rec }));
          t.oncomplete = () => { r.result.close(); resolve(); }; t.onerror = () => reject(t.error);
        };
      }), old);
      await page.goto(server.url);
      await page.waitForFunction(() => window.__hwReady).then(() => page.evaluate(() => window.__hwReady));
      await L.until(async () => Object.values(await states(page)).every((s) => s === 'verified'), 10000)
        .catch(async (e) => { console.log('F debug', JSON.stringify(await states(page)), hub.log.map((c) => c.kind + c.status).join(), hub.tree.length); throw e; });
      const es = await entries(page);
      const rawPaths = hub.log.filter((c) => c.kind === 'raw').flatMap((c) => c.paths);
      L.check('F: v1 "uploaded" line becomes "sent", is found missing, uploaded again and verified; the queued one too',
        es.length === 2 && es.every((e) => e.state === 'verified') && rawPaths.length === 2 && es.find((e) => e.id === old[0].id).requeues === 1,
        JSON.stringify(es.map((e) => [e.state, e.requeues])) + ' ' + rawPaths.length);
      await L.until(async () => (await entries(page)).every((e) => e.preview_at), 10000);
      L.check('F: lines from before get their preview on start', hub.files.has('preview/finn/f1/metadata.jsonl'));
      L.check('F: nothing deleted', (await page.evaluate(() => window.__idbDeletes)) === 0);
      await ctx.close();
    }

    // ================= E: Einstellungen screenshots =================
    for (const [tag, viewport, colorScheme] of [['tablet', { width: 1280, height: 800 }, 'light'], ['phone', { width: 412, height: 915 }, 'light'], ['tablet-dark', { width: 1280, height: 800 }, 'dark']]) {
      const hub = fakeHub();
      const { page, ctx } = await L.newApp(browser, server, { signedIn: true, hf: hub.handler, viewport, colorScheme });
      const recs = [];
      for (let i = 0; i < 12; i++) recs.push(record({ session: 'e1', prompt: `de-core-00${10 + i}` }));
      await put(page, recs);
      await page.evaluate(() => window.__hw.outbox.flush('manual'));
      await L.until(async () => Object.values(await states(page)).every((s) => s === 'verified'), 10000);
      await page.evaluate(() => { location.hash = '#/einstellungen'; });
      await page.waitForSelector('#v-einstellungen:not([hidden])');
      await page.evaluate(() => document.getElementById('g-upload').scrollIntoView());
      await page.waitForTimeout(150);
      await L.shot(page, `safety-${tag}-settings-safe`);
      // Some lines waiting for long while signed out.
      await page.evaluate(() => window.__hw.hf.signOut());
      const old = [0, 1, 2].map((i) => Object.assign(record({ session: 'e2', prompt: `de-core-003${i}` }), { created_at: new Date(Date.now() - 5 * 3600000 + i).toISOString() }));
      await put(page, old);
      await page.evaluate(() => window.__hw.updateStatus());
      await page.waitForTimeout(150);
      await page.evaluate(() => document.getElementById('g-upload').scrollIntoView());
      await L.shot(page, `safety-${tag}-settings-waiting`);
      if (tag === 'tablet') {
        L.check('E: waiting + signed out: help box with what to do', (await page.textContent('#safe-help')).includes('Melde dich') && (await page.textContent('#safe-main')) === '12 von 15 Zeilen sind sicher gespeichert.', await page.textContent('#safe-main'));
        L.check('E: "Jetzt prüfen" disabled while signed out', await page.isDisabled('#safe-check'));
      }
      await ctx.close();
    }
  } catch (e) {
    console.error(e); L.check('test ran without exception', false, String(e));
  } finally {
    await browser.close(); await server.close();
  }
  process.exit(L.summary() ? 0 : 1);
})();

function store_path(r) { return `raw/v1/${r.writer_id}/${r.session_id}/${r.prompt.id}__${r.id}.json`; }
