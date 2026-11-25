// IndexedDB: recorded lines (outbox + local archive) and small key/value state.
// Lines are never deleted by the app: after a successful upload they are only
// marked 'uploaded', so "Sicherung herunterladen" always has everything.

const DB_NAME = 'handschrift';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('lines')) {
        const s = db.createObjectStore('lines', { keyPath: 'id' });
        s.createIndex('state', 'state');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
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

/** Path of a line inside the dataset. The prompt id is part of the file name
 *  so progress can be restored from a file listing alone (no downloads). */
export function linePath(record) {
  return `raw/v1/${record.session_id}/${record.prompt.id}__${record.id}.json`;
}

/** Inverse of linePath: prompt id from a dataset path, or null. */
export function promptIdFromPath(path) {
  const m = /^raw\/v1\/[^/]+\/(.+)__[0-9a-fA-F-]{36}\.json$/.exec(path);
  return m ? m[1] : null;
}

/** Store an accepted line. Resolves only once the transaction is durable. */
export function putLine(record) {
  const entry = {
    id: record.id, path: linePath(record), prompt_id: record.prompt.id,
    state: 'queued', created_at: record.created_at, uploaded_at: null, record,
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

export function allLines() {
  return tx('lines', 'readonly', (s) => req2p(s.getAll()));
}

export async function queuedLines() {
  const all = await tx('lines', 'readonly', (s) => req2p(s.index('state').getAll('queued')));
  return all.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
}

export function countQueued() {
  return tx('lines', 'readonly', (s) => req2p(s.index('state').count('queued')));
}

export function markUploaded(ids) {
  const now = new Date().toISOString();
  return tx('lines', 'readwrite', async (s) => {
    for (const id of ids) {
      const e = await req2p(s.get(id));
      if (e) { e.state = 'uploaded'; e.uploaded_at = now; s.put(e); }
    }
  });
}

export function kvGet(key, fallback = null) {
  return tx('kv', 'readonly', (s) => req2p(s.get(key))).then((v) => (v === undefined ? fallback : v));
}

export function kvSet(key, value) {
  return tx('kv', 'readwrite', (s) => { s.put(value, key); });
}

/** All local lines as JSON Lines text (one hwline/v1 record per line). */
export async function backupJsonl() {
  const all = await allLines();
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
