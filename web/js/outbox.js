// Upload queue (SPEC 2.1). Lines are already in IndexedDB before they get here.
//
// Per line (store.js): queued -> sent (the commit answered 2xx) -> verified (the file was
// SEEN in a complete listing of raw/v1). Only 'verified' counts as safe. A complete
// listing without the file puts a sent/verified line back to queued, so it goes up
// again. A failed or partial listing changes nothing. Nothing is ever deleted.
//
// The Dataset Viewer preview (preview.js) goes up in a second, separate commit after
// the raw lines. It is best effort: a failure there never touches the line states,
// never re-queues raw lines, never delays raw uploads beyond one running request and
// is never shown to the writer as an error. It is retried later (entry.preview_at).
import * as store from './store.js';
import * as hf from './hf.js';
import * as preview from './preview.js';

const CFG = self.HW_CONFIG;
let running = false;
let again = false;
let retryTimer = null;
let backoffS = 0;
let notBefore = 0;
let lastError = null;   // {kind, status, at}
const listeners = new Set();

// verification
let verifying = null;   // promise of the check that is running
let lastCheck = null;   // {at, user, ...counts}: the last complete listing
let checkProblem = null; // {kind, at}: why the last check could not be done
let followTimer = null;
/** A line that is missing from a listing right after its commit is given this long
 *  (doubled for each earlier re-upload, so a server that keeps losing a file cannot
 *  make the app spin) before it is put back into the queue. */
const GRACE_MS = 10000;

// preview
let previewP = null;
let previewAgain = false;
let previewBackoffS = 0;
let previewNotBefore = 0;
let previewTimer = null;
let previewError = null;   // diagnostics only
const previewSkip = new Set();   // ids whose preview the server refused on its own: next start
/** A preview commit that takes longer than this is given up (and retried later), so it
 *  never holds back the raw lines waiting behind it. */
let previewTimeoutMs = 90000;
export function setPreviewTimeout(ms) { previewTimeoutMs = ms; }   // for the tests

export const status = () => ({
  running, lastError, notBefore,
  checking: !!verifying, lastCheck, checkProblem,
  previewRunning: !!previewP, previewError,
});
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(type, detail) { for (const fn of listeners) { try { fn(type, detail); } catch (_) {} } }

// One commit at a time (raw and preview share the branch); raw never waits for more
// than the single request that is already running.
let commitChain = Promise.resolve();
function locked(fn) {
  const p = commitChain.then(fn, fn);
  commitChain = p.catch(() => {});
  return p;
}

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
    await locked(() => hf.commit(repo, `Erfassung: ${n} ${n === 1 ? 'Zeile' : 'Zeilen'}`, files));
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
  await store.markSent(batch.map((e) => e.id), hf.userName());
  emit('uploaded', { ids: batch.map((e) => e.id), promptIds: batch.map((e) => e.prompt_id),
    done: batch.map((e) => ({ writer: e.record.writer_id, promptId: e.prompt_id })) });
  return null;
}

/**
 * reason: 'start' | 'line' | 'session-end' | 'online' | 'manual' | 'retry' | 'auth' | 'repo-created'
 *         | 'hidden' | 'reconcile'
 * 'line' uploads only when flushAt lines are waiting. A pending back-off is
 * respected except for explicit triggers (online, manual, auth, repo-created, start, hidden).
 */
export async function flush(reason = 'manual') {
  if (running) { again = true; return; }
  const explicit = ['online', 'manual', 'auth', 'repo-created', 'start', 'hidden'].includes(reason);
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
    if (uploadedAny) {
      // Second, separate step for the preview; and look whether the lines really arrived.
      previews('flush');
      verify('flush');
    }
  }
}

// ---------- verification ----------

const graceFor = (e) => GRACE_MS * 2 ** Math.min(e.requeues || 0, 6);
/** Lines uploaded under another account are not this listing's business. */
const mine = (e, user) => !e.uploaded_to || e.uploaded_to === user;

/**
 * List raw/v1 once (the same listing gives the progress, event 'listed') and compare
 * it with every local line of every writer that is sent or verified. Returns
 * {ok:true, verified, requeued} or {ok:false, kind}. Calls while one runs share it.
 */
export function verify(reason = 'manual') {
  if (verifying) return verifying;
  const p = (async () => {
    await null;
    try { return await runVerify(reason); }
    catch (e) { checkProblem = { kind: 'other', at: Date.now() }; return { ok: false, kind: 'other' }; }
    finally { verifying = null; emit('state'); }
  })();
  verifying = p;
  emit('state');
  return p;
}

async function runVerify(reason) {
  if (!hf.getAuth()) { checkProblem = { kind: 'signed-out', at: Date.now() }; return { ok: false, kind: 'signed-out' }; }
  if (navigator.onLine === false) { checkProblem = { kind: 'offline', at: Date.now() }; return { ok: false, kind: 'offline' }; }
  const repo = hf.datasetRepoId();
  const user = hf.userName();
  const started = Date.now();
  let paths;
  try {
    paths = await hf.listTree(repo, 'raw/v1');
  } catch (e) {
    let kind = e.kind || 'other';
    if (kind === 'auth') {
      kind = await hf.classify401(e);
      if (kind === 'auth') { hf.signOut(); emit('auth-required'); }
    }
    checkProblem = { kind, at: Date.now() };
    return { ok: false, kind };
  }
  if (hf.userName() !== user) return { ok: false, kind: 'changed' };   // account changed meanwhile
  const have = new Set(paths);
  const local = (await store.uploadedLines()).filter((e) => mine(e, user));
  const seen = []; const missing = []; const young = [];
  for (const e of local) {
    if (have.has(e.path)) { if (e.state !== 'verified') seen.push(e.id); continue; }
    const sentAt = Date.parse(e.uploaded_at) || 0;
    if (started - sentAt >= graceFor(e)) missing.push(e.id);
    else young.push(sentAt + graceFor(e) - started);
  }
  if (seen.length) await store.markVerified(seen);
  if (missing.length) await store.requeue(missing);
  lastCheck = { at: Date.now(), user, files: paths.length, verified: seen.length, requeued: missing.length };
  checkProblem = null;
  store.kvSet('lastCheck', lastCheck).catch(() => {});
  emit('listed', { paths, user });
  emit('checked', { verified: seen.length, requeued: missing.length, reason });
  if (missing.length) setTimeout(() => flush(reason === 'manual' ? 'manual' : 'reconcile'), 0);
  clearTimeout(followTimer);
  // Lines sent a moment ago and not listed yet: one more look once their grace is over.
  if (young.length) followTimer = setTimeout(() => verify('followup'), Math.max(2000, Math.min(...young) + 500));
  return { ok: true, verified: seen.length, requeued: missing.length };
}

/** "Jetzt prüfen": check now; lines that wait are uploaded first. */
export async function checkNow() {
  if ((await store.countQueued().catch(() => 0)) > 0 && hf.getAuth()) await flush('manual');
  const r = await verify('manual');
  previews('manual');
  return r;
}

// ---------- preview (best effort) ----------

/** Write missing previews. Never throws, never changes line states, never shows an error. */
const PREVIEW_NOW = ['start', 'manual', 'online'];   // these do not wait for a back-off

export function previews(reason = 'flush') {
  if (previewP) {
    // Run once more afterwards; an explicit trigger keeps its right to skip the back-off.
    if (!previewAgain || PREVIEW_NOW.includes(reason)) previewAgain = reason;
    return previewP;
  }
  previewP = (async () => {
    try {
      let r = reason;
      for (;;) {
        previewAgain = false;
        await runPreviews(r);
        if (!previewAgain) break;
        r = previewAgain;
      }
    } catch (e) {
      previewError = { kind: 'internal', message: String(e && e.message || e).slice(0, 200), at: Date.now() };
    } finally { previewP = null; emit('state'); }
  })();
  return previewP;
}

async function runPreviews(reason) {
  if (!hf.getAuth()) return;
  if (!PREVIEW_NOW.includes(reason) && Date.now() < previewNotBefore) return;
  const user = hf.userName();
  for (;;) {
    // Raw lines first: while lines wait, their upload comes before any preview.
    if ((await store.countQueued()) > 0) return;
    const repo = hf.datasetRepoId();
    if (!repo || hf.userName() !== user) return;
    const pending = (await store.previewPending()).filter((e) => !previewSkip.has(e.id) && mine(e, user));
    if (!pending.length) { previewError = null; return; }
    const e = await previewUpload(repo, pending.slice(0, CFG.maxPerCommit), user);
    if (!e) { previewBackoffS = 0; previewNotBefore = 0; continue; }
    previewError = { kind: e.kind || 'other', status: e.status || 0, at: Date.now() };
    previewBackoffS = Math.min(3600, Math.max(30, previewBackoffS * 2));
    if (e.retryAfterS) previewBackoffS = Math.max(previewBackoffS, e.retryAfterS);
    previewNotBefore = Date.now() + previewBackoffS * 1000;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => previews('retry'), previewBackoffS * 1000);
    return;
  }
}

/** Entries of a session that belong in its metadata.jsonl: uploaded lines whose image
 *  exists already or goes up in this commit. */
function sessionEntriesFor(batchIds, user) {
  return async (writerId, sessionId) => (await store.uploadedLines()).filter((e) =>
    e.record.writer_id === writerId && e.record.session_id === sessionId && mine(e, user)
    && ((e.preview_at && !e.preview_skipped) || batchIds.has(e.id)));
}

async function previewUpload(repo, batch, user) {
  const n = batch.length;
  const half = Math.ceil(n / 2);
  let built;
  try {
    built = await preview.buildFiles(batch, sessionEntriesFor(new Set(batch.map((e) => e.id)), user));
  } catch (err) {
    // A line that cannot be drawn here: leave it for the next start (or the Python script).
    if (n === 1) { previewSkip.add(batch[0].id); return null; }
    return (await previewUpload(repo, batch.slice(0, half), user)) || (await previewUpload(repo, batch.slice(half), user));
  }
  if (built.skipped.length) await store.markPreviewed(built.skipped, { skip: true });
  const ids = batch.map((e) => e.id).filter((id) => !built.skipped.includes(id));
  if (!ids.length) return null;
  try {
    await locked(async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), previewTimeoutMs);
      try { await hf.commit(repo, `Vorschau: ${ids.length} ${ids.length === 1 ? 'Zeile' : 'Zeilen'}`, built.files, { signal: ac.signal }); }
      finally { clearTimeout(timer); }
    });
  } catch (e) {
    if (!deterministic(e)) return e;          // 5xx, 401, network, rate: later
    if (n === 1) { previewSkip.add(batch[0].id); return null; }
    return (await previewUpload(repo, batch.slice(0, half), user)) || (await previewUpload(repo, batch.slice(half), user));
  }
  await store.markPreviewed(ids);
  emit('preview', { ids });
  return null;
}

// ---------- triggers ----------

/** At app start: upload what waits, write missing previews, check what is there. */
export function startup() {
  flush('start');
  previews('start');
  return verify('start');
}

async function flushIfWaiting() {
  try {
    if (hf.getAuth() && (await store.countQueued()) > 0) flush('hidden');
  } catch (_) {}
}

export function install() {
  window.addEventListener('online', () => { flush('online'); previews('online'); verify('online'); });
  window.addEventListener('offline', () => emit('state'));
  // Best effort when the app goes to the background or is closed: the lines are in IndexedDB anyway.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushIfWaiting(); });
  window.addEventListener('pagehide', flushIfWaiting);
  store.kvGet('lastCheck', null).then((v) => { if (!lastCheck && v && v.at) { lastCheck = v; emit('state'); } }).catch(() => {});
}
