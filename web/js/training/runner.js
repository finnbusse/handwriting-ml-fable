// The trainer Space (<user>/<trainerSpace>, see trainer/app.py): is it there, awake,
// whose is it; start and stop a run.  The Space can be asleep: then its own URL does
// not answer (no CORS headers on Hugging Face's waiting page), and the Hub API says
// what is going on instead.  The token goes to huggingface.co and to the user's own
// Space only.

export class RunnerError extends Error {
  /** kind: 'auth' | 'owner' | 'busy' | 'options' | 'idle' | 'network' | 'server' */
  constructor(kind, status, message) { super(message || kind); this.kind = kind; this.status = status; }
}

const STAGES = {
  SLEEPING: 'sleeping', STOPPED: 'sleeping', PAUSED: 'paused',
  BUILDING: 'starting', APP_STARTING: 'starting', RUNNING_BUILDING: 'starting', RUNNING_APP_STARTING: 'starting',
  RUNNING: 'starting',            // the Space runs, but the service did not answer (yet)
  BUILD_ERROR: 'broken', RUNTIME_ERROR: 'broken', CONFIG_ERROR: 'broken', NO_APP_FILE: 'broken', DELETING: 'broken',
};

export function createRunner({ hf, cfg = self.HW_CONFIG, timeoutMs = 8000 } = {}) {
  const user = () => hf.userName();
  const spaceId = () => (user() ? `${user()}/${cfg.trainerSpace}` : null);
  /** https://<user>-<space>.hf.space (lower case, anything else becomes "-") */
  const base = () => (user() ? `https://${`${user()}-${cfg.trainerSpace}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')}.hf.space` : null);
  const pageUrl = () => (spaceId() ? `${cfg.hfBase}/spaces/${spaceId()}` : null);
  const token = () => (hf.getAuth() || {}).token || null;

  async function call(url, { method = 'GET', body, auth = true, mode } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const headers = {};
    if (auth && token()) headers.Authorization = `Bearer ${token()}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store', credentials: 'omit', signal: ctl.signal, mode });
    } catch (_) {
      throw new RunnerError('network', 0);
    } finally { clearTimeout(timer); }
  }

  /** What the Hub says about the Space: 'missing' | 'sleeping' | 'paused' | 'starting' | 'broken' | 'offline' | 'auth'. */
  async function stage() {
    let res;
    try { res = await call(`${cfg.hfBase}/api/spaces/${spaceId()}`); } catch (_) { return { kind: 'offline' }; }
    if (res.status === 404) return { kind: 'missing' };
    if (res.status === 401) {
      const code = res.headers.get('x-error-code') || '';
      if (code === 'RepoNotFound') return { kind: 'missing' };
      const why = await hf.classify401().catch(() => 'network');
      return { kind: why === 'auth' ? 'auth' : why === 'notfound' ? 'missing' : 'offline' };
    }
    if (!res.ok) return { kind: 'offline' };
    let info = null;
    try { info = await res.json(); } catch (_) { return { kind: 'offline' }; }
    const st = String((info && info.runtime && info.runtime.stage) || '').toUpperCase();
    return { kind: STAGES[st] || 'starting', stage: st };
  }

  /**
   * Is the service there?  { kind: 'ok', data } with data = GET /status
   * ({running, owner, job, defaults, authorized}), or what the Hub says instead.
   */
  async function probe() {
    if (!user()) return { kind: 'signedout' };
    try {
      const res = await call(`${base()}/status`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.service === 'handschrift-training') return { kind: 'ok', data };
      }
    } catch (_) { /* asleep, not there, or offline: ask the Hub */ }
    return stage();
  }

  /** Visiting the Space wakes it; a no-cors GET is enough (and needs no CORS answer). */
  async function wake() {
    try { await call(`${base()}/`, { auth: false, mode: 'no-cors' }); } catch (_) {}
  }

  /** For a Space that stays asleep: the owner may restart it through the Hub API. */
  async function restart() {
    try { await call(`${cfg.hfBase}/api/spaces/${spaceId()}/restart`, { method: 'POST' }); } catch (_) {}
  }

  async function answer(res) {
    let j = null;
    try { j = await res.json(); } catch (_) {}
    if (res.ok) return j || {};
    const kind = (j && j.error) || (res.status === 401 ? 'auth' : res.status === 403 ? 'owner' : res.status === 409 ? 'busy' : res.status >= 500 ? 'server' : 'options');
    throw new RunnerError(kind, res.status, j && j.detail);
  }

  /** options: {epochs?, lines_only?, sample_every?, resume?}; resolves {ok, run_id, started}. */
  async function start(options) { return answer(await call(`${base()}/start`, { method: 'POST', body: options || {} })); }
  async function stop() { return answer(await call(`${base()}/stop`, { method: 'POST', body: {} })); }

  return { probe, wake, restart, start, stop, base, spaceId, pageUrl };
}
