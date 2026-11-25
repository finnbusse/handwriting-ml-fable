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
  try {
    for (;;) {
      const queued = await store.queuedLines();
      if (!queued.length) break;
      const repo = hf.datasetRepoId();
      if (!repo) break;
      const batch = queued.slice(0, CFG.maxPerCommit);
      const n = batch.length;
      const files = batch.map((e) => ({ path: e.path, text: JSON.stringify(e.record) }));
      try {
        await hf.commit(repo, `Erfassung: ${n} ${n === 1 ? 'Zeile' : 'Zeilen'}`, files);
      } catch (e) {
        lastError = { kind: e.kind || 'other', status: e.status || 0, at: Date.now() };
        if (e.kind === 'auth') { hf.signOut(); emit('auth-required'); }
        else if (e.kind === 'notfound') emit('repo-missing');
        else if (e.kind === 'forbidden') emit('forbidden');
        else {
          backoffS = e.kind === 'rate' ? Math.max(e.retryAfterS || 60, 1)
            : Math.min(600, Math.max(30, backoffS * 2));
          scheduleRetry(backoffS);
        }
        break;
      }
      await store.markUploaded(batch.map((e) => e.id));
      lastError = null; backoffS = 0; notBefore = 0; clearTimeout(retryTimer);
      emit('uploaded', { ids: batch.map((e) => e.id), promptIds: batch.map((e) => e.prompt_id) });
    }
  } finally {
    running = false;
    emit('state');
    if (again) { again = false; setTimeout(() => flush('session-end'), 0); }
  }
}

export function install() {
  window.addEventListener('online', () => flush('online'));
}
