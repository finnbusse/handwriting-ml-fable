// "Meine Zeilen" (#/zeilen): every line the current writer has in the dataset, plus the
// lines that are still waiting on this device. A line's text can be corrected and a line
// can be deleted.
//
// Data rules (this is the writer's training data):
//   - Only an explicit, confirmed delete removes files: that line's raw JSON and preview
//     PNG, and its row in that session's metadata.jsonl. Nothing else, never another
//     writer's or another session's files (checkScope), one commit per action.
//   - A correction overwrites the raw JSON at the same path and that one metadata row.
//   - Both run inside outbox.exclusive(), between two upload/preview commits.
//   - A failed request changes nothing, locally or in the dataset.
//   - A failed or cut-off listing never makes lines disappear: the screen then shows the
//     lines on this device and the last complete listing it saw, and says so.
//   - Locally a deleted line becomes a tombstone (store.markDeleted), never a delete().
import * as store from './store.js';
import * as hf from './hf.js';
import * as outbox from './outbox.js';
import * as preview from './preview.js';
import { withText, validate } from './capture/hwline.js';

export const PORTION = 30;          // lines rendered per portion
const IMG_CONCURRENCY = 4;          // image (and record) downloads at a time
const PREFETCH_UNDATED = 40;        // remote lines without a metadata row: records fetched for the order
const CACHE_KEY = 'libraryCache';

export class LibError extends Error {
  /** kind: 'signed-out' | 'offline' | 'network' | 'server' | 'rate' | 'auth' | 'forbidden'
   *        | 'notfound' | 'empty' | 'invalid' | 'foreign' | 'scope' | 'other' */
  constructor(kind, message) { super(message || kind); this.kind = kind; }
}

const nfc = (s) => String(s).normalize('NFC');
const fileNameOf = (it) => `${it.promptId}__${it.id}.png`;
const pngPathOf = (it) => `preview/${it.writer}/${it.session}/${fileNameOf(it)}`;
const metaPathOf = (it) => `preview/${it.writer}/${it.session}/metadata.jsonl`;
/** metadata.jsonl writes dates as "YYYY-MM-DD HH:MM:SS" (UTC). */
const isoFromRowDate = (d) => (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(d || '') ? `${d.replace(' ', 'T')}.000Z` : null);

async function asLib(e) {
  if (e instanceof LibError) return e;
  if (!(e instanceof hf.HfError)) return new LibError('other', String(e && e.message || e));
  let kind = e.kind;
  if (kind === 'auth') kind = await hf.classify401(e);
  if (kind === 'cancelled') kind = 'network';
  return new LibError(['network', 'server', 'rate', 'auth', 'forbidden', 'notfound'].includes(kind) ? kind : 'other', e.message);
}

function needRepo() {
  if (!hf.getAuth()) throw new LibError('signed-out');
  if (navigator.onLine === false) throw new LibError('offline');
  return hf.datasetRepoId();
}

/** Every path of a commit must belong to this one line's writer and session. */
function checkScope(files, it) {
  const ok = (p) => p.startsWith(`raw/v1/${it.writer}/${it.session}/`) || p.startsWith(`preview/${it.writer}/${it.session}/`);
  const own = new Set([it.path, pngPathOf(it), metaPathOf(it)]);
  for (const f of files) {
    if (!ok(f.path) || !own.has(f.path)) throw new LibError('scope', f.path);
  }
}

async function downloadText(repo, path) {
  const res = await hf.downloadFile(repo, path, { repoType: 'dataset' });
  return res.text();
}

async function downloadRecord(repo, it) {
  let rec;
  try { rec = JSON.parse(await downloadText(repo, it.path)); }
  catch (e) { if (e instanceof hf.HfError) throw e; throw new LibError('invalid', 'raw file not readable'); }
  if (!rec || rec.schema !== 'hwline/v1' || rec.id !== it.id || rec.writer_id !== it.writer) throw new LibError('invalid', 'raw file does not match');
  return rec;
}

// ---------- listing ----------

/** The current writer's files in the dataset: {raw: [paths], previews: Set|null}.
 *  Throws when the raw listing is not complete. A failed preview listing gives
 *  previews: null (unknown), which only means images are tried and may fall back. */
export async function remoteListing(writerId) {
  const repo = needRepo();
  const [raw, pv] = await Promise.all([
    hf.listTree(repo, `raw/v1/${writerId}`),
    hf.listTree(repo, `preview/${writerId}`).then((p) => new Set(p), () => null),
  ]);
  return { raw: raw.filter((p) => store.parsePath(p) && store.parsePath(p).writer === writerId), previews: pv };
}

/**
 * Merge local lines with the raw paths of the dataset into one list, newest first.
 * info: id -> {text, date} known from metadata.jsonl or a downloaded record.
 */
export function merge(localEntries, rawPaths, writerId, info = {}) {
  const items = new Map();
  for (const p of rawPaths) {
    const m = store.parsePath(p);
    if (!m || m.writer !== writerId) continue;
    items.set(m.id, { id: m.id, path: p, writer: m.writer, session: m.session, promptId: m.promptId, remote: true, entry: null });
  }
  for (const e of localEntries) {
    if (!store.isLive(e) || e.writer_id !== writerId) continue;
    const m = store.parsePath(e.path);
    if (!m) continue;
    const it = items.get(e.id) || { id: e.id, path: e.path, writer: m.writer, session: m.session, promptId: m.promptId, remote: false };
    it.entry = e;
    items.set(e.id, it);
  }
  const user = hf.userName();
  for (const it of items.values()) {
    const r = it.entry && it.entry.record;
    const known = info[it.id] || {};
    it.text = r ? r.text : known.text != null ? known.text : null;
    it.date = r ? r.created_at : known.date || null;
    it.promptText = r && r.prompt ? r.prompt.text : known.promptText || null;
    it.edited = r ? !!r.text_edit : !!known.edited;
    it.state = it.entry ? it.entry.state : 'remote';
    // Uploaded under another account: that account's dataset holds it, not this one.
    it.foreign = !!(it.entry && store.UPLOADED.includes(it.entry.state) && it.entry.uploaded_to && user && it.entry.uploaded_to !== user && !it.remote);
  }
  return [...items.values()].sort((a, b) => {
    if (a.date && b.date && a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (!!a.date !== !!b.date) return a.date ? -1 : 1;
    return a.path < b.path ? 1 : a.path > b.path ? -1 : 0;
  });
}

// ---------- actions ----------

/**
 * Correct the text of a line. Lines still waiting on this device are only changed here
 * (they go up with the new text). Lines in the dataset: one commit with the raw JSON at
 * the same path and the session's metadata.jsonl with that row updated; then the local
 * copy (if any) is updated and keeps its state.
 * Returns {record, committed: [paths]} or {unchanged: true}.
 */
export async function correctText(it, text) {
  const t = nfc(text).replace(/\s+/g, ' ').trim();
  if (!t) throw new LibError('empty');
  if (it.foreign) throw new LibError('foreign');
  try {
    return await outbox.exclusive(async () => {
      const e = await store.getLine(it.id);
      const live = store.isLive(e) ? e : null;
      if (live && (live.state === 'queued' || live.state === 'rejected')) {
        if (live.record.text === t) return { unchanged: true };
        const rec = withText(live.record, t);
        if (validate(rec).length) throw new LibError('invalid', validate(rec).join(', '));
        await store.updateRecord(it.id, rec);
        return { record: rec, committed: [] };
      }
      const repo = needRepo();
      let base;
      try { base = await downloadRecord(repo, it); }
      catch (err) {
        // Sent a moment ago and not readable yet: the local copy is the same file.
        if (!(err instanceof hf.HfError && err.kind === 'notfound' && live)) throw err;
        base = live.record;
      }
      if (base.text === t) {
        if (live && live.record.text !== t) await store.updateRecord(it.id, base);
        return { unchanged: true, record: base };
      }
      const rec = withText(base, t);
      const before = new Set(validate(base));
      const errs = validate(rec).filter((x) => !before.has(x));
      if (errs.length) throw new LibError('invalid', errs.join(', '));
      const files = [{ path: it.path, text: JSON.stringify(rec) }];
      let metaText = null;
      try { metaText = await downloadText(repo, metaPathOf(it)); }
      catch (err) { if (!(err instanceof hf.HfError && err.kind === 'notfound')) throw err; }
      if (metaText !== null) {
        const m = preview.editMetadata(metaText, fileNameOf(it), rec);
        if (m.changed) files.push({ path: metaPathOf(it), text: m.text });
      }
      checkScope(files, it);
      await hf.commit(repo, `Text korrigiert: ${it.promptId}`, files);
      if (live) await store.updateRecord(it.id, rec);
      return { record: rec, committed: files.map((f) => f.path) };
    });
  } catch (err) { throw await asLib(err); }
}

/**
 * Delete a line from the dataset: one commit that deletes its raw JSON and preview PNG
 * (only those that a complete listing of the session shows) and rewrites the session's
 * metadata.jsonl without its row. Then the local entry (if any) becomes a tombstone.
 * Needs the network even for a line that waits on this device: it may have arrived.
 * Returns {removed: [paths], committed: [paths]}.
 */
export async function deleteLine(it) {
  if (it.foreign) throw new LibError('foreign');
  try {
    return await outbox.exclusive(async () => {
      const repo = needRepo();
      const [raw, pv] = await Promise.all([
        hf.listTree(repo, `raw/v1/${it.writer}/${it.session}`),
        hf.listTree(repo, `preview/${it.writer}/${it.session}`),
      ]);
      const files = [];
      if (raw.includes(it.path)) files.push({ path: it.path, delete: true });
      if (pv.includes(pngPathOf(it))) files.push({ path: pngPathOf(it), delete: true });
      if (pv.includes(metaPathOf(it))) {
        const m = preview.editMetadata(await downloadText(repo, metaPathOf(it)), fileNameOf(it), null);
        // The last row gone: an empty metadata.jsonl would only confuse the viewer.
        if (m.changed) files.push(m.text ? { path: metaPathOf(it), text: m.text } : { path: metaPathOf(it), delete: true });
      }
      checkScope(files, it);
      if (files.length) await hf.commit(repo, `Zeile gelöscht: ${it.promptId}`, files, { allowDelete: true });
      const removed = files.filter((f) => f.delete).map((f) => f.path);
      await store.markDeleted(it.id, { user: hf.userName(), removed });
      return { removed, committed: files.map((f) => f.path) };
    });
  } catch (err) { throw await asLib(err); }
}

// ---------- texts ----------

function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (d.toDateString() === new Date().toDateString()) return `heute, ${time} Uhr`;
  if (d.toDateString() === y.toDateString()) return `gestern, ${time} Uhr`;
  return `${d.toLocaleDateString('de-DE')}, ${time} Uhr`;
}

const STATE_TEXT = { queued: 'wartet aufs Hochladen', rejected: 'nicht hochgeladen' };

function metaText(it) {
  const parts = [];
  parts.push(it.date ? when(it.date) : 'Datum wird geladen …');
  if (STATE_TEXT[it.state]) parts.push(STATE_TEXT[it.state]);
  if (it.edited) parts.push('Text korrigiert');
  return parts.join(' · ');
}

const ERR_TEXT = {
  'signed-out': 'Dafür bitte zuerst anmelden. Es wurde nichts geändert.',
  offline: 'Keine Verbindung. Es wurde nichts geändert.',
  network: 'Keine Verbindung. Es wurde nichts geändert.',
  server: 'Hugging Face antwortet gerade nicht. Es wurde nichts geändert. Bitte später noch einmal.',
  rate: 'Hugging Face bittet um eine kurze Pause. Es wurde nichts geändert. Bitte gleich noch einmal.',
  auth: 'Die Anmeldung gilt nicht mehr. Bitte melde dich neu an. Es wurde nichts geändert.',
  forbidden: 'Dein Zugang darf im Datensatz nichts ändern. Es wurde nichts geändert.',
  notfound: 'Die Zeile wurde im Datensatz nicht gefunden. Es wurde nichts geändert.',
  empty: 'Bitte gib ein, was in der Zeile steht.',
  invalid: 'Diese Zeile lässt sich so nicht speichern. Es wurde nichts geändert.',
  foreign: 'Diese Zeile liegt im Datensatz eines anderen Kontos. Hier lässt sie sich nicht ändern.',
  scope: 'Das geht so nicht. Es wurde nichts geändert.',
  other: 'Das hat nicht geklappt. Es wurde nichts geändert.',
};
export const errorText = (e) => ERR_TEXT[(e && e.kind) || 'other'] || ERR_TEXT.other;

const zeilen = (n) => `${n} ${n === 1 ? 'Zeile' : 'Zeilen'}`;

// ---------- view ----------

const VIEW_HTML = `
<div class="lib">
  <div class="lib-head">
    <a class="iconbtn lib-back" id="lib-back" href="#/erfassen" aria-label="Zurück" title="Zurück"><svg class="ic"><use href="#i-back"/></svg></a>
    <h1>Meine Zeilen</h1>
  </div>
  <p class="lib-count" id="lib-count" aria-live="polite"></p>
  <div class="lib-note" id="lib-note" hidden><p id="lib-note-text" role="status"></p>
    <button class="btn" id="lib-reload" type="button" hidden><svg class="ic"><use href="#i-again"/></svg><span>Nochmal laden</span></button></div>
  <p class="lib-empty" id="lib-empty" hidden>Noch keine Zeilen. <a href="#/erfassen">Zeilen schreiben</a></p>
  <ul class="lib-list" id="lib-list"></ul>
  <div class="lib-more-row"><button class="btn" id="lib-more" type="button" hidden>Weitere Zeilen zeigen</button></div>
  <div class="lib-sentinel" id="lib-sentinel" aria-hidden="true"></div>
</div>`;

const DIALOG_HTML = `
<dialog class="dlg lib-dlg" id="dlg-line" aria-labelledby="ld-title">
  <div class="ld-head">
    <h2 id="ld-title">Zeile</h2>
    <button class="btn" id="ld-close" type="button">Schließen</button>
  </div>
  <div class="ld-ink lib-ink"><img id="ld-img" alt=""></div>
  <p class="ld-meta" id="ld-meta"></p>
  <div class="ld-edit" id="ld-edit">
    <p class="ld-prompt"><span class="ld-label">Vorlage</span><span id="ld-prompt"></span></p>
    <label class="field ld-field" for="ld-text"><span>Geschrieben steht</span>
      <input id="ld-text" type="text" autocomplete="off" spellcheck="false" maxlength="300"></label>
    <p class="ld-hint">Steht in der Zeile etwas anderes als in der Vorlage, schreib hier, was wirklich dasteht.</p>
    <p class="err" id="ld-err" role="alert" hidden></p>
    <div class="ld-actions">
      <button class="btn" id="ld-delete" type="button"><svg class="ic"><use href="#i-clear"/></svg><span>Löschen</span></button>
      <button class="btn primary" id="ld-save" type="button"><span id="ld-save-label">Speichern</span></button>
    </div>
  </div>
  <div class="ld-confirm" id="ld-confirm" hidden>
    <h3>Diese Zeile löschen?</h3>
    <p>Sie wird aus dem Datensatz entfernt und nicht mehr fürs Lernen verwendet. Der Satz kommt wieder dran, damit du ihn neu schreiben kannst.</p>
    <p class="err" id="ld-cerr" role="alert" hidden></p>
    <div class="ld-actions">
      <button class="btn" id="ld-keep" type="button">Behalten</button>
      <button class="btn primary" id="ld-really" type="button"><span id="ld-really-label">Zeile löschen</span></button>
    </div>
  </div>
</dialog>`;

/**
 * deps: { root: <section>, toast(text), writer() -> {id,name}|null,
 *         changed(type: 'deleted'|'edited', detail) }
 */
export function createLibraryView(deps) {
  const root = deps.root;
  root.innerHTML = VIEW_HTML;
  document.body.insertAdjacentHTML('beforeend', DIALOG_HTML);
  const $ = (id) => document.getElementById(id);
  const dlg = $('dlg-line');

  let gen = 0;                 // bumped on every (re)load: late results of an older one are dropped
  let items = [];
  let shown = 0;
  let remote = null;           // {raw, previews, at, cached?} of the last complete listing (or cache)
  let remoteState = 'idle';    // idle | loading | ok | failed | signed-out
  let remoteProblem = null;
  let info = {};               // id -> {text, date, promptText, edited}
  const urls = new Map();      // id -> object URL of the line image
  const records = new Map();   // id -> downloaded record
  const pending = new Map();   // id -> promise of an image being made
  const els = new Map();       // id -> <li>
  let visible = false;
  let current = null;          // the item open in the dialog

  // ---------- small job queue for downloads ----------
  const jobs = []; let active = 0;
  function run(job) {
    return new Promise((resolve, reject) => { jobs.push(() => job().then(resolve, reject)); pump(); });
  }
  function pump() {
    while (active < IMG_CONCURRENCY && jobs.length) {
      const j = jobs.shift(); active++;
      j().finally(() => { active--; pump(); });
    }
  }

  async function recordOf(it) {
    if (it.entry && it.entry.record) return it.entry.record;
    if (records.has(it.id)) return records.get(it.id);
    const rec = await run(() => downloadRecord(hf.datasetRepoId(), it));
    records.set(it.id, rec);
    info[it.id] = { text: rec.text, date: rec.created_at, promptText: rec.prompt && rec.prompt.text, edited: !!rec.text_edit };
    return rec;
  }

  /** The line as an image: the preview PNG when the dataset has it, else drawn from the
   *  record (the local one first, else the raw JSON). */
  function imageOf(it) {
    if (urls.has(it.id)) return Promise.resolve(urls.get(it.id));
    if (pending.has(it.id)) return pending.get(it.id);
    const p = (async () => {
      const pvKnown = remote && remote.previews;
      const tryPreview = it.remote && hf.getAuth() && navigator.onLine !== false
        && (pvKnown ? remote.previews.has(pngPathOf(it)) : !(it.entry && !it.entry.preview_at));
      let blob = null;
      if (tryPreview) {
        try { blob = await run(async () => (await hf.downloadFile(hf.datasetRepoId(), pngPathOf(it), { repoType: 'dataset' })).blob()); }
        catch (_) { blob = null; }
      }
      if (!blob) {
        const rec = await recordOf(it);
        if (!preview.hasInk(rec)) return null;
        blob = new Blob([await preview.renderPng(rec)], { type: 'image/png' });
      }
      const url = URL.createObjectURL(blob);
      urls.set(it.id, url);
      return url;
    })();
    pending.set(it.id, p);
    p.finally(() => pending.delete(it.id)).catch(() => {});
    return p;
  }

  // ---------- rendering ----------

  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((list) => {
    for (const en of list) {
      if (!en.isIntersecting) continue;
      io.unobserve(en.target);
      loadRow(en.target);
    }
  }, { root, rootMargin: '300px 0px' }) : null;

  const more = typeof IntersectionObserver === 'function' ? new IntersectionObserver((list) => {
    if (list.some((en) => en.isIntersecting) && visible && shown < items.length) showMore();
  }, { root, rootMargin: '400px 0px' }) : null;

  function loadRow(li) {
    const it = items.find((x) => x.id === li.dataset.id);
    if (!it) return;
    const g = gen;
    const img = li.querySelector('img');
    imageOf(it).then((url) => {
      if (g !== gen && !els.has(it.id)) return;
      if (url) { img.src = url; img.hidden = false; li.querySelector('.lib-ink').classList.add('ready'); }
      else li.querySelector('.lib-ink').classList.add('noink');
    }).catch(() => { li.querySelector('.lib-ink').classList.add('failed'); });
    if (it.text === null || !it.date) {
      recordOf(it).then((rec) => {
        it.text = rec.text; it.date = rec.created_at; it.promptText = rec.prompt && rec.prompt.text; it.edited = !!rec.text_edit;
        fillRow(li, it);
      }).catch(() => {});
    }
  }

  function fillRow(li, it) {
    const t = li.querySelector('.lib-text');
    t.textContent = it.text === null ? 'Text wird geladen …' : it.text;
    t.classList.toggle('loading', it.text === null);
    li.querySelector('.lib-meta').textContent = metaText(it);
    li.dataset.state = it.state;
  }

  function makeRow(it) {
    const li = document.createElement('li');
    li.className = 'lib-row';
    li.dataset.id = it.id;
    li.innerHTML = '<button class="lib-item" type="button"><span class="lib-ink"><img alt="" hidden></span>'
      + '<span class="lib-text"></span><span class="lib-meta"></span></button>';
    fillRow(li, it);
    els.set(it.id, li);
    if (urls.has(it.id)) { const img = li.querySelector('img'); img.src = urls.get(it.id); img.hidden = false; li.querySelector('.lib-ink').classList.add('ready'); }
    else if (io) io.observe(li);
    else loadRow(li);
    return li;
  }

  function showMore() {
    const list = $('lib-list');
    const end = Math.min(items.length, shown + PORTION);
    const frag = document.createDocumentFragment();
    for (let i = shown; i < end; i++) frag.append(makeRow(items[i]));
    list.append(frag);
    shown = end;
    $('lib-more').hidden = shown >= items.length;
  }

  function renderList() {
    const keep = Math.max(PORTION, shown);
    const list = $('lib-list');
    // Same lines in the same order (a state changed, a text arrived): update the rows in
    // place, so nothing flickers and the scroll position stays.
    const ids = [...list.children].map((li) => li.dataset.id);
    if (ids.length && ids.length === Math.min(keep, items.length) && ids.every((id, i) => items[i].id === id)) {
      items.slice(0, ids.length).forEach((it, i) => fillRow(list.children[i], it));
    } else {
      const top = root.scrollTop;
      if (io) io.disconnect();
      list.innerHTML = '';
      els.clear();
      shown = 0;
      while (shown < Math.min(keep, items.length)) showMore();
      root.scrollTop = top;
    }
    $('lib-more').hidden = shown >= items.length;
    $('lib-empty').hidden = items.length > 0 || remoteState === 'loading';
    renderHead();
  }

  function renderHead() {
    const waiting = items.filter((x) => x.state === 'queued').length;
    let count = zeilen(items.length);
    if (waiting) count += `, davon ${waiting} ${waiting === 1 ? 'wartet' : 'warten'} aufs Hochladen`;
    $('lib-count').textContent = remoteState === 'loading' && !items.length ? '' : count;
    let note = '';
    if (remoteState === 'signed-out') note = 'Du bist nicht angemeldet. Hier stehen nur die Zeilen auf diesem Gerät.';
    else if (remoteState === 'loading') note = 'Die Zeilen im Datensatz werden geladen …';
    else if (remoteState === 'failed') {
      const why = remoteProblem === 'offline' || remoteProblem === 'network' ? 'Keine Verbindung: ' : '';
      note = `${why}Die Zeilen im Datensatz konnten gerade nicht geladen werden. Du siehst die Zeilen auf diesem Gerät`
        + (remote && remote.at ? ` und den Stand von ${when(remote.at).replace(/ Uhr$/, '')} Uhr.` : '.');
    }
    $('lib-note').hidden = !note;
    $('lib-note-text').textContent = note;
    $('lib-reload').hidden = remoteState !== 'failed';
  }

  // ---------- loading ----------

  async function localItems() {
    const w = deps.writer();
    return w ? store.linesOf(w.id) : [];
  }

  async function remerge() {
    const w = deps.writer();
    if (!w) { items = []; renderList(); return; }
    items = merge(await localItems(), remote ? remote.raw : [], w.id, info);
    renderList();
  }

  async function saveCache(w) {
    if (!remote || remote.cached) return;
    const keep = {};
    for (const p of remote.raw) { const m = store.parsePath(p); if (m && info[m.id]) keep[m.id] = info[m.id]; }
    await store.kvSet(CACHE_KEY, { user: hf.userName(), writer: w.id, at: remote.at, raw: remote.raw, info: keep }).catch(() => {});
  }

  /** Text and date of the dataset's lines that are not on this device: from the
   *  sessions' metadata.jsonl, else (a few) from the raw records. */
  async function loadInfo(g, w) {
    const repo = hf.datasetRepoId();
    const missing = items.filter((it) => !it.entry && (it.text === null || !it.date));
    const sessions = [...new Set(missing.map((it) => it.session))];
    await Promise.all(sessions.map((s) => {
      const mp = `preview/${w.id}/${s}/metadata.jsonl`;
      if (remote.previews && !remote.previews.has(mp)) return null;
      return run(() => downloadText(repo, mp)).then((text) => {
        for (const line of text.split('\n')) {
          let row = null;
          try { row = line.trim() ? JSON.parse(line) : null; } catch (_) { row = null; }
          const m = row && /^(.+)__([0-9a-fA-F-]{36})\.png$/.exec(row.file_name || '');
          if (!m) continue;
          info[m[2]] = Object.assign(info[m[2]] || {}, { text: String(row.text), date: isoFromRowDate(row.date) });
        }
      }).catch(() => {});
    }));
    if (g !== gen) return;
    const w2 = deps.writer();
    items = merge(await localItems(), remote.raw, w2.id, info);
    const undated = items.filter((it) => !it.entry && !it.date).slice(0, PREFETCH_UNDATED);
    await Promise.all(undated.map((it) => recordOf(it).catch(() => null)));
    if (g !== gen) return;
    items = merge(await localItems(), remote.raw, w2.id, info);
  }

  async function load() {
    const g = ++gen;
    const w = deps.writer();
    if (!w) return;
    for (const u of urls.values()) URL.revokeObjectURL(u);
    urls.clear(); records.clear(); info = {}; remote = null;
    if (!hf.getAuth()) remoteState = 'signed-out';
    else remoteState = 'loading';
    await remerge();
    if (remoteState === 'signed-out') return;
    let listing;
    try { listing = await remoteListing(w.id); }
    catch (e) {
      if (g !== gen) return;
      const le = await asLib(e);
      // The last complete listing of this account and writer keeps those lines on screen.
      const c = await store.kvGet(CACHE_KEY, null).catch(() => null);
      const local = await localItems();
      if (g !== gen) return;
      if (c && c.user === hf.userName() && c.writer === w.id && Array.isArray(c.raw)) {
        remote = { raw: c.raw, previews: null, at: c.at, cached: true };
        info = Object.assign({}, c.info || {});
      }
      remoteState = 'failed'; remoteProblem = navigator.onLine === false ? 'offline' : le.kind;
      items = merge(local, remote ? remote.raw : [], w.id, info);
      renderList();
      return;
    }
    if (g !== gen) return;
    remote = Object.assign(listing, { at: Date.now() });
    items = merge(await localItems(), remote.raw, w.id, info);
    await loadInfo(g, w);
    if (g !== gen) return;
    remoteState = 'ok';
    renderList();
    saveCache(w);
  }

  // ---------- the dialog ----------

  function setBusy(on, which) {
    for (const id of ['ld-save', 'ld-delete', 'ld-close', 'ld-keep', 'ld-really', 'ld-text']) $(id).disabled = on;
    $('ld-save-label').textContent = on && which === 'save' ? 'Wird gespeichert …' : 'Speichern';
    $('ld-really-label').textContent = on && which === 'delete' ? 'Wird gelöscht …' : 'Zeile löschen';
  }

  function openItem(it) {
    current = it;
    $('ld-edit').hidden = false; $('ld-confirm').hidden = true;
    $('ld-err').hidden = true; $('ld-cerr').hidden = true;
    setBusy(false);
    const img = $('ld-img');
    img.hidden = true; img.removeAttribute('src');
    $('ld-meta').textContent = metaText(it);
    $('ld-text').value = it.text === null ? '' : it.text;
    $('ld-prompt').textContent = it.promptText || '';
    $('ld-prompt').parentElement.hidden = !it.promptText;
    imageOf(it).then((url) => { if (current === it && url) { img.src = url; img.hidden = false; } }).catch(() => {});
    if (it.text === null || !it.promptText) {
      recordOf(it).then((rec) => {
        if (current !== it) return;
        it.text = rec.text; it.promptText = rec.prompt && rec.prompt.text; it.date = rec.created_at;
        if (!$('ld-text').value) $('ld-text').value = rec.text;
        $('ld-prompt').textContent = it.promptText || ''; $('ld-prompt').parentElement.hidden = !it.promptText;
        $('ld-meta').textContent = metaText(it);
      }).catch(() => {});
    }
    dlg.showModal();
    $('ld-text').blur();
  }

  function showErr(id, e) { $(id).textContent = errorText(e); $(id).hidden = false; }

  async function save() {
    const it = current;
    if (!it) return;
    $('ld-err').hidden = true;
    setBusy(true, 'save');
    try {
      const r = await correctText(it, $('ld-text').value);
      if (r.unchanged) { dlg.close(); deps.toast('Nichts geändert.'); return; }
      info[it.id] = Object.assign(info[it.id] || {}, { text: r.record.text, edited: true });
      records.set(it.id, r.record);
      dlg.close();
      deps.toast('Text gespeichert.');
      deps.changed('edited', { id: it.id, writer: it.writer, promptId: it.promptId });
      await remerge();
    } catch (e) {
      showErr('ld-err', e);
    } finally { setBusy(false); }
  }

  async function really() {
    const it = current;
    if (!it) return;
    $('ld-cerr').hidden = true;
    setBusy(true, 'delete');
    try {
      await deleteLine(it);
      if (remote) remote.raw = remote.raw.filter((p) => p !== it.path);
      if (urls.has(it.id)) { URL.revokeObjectURL(urls.get(it.id)); urls.delete(it.id); }
      dlg.close();
      await remerge();
      saveCache(deps.writer());
      deps.toast('Zeile gelöscht.');
      deps.changed('deleted', { id: it.id, writer: it.writer, promptId: it.promptId,
        stillWritten: items.some((x) => x.promptId === it.promptId) });
    } catch (e) {
      showErr('ld-cerr', e);
    } finally { setBusy(false); }
  }

  if (more) more.observe($('lib-sentinel'));
  $('lib-list').addEventListener('click', (e) => {
    const b = e.target.closest('.lib-item');
    if (!b) return;
    const it = items.find((x) => x.id === b.parentElement.dataset.id);
    if (it) openItem(it);
  });
  $('lib-more').addEventListener('click', showMore);
  $('lib-reload').addEventListener('click', () => load());
  $('ld-close').addEventListener('click', () => dlg.close());
  $('ld-save').addEventListener('click', save);
  $('ld-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  $('ld-text').addEventListener('input', () => { $('ld-err').hidden = true; });
  $('ld-delete').addEventListener('click', () => { $('ld-edit').hidden = true; $('ld-confirm').hidden = false; $('ld-cerr').hidden = true; $('ld-keep').focus(); });
  $('ld-keep').addEventListener('click', () => { $('ld-confirm').hidden = true; $('ld-edit').hidden = false; });
  $('ld-really').addEventListener('click', really);
  dlg.addEventListener('cancel', (e) => { if ($('ld-close').disabled) e.preventDefault(); });
  dlg.addEventListener('close', () => { current = null; });

  // Lines uploaded or checked while the screen is open: their marks follow.
  outbox.onChange((type) => {
    if (visible && ['uploaded', 'checked', 'rejected'].includes(type)) remerge();
  });

  return {
    show(from) {
      visible = true;
      $('lib-back').href = `#/${from && from !== 'zeilen' ? from : 'erfassen'}`;
      load();
    },
    hide() {
      visible = false;
      gen++;
      if (dlg.open) dlg.close();
    },
    refresh: remerge,
    get items() { return items; },
    get shown() { return shown; },
    get remoteState() { return remoteState; },
  };
}
