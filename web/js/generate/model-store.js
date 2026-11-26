// The trained models of the signed-in account: download, check, keep on the device.
//
// Where they live: <user>/<modelRepo> (private).  Every published model is its own
// version, models/<id>/ with model.json (manifest: sha256, bytes, charset ...),
// model.bin (the weights) and trained_on.json, listed in models/index.json (newest
// first; see hw/models.py).  The repo root holds a copy of the newest, and is all
// there is in an older repo without an index: then the root model is used, as before.
//
// Which version: "newest" (the default) is the newest model of the current writer, or
// the newest of all when that writer has none; it follows new models by itself.  Or a
// version chosen by its id; when that one is gone, the newest is used and the caller
// is told (fallback).
//
// Cache: IndexedDB (the app's own "kv" store), not Cache Storage.  Manifest and weights
// go into ONE put, so a slot never holds a mismatched pair.  There are three fixed slots
// ("model", "model.2", "model.3"); a new model overwrites the least recently used one,
// so the cache stays bounded without ever deleting from IndexedDB.  A model replaces a
// slot only after its SHA-256 matched the manifest.  Without a connection (or signed
// out) a cached model is used.

import * as defaultStore from '../store.js';
import * as defaultHf from '../hf.js';

export const SLOTS = ['model', 'model.2', 'model.3'];
const TABLE = 'modelSlots';    // { [slot]: { sha, user, versionId, usedAt } }
const META_KEY = 'modelMeta';  // { sha, trainedOn }: what trained_on.json said for the old single slot
const INDEX = 'models/index.json';

/** kind: 'signin' | 'nomodel' | 'auth' | 'network' | 'server' | 'checksum' | 'cancelled' */
export class ModelError extends Error {
  constructor(kind, message) { super(message || kind); this.kind = kind; }
}

export async function sha256Hex(buffer) {
  if (!(globalThis.crypto && crypto.subtle)) throw new ModelError('server', 'crypto.subtle not available');
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

function checkManifest(m) {
  const ok = m && typeof m === 'object' && m.format === 1 && typeof m.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(m.sha256)
    && Number.isInteger(m.bytes) && m.bytes > 0 && Array.isArray(m.tensors) && typeof m.charset === 'string';
  if (!ok) throw new ModelError('server', 'unusable model.json');
  return m;
}

/** The usable entries of models/index.json (newest first), or null. */
export function readIndex(j) {
  if (!j || typeof j !== 'object' || j.format !== 1 || !Array.isArray(j.models)) return null;
  const models = j.models.filter((m) => m && typeof m.id === 'string' && typeof m.path === 'string' && /^models\/[^/]+$/.test(m.path));
  models.sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')) || b.id.localeCompare(a.id));
  return models.length ? { models } : null;
}

/** "newest": the current writer's newest, else the newest of all. */
export function newestFor(index, writer) {
  return (writer && index.models.find((m) => m.writer === writer)) || index.models[0];
}

export function createModelStore({ store = defaultStore, hf = defaultHf, fileTimeoutMs = 30000, quickTimeoutMs = 8000, idleMs = 30000 } = {}) {

  async function table() {
    try { const t = await store.kvGet(TABLE, null); return t && typeof t === 'object' ? t : {}; } catch (_) { return {}; }
  }

  /** The entry in a slot, or null (also when it is damaged). */
  async function readSlot(slot) {
    try {
      const e = await store.kvGet(slot, null);
      if (!e || !e.manifest || !(e.buffer instanceof ArrayBuffer) || e.buffer.byteLength !== e.manifest.bytes) return null;
      if ((await sha256Hex(e.buffer)) !== String(e.manifest.sha256).toLowerCase()) return null;
      if (e.trainedOn === undefined && slot === SLOTS[0]) {             // written by an older app version
        const m = await store.kvGet(META_KEY, null).catch(() => null);
        e.trainedOn = m && m.sha === e.manifest.sha256 ? m.trainedOn || null : null;
      }
      return e;
    } catch (_) { return null; }
  }

  async function touch(slot, entry) {
    const t = await table();
    t[slot] = { sha: String(entry.manifest.sha256).toLowerCase(), user: entry.user, versionId: entry.version ? entry.version.id : null, usedAt: Date.now() };
    try { await store.kvSet(TABLE, t); } catch (_) {}
  }

  /** Slots of this account (any account when signed out), most recently used first. */
  async function slotsFor(user) {
    const t = await table();
    const known = SLOTS.filter((s) => t[s] && (!user || t[s].user === user)).sort((a, b) => t[b].usedAt - t[a].usedAt);
    if (!t[SLOTS[0]]) known.push(SLOTS[0]);                             // the single slot of older app versions
    return { t, known };
  }

  async function findBySha(user, sha) {
    const { t, known } = await slotsFor(user);
    for (const s of known) {
      if (t[s] && t[s].sha !== sha) continue;
      const e = await readSlot(s);
      if (e && String(e.manifest.sha256).toLowerCase() === sha && (!user || e.user === user)) return { slot: s, entry: e };
    }
    return null;
  }

  /** A new model goes into a free slot, else over the least recently used one. */
  async function put(entry) {
    const t = await table();
    const sha = String(entry.manifest.sha256).toLowerCase();
    const slot = SLOTS.find((s) => t[s] && t[s].sha === sha)
      || SLOTS.find((s) => !t[s])
      || SLOTS.slice().sort((a, b) => t[a].usedAt - t[b].usedAt)[0];
    await store.kvSet(slot, entry);                                    // manifest + weights in one write
    await touch(slot, entry);
    return slot;
  }

  /**
   * A cached model this device may use right now (signed out, or cached for this very
   * account): the chosen version when it is here, else the one used last.
   */
  async function usableCache(choice = 'newest') {
    const user = hf.userName();
    const { t, known } = await slotsFor(user);
    const pref = choice !== 'newest' ? known.filter((s) => t[s] && t[s].versionId === choice) : [];
    const order = pref.concat(known.filter((s) => !pref.includes(s)));
    for (const s of order) {
      const e = await readSlot(s);
      if (e && (!user || e.user === user)) return { entry: e, trainedOn: e.trainedOn || null, version: e.version || null };
    }
    return null;
  }

  // Maps a Hugging Face failure to a ModelError.
  async function translate(e, timedOut) {
    if (e instanceof ModelError) return e;
    const kind = e && e.kind;
    if (kind === 'cancelled') return new ModelError(timedOut ? 'network' : 'cancelled');
    if (kind === 'network') return new ModelError('network');
    if (kind === 'notfound') return new ModelError('nomodel');
    if (kind === 'forbidden') return new ModelError('auth');
    if (kind === 'auth') {
      // The Hub also answers 401 for a repo that does not exist: ask whoami which of the two it is.
      const why = await hf.classify401().catch(() => 'network');
      return new ModelError(why === 'auth' ? 'auth' : why === 'notfound' ? 'nomodel' : 'network');
    }
    return new ModelError('server', String((e && e.message) || e));
  }

  // fetch with a timeout for the answer's headers; `signal` (optional) cancels from outside.
  async function get(repo, file, ms, signal) {
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms);
    const outer = () => ctl.abort();
    if (signal) signal.addEventListener('abort', outer);
    try {
      const res = await hf.downloadFile(repo, file, { signal: ctl.signal });
      clearTimeout(timer);
      return { res, ctl, flags: () => timedOut, done: () => { if (signal) signal.removeEventListener('abort', outer); } };
    } catch (e) {
      clearTimeout(timer); if (signal) signal.removeEventListener('abort', outer);
      throw await translate(e, timedOut);
    }
  }

  async function getJson(repo, file, ms, signal) {
    const g = await get(repo, file, ms, signal);
    try { return await g.res.json(); }
    catch (e) { throw await translate(e instanceof SyntaxError ? new ModelError('server', 'bad json') : e, g.flags()); }
    finally { g.done(); }
  }

  async function getOptionalJson(repo, file, signal) {
    try {
      const j = await getJson(repo, file, 6000, signal);
      return j && typeof j === 'object' ? j : null;
    } catch (_) { return null; }      // optional file: 404 and everything else is fine
  }

  /** models/index.json, or null when the repo has none (an older repo: the root model is used). */
  async function getIndex(repo, signal) {
    try { return readIndex(await getJson(repo, INDEX, quickTimeoutMs, signal)); }
    catch (e) { if (e.kind === 'nomodel' || e.kind === 'server') return null; throw e; }
  }

  async function downloadBin(repo, file, manifest, onProgress, signal) {
    const total = manifest.bytes;
    const g = await get(repo, file, fileTimeoutMs, signal);
    let idle = null, idleHit = false;
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => { idleHit = true; g.ctl.abort(); }, idleMs); };
    try {
      const out = new Uint8Array(total);
      let loaded = 0;
      if (onProgress) onProgress(0, total);
      if (g.res.body && g.res.body.getReader) {
        const reader = g.res.body.getReader();
        arm();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          arm();
          if (loaded + value.length > total) throw new ModelError('checksum', 'model.bin is larger than announced');
          out.set(value, loaded);
          loaded += value.length;
          if (onProgress) onProgress(loaded, total);
        }
      } else {
        const all = new Uint8Array(await g.res.arrayBuffer());
        if (all.length > total) throw new ModelError('checksum', 'model.bin is larger than announced');
        out.set(all, 0); loaded = all.length;
        if (onProgress) onProgress(loaded, total);
      }
      if (loaded !== total) throw new ModelError('checksum', 'model.bin is smaller than announced');
      return out.buffer;
    } catch (e) {
      throw await translate(e, idleHit || g.flags());
    } finally { clearTimeout(idle); g.done(); }
  }

  /**
   * Look at the account's model repo, pick the version (`choice`: 'newest' or an id;
   * `writer`: the current writer's id, for 'newest') and make sure it is on the device:
   * from the cache when its checksum is there, else downloaded, verified and cached.
   * Resolves { entry: {user, manifest, buffer, trainedOn, version}, trainedOn, version,
   * index, fallback, changed } or throws ModelError.  `changed`: it was downloaded now.
   * onStage('downloading', {total} | 'verifying'), onProgress(loadedBytes, totalBytes).
   */
  async function sync({ choice = 'newest', writer = null, onStage, onProgress, signal } = {}) {
    const user = hf.userName();
    if (!user) throw new ModelError('signin');
    const repo = hf.modelRepoId();
    const index = await getIndex(repo, signal);
    let version = null, fallback = false;
    if (index) {
      if (choice && choice !== 'newest') {
        version = index.models.find((m) => m.id === choice) || null;
        fallback = !version;
      }
      version = version || newestFor(index, writer);
    }
    const base = version ? `${version.path}/` : '';
    const { t, known } = await slotsFor(user);
    const anyCached = known.some((s) => t[s]);
    const manifest = checkManifest(await getJson(repo, `${base}model.json`, anyCached ? quickTimeoutMs : fileTimeoutMs, signal));
    const sha = manifest.sha256.toLowerCase();
    const hit = await findBySha(user, sha);
    if (hit) {
      const e = hit.entry;
      let trainedOn = e.trainedOn || null;
      if (!trainedOn) trainedOn = await getOptionalJson(repo, `${base}trained_on.json`, signal);
      if ((version && (!e.version || e.version.id !== version.id)) || trainedOn !== e.trainedOn) {
        Object.assign(e, { trainedOn, version });
        try { await store.kvSet(hit.slot, e); } catch (_) {}
      }
      await touch(hit.slot, e);
      return { entry: e, trainedOn, version, index, fallback, changed: false };
    }
    if (onStage) onStage('downloading', { total: manifest.bytes });
    const buffer = await downloadBin(repo, `${base}model.bin`, manifest, onProgress, signal);
    if (onStage) onStage('verifying');
    if ((await sha256Hex(buffer)) !== sha) throw new ModelError('checksum', 'sha256 differs from model.json');
    const trainedOn = await getOptionalJson(repo, `${base}trained_on.json`, signal);
    const entry = { user, manifest, buffer, trainedOn, version };
    await put(entry);
    return { entry, trainedOn, version, index, fallback, changed: true };
  }

  /** For the settings page: the model used last on this device. */
  async function info() {
    const c = await usableCache();
    if (!c) return null;
    const e = c.entry;
    return { user: e.user, sha256: e.manifest.sha256, bytes: e.manifest.bytes, trainedOn: c.trainedOn, version: c.version };
  }

  /** The repo's list of versions (for the "Modell" choice), or null. */
  async function index({ signal } = {}) {
    if (!hf.userName()) return null;
    return getIndex(hf.modelRepoId(), signal);
  }

  return { sync, usableCache, info, index };
}
