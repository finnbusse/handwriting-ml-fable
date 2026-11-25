// IndexedDB: recorded lines (outbox + local archive) and small key/value state.
// Lines are never deleted by the app (nothing here calls delete): after an upload they
// only change state, so "Sicherung herunterladen" always has everything.
//
// Line states (entry.state):
//   queued   -> stored on the device, waiting for (another) upload
//   sent     -> the commit request answered 2xx; not yet seen in a listing
//   verified -> the file was SEEN in a listing of the dataset: only now is the line "safe"
//   rejected -> the server refused the content; kept on the device and in the backup
//   deleted  -> a tombstone: the writer deleted the line in "Meine Zeilen" and the dataset
//               commit that removed it answered 2xx. The record stays on the device, but the
//               line is never uploaded again, is not missing, waiting or safe, does not
//               count as written (its prompt comes back) and is left out of the backup.
//               No function below ever moves a line out of this state.
// sent/verified go back to queued when a complete listing does not have the file.
// Independent of that, entry.preview_at marks the Dataset Viewer preview as written
// (null = still to do); the preview never changes the state above.

const DB_NAME = 'handschrift';
const DB_VERSION = 2;
export const UPLOADED = ['sent', 'verified'];
export const DELETED = 'deleted';
/** A line that still counts (as written, in counts and in the backup): anything but a tombstone. */
export const isLive = (e) => !!e && e.state !== DELETED;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('lines')) {
        const s = db.createObjectStore('lines', { keyPath: 'id' });
        s.createIndex('state', 'state');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      // v1 -> v2: 'uploaded' meant "the commit returned 2xx", which is 'sent' now.
      if (ev.oldVersion >= 1 && ev.oldVersion < 2) {
        const cur = req.transaction.objectStore('lines').openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) return;
          const e = c.value;
          if (e.state === 'uploaded') { e.state = 'sent'; c.update(e); }
          c.continue();
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
  dbPromise.catch(() => { dbPromise = null; });   // a later call may try again
  return dbPromise;
}

function tx(storeName, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const s = t.objectStore(storeName);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  }));
}

const req2p = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/** Path of a line inside the dataset: raw/v1/<writer_id>/<session_id>/<prompt_id>__<id>.json.
 *  The prompt id is part of the file name so progress can be restored from a file
 *  listing alone (no downloads), the writer id is the folder so it can be told per writer. */
export function linePath(record) {
  return `raw/v1/${record.writer_id}/${record.session_id}/${record.prompt.id}__${record.id}.json`;
}

/** Inverse of linePath: prompt id from a dataset path, or null. With writerId, only
 *  paths below that writer's folder count. */
export function promptIdFromPath(path, writerId = null) {
  const m = /^raw\/v1\/([^/]+)\/[^/]+\/(.+)__[0-9a-fA-F-]{36}\.json$/.exec(path);
  if (!m) return null;
  if (writerId !== null && m[1] !== writerId) return null;
  return m[2];
}

/** Parts of a raw path: {writer, session, promptId, id}, or null. */
export function parsePath(path) {
  const m = /^raw\/v1\/([^/]+)\/([^/]+)\/(.+)__([0-9a-fA-F-]{36})\.json$/.exec(path);
  return m ? { writer: m[1], session: m[2], promptId: m[3], id: m[4] } : null;
}

/** Store an accepted line. Resolves only once the transaction is durable. */
export function putLine(record) {
  // Every line belongs to a writer; without one nothing is stored.
  if (!record.writer_id) return Promise.reject(new Error('no writer'));
  const entry = {
    id: record.id, path: linePath(record), prompt_id: record.prompt.id, writer_id: record.writer_id,
    state: 'queued', created_at: record.created_at, uploaded_at: null, verified_at: null,
    preview_at: null, requeues: 0, record,
  };
  return open().then((db) => new Promise((resolve, reject) => {
    // 'strict' durability where supported: the line must survive a crash right after.
    let t;
    try { t = db.transaction('lines', 'readwrite', { durability: 'strict' }); }
    catch (_) { t = db.transaction('lines', 'readwrite'); }
    t.objectStore('lines').put(entry);
    t.oncomplete = () => resolve(entry);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  }));
}

const byCreated = (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0);

export function allLines() {
  return tx('lines', 'readonly', (s) => req2p(s.getAll()));
}

export async function queuedLines() {
  const all = await tx('lines', 'readonly', (s) => req2p(s.index('state').getAll('queued')));
  return all.sort(byCreated);
}

export function countQueued() {
  return tx('lines', 'readonly', (s) => req2p(s.index('state').count('queued')));
}

/** Lines whose commit answered 2xx or that were seen in a listing (states sent + verified). */
export async function uploadedLines() {
  const all = await allLines();
  return all.filter((e) => UPLOADED.includes(e.state)).sort(byCreated);
}

/** The commit for these lines answered 2xx: 'sent' (not yet 'verified'). user: the
 *  account the lines went to (only that account's listing can verify them). */
export function markSent(ids, user = null) {
  const now = new Date().toISOString();
  return tx('lines', 'readwrite', async (s) => {
    for (const id of ids) {
      const e = await req2p(s.get(id));
      if (e && e.state === 'queued') { e.state = 'sent'; e.uploaded_at = now; e.uploaded_to = user; s.put(e); }
    }
  });
}
export const markUploaded = markSent;

/** These lines were seen in a listing of the dataset. */
export function markVerified(ids) {
  const now = new Date().toISOString();
  return tx('lines', 'readwrite', async (s) => {
    for (const id of ids) {
      const e = await req2p(s.get(id));
      if (e && UPLOADED.includes(e.state)) {
        if (e.state !== 'verified') { e.state = 'verified'; e.verified_at = now; }
        s.put(e);
      }
    }
  });
}

/** A complete listing does not have these files: back into the queue (the preview too). */
export function requeue(ids) {
  return tx('lines', 'readwrite', async (s) => {
    for (const id of ids) {
      const e = await req2p(s.get(id));
      if (e && UPLOADED.includes(e.state)) {
        e.state = 'queued'; e.verified_at = null; e.preview_at = null;
        e.requeues = (e.requeues || 0) + 1;
        s.put(e);
      }
    }
  });
}

/** Uploaded lines that have no Dataset Viewer preview yet, oldest first. */
export async function previewPending() {
  return (await uploadedLines()).filter((e) => !e.preview_at);
}

/** The preview of these lines was committed (or, skip=true, cannot be made: no ink). */
export function markPreviewed(ids, { skip = false } = {}) {
  const now = new Date().toISOString();
  return tx('lines', 'readwrite', async (s) => {
    for (const id of ids) {
      const e = await req2p(s.get(id));
      if (e) { e.preview_at = now; e.preview_skipped = skip; s.put(e); }
    }
  });
}

/** Number of lines per state: {queued, sent, verified, rejected, deleted, total}.
 *  total leaves the deleted lines (tombstones) out. */
export function counts() {
  return tx('lines', 'readonly', async (s) => {
    const idx = s.index('state');
    const out = {};
    for (const st of ['queued', 'sent', 'verified', 'rejected', DELETED]) out[st] = await req2p(idx.count(st));
    out.total = (await req2p(s.count())) - out[DELETED];
    return out;
  });
}

/** created_at of the oldest queued line, or null. */
export async function oldestQueuedAt() {
  const q = await queuedLines();
  return q.length ? q[0].created_at : null;
}

/** A line the server refused for its content: kept on the device (and in the backup), not retried. */
export function markRejected(id, why) {
  return tx('lines', 'readwrite', async (s) => {
    const e = await req2p(s.get(id));
    if (e && e.state === 'queued') { e.state = 'rejected'; e.rejected = Object.assign({ at: new Date().toISOString() }, why); s.put(e); }
  });
}

export function countState(state) {
  return tx('lines', 'readonly', (s) => req2p(s.index('state').count(state)));
}

/** Throws when IndexedDB cannot be used here (private window, blocked storage). */
export async function check() {
  await open();
  await kvGet('firstRunDone', false);
}

export function kvGet(key, fallback = null) {
  return tx('kv', 'readonly', (s) => req2p(s.get(key))).then((v) => (v === undefined ? fallback : v));
}

export function kvSet(key, value) {
  return tx('kv', 'readwrite', (s) => { s.put(value, key); });
}

// ---------- "Meine Zeilen": correct the text, delete ----------

export function getLine(id) {
  return tx('lines', 'readonly', (s) => req2p(s.get(id))).then((e) => e || null);
}

/** The entries of these ids that are still queued (re-read right before an upload commit). */
export function stillQueued(ids) {
  return tx('lines', 'readonly', async (s) => {
    const out = [];
    for (const id of ids) {
      const e = await req2p(s.get(id));
      if (e && e.state === 'queued') out.push(e);
    }
    return out;
  });
}

/** Replace the record of a line (its text was corrected). The state is kept as it is
 *  (a verified line stays verified: the same path was overwritten); a tombstone is left alone. */
export function updateRecord(id, record) {
  return tx('lines', 'readwrite', async (s) => {
    const e = await req2p(s.get(id));
    if (!isLive(e) || record.id !== id) return false;
    e.record = record;
    s.put(e);
    return true;
  });
}

/** The line was removed from the dataset: keep the record, mark it as a tombstone. */
export function markDeleted(id, info = {}) {
  const now = new Date().toISOString();
  return tx('lines', 'readwrite', async (s) => {
    const e = await req2p(s.get(id));
    if (!e) return false;
    if (e.state !== DELETED) {
      e.deleted = Object.assign({ at: now, from_state: e.state }, info);
      e.state = DELETED;
      s.put(e);
    }
    return true;
  });
}

/** Local lines (not deleted) of one writer. */
export async function linesOf(writerId) {
  return (await allLines()).filter((e) => isLive(e) && e.writer_id === writerId);
}

/** All local lines as JSON Lines text (one hwline/v1 record per line). Deleted lines are
 *  left out: the writer removed them so that they are not trained on. */
export async function backupJsonl() {
  const all = (await allLines()).filter(isLive);
  all.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  return all.map((e) => JSON.stringify(e.record)).join('\n') + (all.length ? '\n' : '');
}

/** Ask the browser to keep our storage even under pressure. */
export async function requestPersist() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch (_) { return null; }
}
