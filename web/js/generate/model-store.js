// The trained model of the signed-in account: download, check, keep on the device.
//
// Where it lives: <user>/<modelRepo> (private) holds model.json (small manifest with
// sha256, bytes, charset ...) and model.bin (the weights), optionally trained_on.json.
//
// Cache: IndexedDB (the app's own "kv" store), not Cache Storage.  Reasons: manifest
// and weights are written in ONE put, so the cache can never hold a mismatched pair;
// it is the same storage the app already asks the browser to keep (persist()); and
// the service worker stays out of it completely (it never touches model files).
//
// A new model replaces the cached one only after its SHA-256 matched the manifest.
// Without a connection (or signed out) the cached model is used.

import * as defaultStore from '../store.js';
import * as defaultHf from '../hf.js';

const KEY = 'model';          // { user, manifest, buffer }
const META_KEY = 'modelMeta'; // { sha, trainedOn }: what trained_on.json said (optional, not critical)

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

export function createModelStore({ store = defaultStore, hf = defaultHf, fileTimeoutMs = 30000, quickTimeoutMs = 8000, idleMs = 30000 } = {}) {

  /** The cached model, or null (also when it is damaged). */
  async function readCache() {
    try {
      const e = await store.kvGet(KEY, null);
      if (!e || !e.manifest || !(e.buffer instanceof ArrayBuffer) || e.buffer.byteLength !== e.manifest.bytes) return null;
      if ((await sha256Hex(e.buffer)) !== String(e.manifest.sha256).toLowerCase()) return null;
      return e;
    } catch (_) { return null; }
  }

  async function readMeta(sha) {
    try {
      const m = await store.kvGet(META_KEY, null);
      return m && m.sha === sha ? m.trainedOn || null : null;
    } catch (_) { return null; }
  }

  /** The cached model if this device may use it right now: signed out, or cached for this very account. */
  async function usableCache() {
    const e = await readCache();
    if (!e) return null;
    const user = hf.userName();
    if (user && e.user !== user) return null;
    return { entry: e, trainedOn: await readMeta(e.manifest.sha256) };
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

  async function getTrainedOn(repo, signal) {
    try {
      const j = await getJson(repo, 'trained_on.json', 6000, signal);
      return j && typeof j === 'object' ? j : null;
    } catch (_) { return null; }      // optional file: 404 and everything else is fine
  }

  async function downloadBin(repo, manifest, onProgress, signal) {
    const total = manifest.bytes;
    const g = await get(repo, 'model.bin', fileTimeoutMs, signal);
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
   * Look at the account's model repo and, if its model differs from the cached one,
   * download it, verify it and replace the cache.
   * Resolves { entry: {user, manifest, buffer}, trainedOn, changed } or throws ModelError.
   * onStage('downloading', {total} | 'verifying'), onProgress(loadedBytes, totalBytes).
   */
  async function sync({ onStage, onProgress, signal } = {}) {
    const user = hf.userName();
    if (!user) throw new ModelError('signin');
    const repo = hf.modelRepoId();
    const cached = await readCache();
    const mine = cached && cached.user === user ? cached : null;
    const manifest = checkManifest(await getJson(repo, 'model.json', mine ? quickTimeoutMs : fileTimeoutMs, signal));
    const sha = manifest.sha256.toLowerCase();
    if (mine && String(mine.manifest.sha256).toLowerCase() === sha) {
      let trainedOn = await readMeta(sha);
      if (!trainedOn) {
        trainedOn = await getTrainedOn(repo, signal);
        if (trainedOn) { try { await store.kvSet(META_KEY, { sha, trainedOn }); } catch (_) {} }
      }
      return { entry: mine, trainedOn, changed: false };
    }
    if (onStage) onStage('downloading', { total: manifest.bytes });
    const buffer = await downloadBin(repo, manifest, onProgress, signal);
    if (onStage) onStage('verifying');
    if ((await sha256Hex(buffer)) !== sha) throw new ModelError('checksum', 'sha256 differs from model.json');
    const trainedOn = await getTrainedOn(repo, signal);
    const entry = { user, manifest, buffer };
    await store.kvSet(KEY, entry);                       // manifest + weights in one write
    try { await store.kvSet(META_KEY, { sha, trainedOn }); } catch (_) {}
    return { entry, trainedOn, changed: true };
  }

  /** For the settings page: what is on the device. */
  async function info() {
    const e = await readCache();
    if (!e) return null;
    return { user: e.user, sha256: e.manifest.sha256, bytes: e.manifest.bytes, trainedOn: await readMeta(e.manifest.sha256) };
  }

  return { sync, usableCache, info };
}
