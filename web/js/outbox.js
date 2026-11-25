// Upload queue (SPEC 2.1). Lines are already in IndexedDB before they get here;
// they leave the outbox only after a 2xx answer to the commit.
import * as store from './store.js';
import * as hf from './hf.js';

const CFG = self.HW_CONFIG;
let running = false;
let again = false;
let retryTimer = null;
let backoffS = 0;
let notBefore = 0;
let lastError = null;   // {kind, status, at}
const listeners = new Set();

export const status = () => ({ running, lastError, notBefore });
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(type, detail) { for (const fn of listeners) { try { fn(type, detail); } catch (_) {} } }

function scheduleRetry(seconds) {
  clearTimeout(retryTimer);
  notBefore = Date.now() + seconds * 1000;
  retryTimer = setTimeout(() => flush('retry'), seconds * 1000);
}

/** 4xx answers that say "this content is refused" rather than "try again later". */
const deterministic = (e) => e.kind === 'other' && e.status >= 400 && e.status < 500
  && ![408, 409, 412, 425].includes(e.status);

/**
 * Commit one batch. A batch the server refuses as such (400/413/422 ...) is split
 * in halves down to single lines, so one bad line cannot block the others; that
 * line is marked 'rejected' (it stays on the device and in the backup).
 * Returns null on success, or the error that stopped the upload.
 */
async function upload(repo, batch) {
  const n = batch.length;
  const files = batch.map((e) => ({ path: e.path, text: JSON.stringify(e.record) }));
  try {
    await hf.commit(repo, `Erfassung: ${n} ${n === 1 ? 'Zeile' : 'Zeilen'}`, files);
  } catch (e) {
    if (!deterministic(e)) return e;
    if (n === 1) {
      await store.markRejected(batch[0].id, { status: e.status, message: String(e.message || '').slice(0, 300) });
      emit('rejected', { ids: [batch[0].id] });
      return null;
    }
    const half = Math.ceil(n / 2);
    return (await upload(repo, batch.slice(0, half))) || (await upload(repo, batch.slice(half)));
  }
  await store.markUploaded(batch.map((e) => e.id));
  emit('uploaded', { ids: batch.map((e) => e.id), promptIds: batch.map((e) => e.prompt_id) });
  return null;
}

/**
 * reason: 'start' | 'line' | 'session-end' | 'online' | 'manual' | 'retry' | 'auth' | 'repo-created'
 * 'line' uploads only when flushAt lines are waiting. A pending back-off is
 * respected except for explicit triggers (online, manual, auth, repo-created).
 */
export async function flush(reason = 'manual') {
  if (running) { again = true; return; }
  const explicit = ['online', 'manual', 'auth', 'repo-created', 'start'].includes(reason);
  if (!explicit && Date.now() < notBefore) return;
  if (!hf.getAuth()) { emit('state'); return; }
  if (reason === 'line' && (await store.countQueued()) < CFG.flushAt) { emit('state'); return; }
  running = true; again = false; emit('state');
  let uploadedAny = false;
  try {
    for (;;) {
      const queued = await store.queuedLines();
      if (!queued.length) break;
      const repo = hf.datasetRepoId();
      if (!repo) break;
      const e = await upload(repo, queued.slice(0, CFG.maxPerCommit));
      if (!e) { uploadedAny = true; lastError = null; backoffS = 0; notBefore = 0; clearTimeout(retryTimer); continue; }
      let kind = e.kind || 'other';
      // A 401 can mean "no such repo for you"; only a failing whoami means the sign-in is bad.
      if (kind === 'auth') kind = await hf.classify401(e);
      lastError = { kind, status: e.status || 0, at: Date.now() };
      if (kind === 'auth') { hf.signOut(); emit('auth-required'); }
      else if (kind === 'notfound') emit('repo-missing', { reason });
      else if (kind === 'forbidden') emit('forbidden');
      else {
        backoffS = Math.min(600, Math.max(30, backoffS * 2));
        if (kind === 'rate') backoffS = Math.max(e.retryAfterS || 60, 1);
        else if (e.retryAfterS) backoffS = Math.max(backoffS, e.retryAfterS);   // 5xx with Retry-After
        scheduleRetry(backoffS);
      }
      break;
    }
  } finally {
    running = false;
    if (uploadedAny && !lastError && (await store.countQueued().catch(() => 1)) === 0) emit('all-uploaded');
    emit('state');
    if (again) { again = false; setTimeout(() => flush('session-end'), 0); }
  }
}

export function install() {
  window.addEventListener('online', () => flush('online'));
}
