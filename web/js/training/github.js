// GitHub, where a training runs: the workflow cfg.githubWorkflow in cfg.githubRepo
// (.github/workflows/retrain.yml, free for a public repository).
//
// Reading the workflow's runs needs no token (public repository); GitHub allows
// 60 such requests per hour per address, so the Training tab asks rarely.  Starting
// a run needs a fine-grained token limited to this repository with "Actions: Read
// and write".  It is optional, kept on this device only (localStorage, like the
// Hugging Face sign-in), sent to api.github.com only and never logged.

const API = 'https://api.github.com';
const KEY = 'hw.github';

export class GhError extends Error {
  /** kind: 'auth' | 'forbidden' | 'notfound' | 'rate' | 'network' | 'other' */
  constructor(kind, status, retryAt = 0) { super(kind); this.kind = kind; this.status = status; this.retryAt = retryAt; }
}

export function createGitHub({ cfg = self.HW_CONFIG } = {}) {
  const repo = cfg.githubRepo;
  const wf = cfg.githubWorkflow;
  let branch = null;
  let quietUntil = 0;            // after a rate-limit answer: no requests until then

  // ---------- the token ----------
  function token() {
    try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); return v && v.token ? v.token : null; } catch (_) { return null; }
  }
  function saveToken(t) {
    localStorage.setItem(KEY, JSON.stringify({ token: t, savedAt: new Date().toISOString() }));
    window.dispatchEvent(new CustomEvent('hw-github'));
  }
  function removeToken() {
    try { localStorage.removeItem(KEY); } catch (_) {}
    window.dispatchEvent(new CustomEvent('hw-github'));
  }
  /** The last four characters, to recognise it; the token itself is never shown again. */
  const tokenEnd = () => { const t = token(); return t ? t.slice(-4) : null; };

  // ---------- requests ----------
  async function request(path, { method = 'GET', body, auth = token() } = {}) {
    if (Date.now() < quietUntil) throw new GhError('rate', 0, quietUntil);
    const headers = { Accept: 'application/vnd.github+json' };
    if (auth) headers.Authorization = `Bearer ${auth}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'omit' });
    } catch (_) { throw new GhError('network', 0); }
    if (res.ok) return res;
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (res.status === 429 || (res.status === 403 && remaining === '0')) {
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      const after = Number(res.headers.get('retry-after')) * 1000;
      quietUntil = reset > Date.now() ? reset : Date.now() + (after > 0 ? after : 60000);
      throw new GhError('rate', res.status, quietUntil);
    }
    if (res.status === 401) throw new GhError('auth', 401);
    if (res.status === 403) throw new GhError('forbidden', 403);
    if (res.status === 404) throw new GhError('notfound', 404);
    throw new GhError('other', res.status);
  }

  async function defaultBranch() {
    if (branch) return branch;
    const j = await (await request(`/repos/${repo}`)).json();
    branch = j && j.default_branch;
    if (!branch) throw new GhError('other', 200);
    return branch;
  }

  /** The newest run of the workflow: {id, status, conclusion, created_at, html_url, run_number} or null. */
  async function latestRun() {
    const j = await (await request(`/repos/${repo}/actions/workflows/${wf}/runs?per_page=1`)).json();
    const r = j && Array.isArray(j.workflow_runs) ? j.workflow_runs[0] : null;
    return r ? { id: r.id, status: r.status, conclusion: r.conclusion, created_at: r.created_at, updated_at: r.updated_at, html_url: r.html_url, run_number: r.run_number } : null;
  }

  /** Start a run (needs the token). inputs: strings, as the workflow declares them. */
  async function dispatch(inputs) {
    const ref = await defaultBranch();
    await request(`/repos/${repo}/actions/workflows/${wf}/dispatches`, { method: 'POST', body: { ref, inputs } });
  }

  async function cancel(runId) { await request(`/repos/${repo}/actions/runs/${runId}/cancel`, { method: 'POST' }); }

  /** A pasted token: may it see this workflow? Resolves, or throws a GhError. */
  async function check(t) { await request(`/repos/${repo}/actions/workflows/${wf}`, { auth: t }); }

  const workflowPage = () => `https://github.com/${repo}/actions/workflows/${wf}`;
  const tokenPage = () => 'https://github.com/settings/personal-access-tokens/new';

  return { repo, token, saveToken, removeToken, tokenEnd, defaultBranch, latestRun, dispatch, cancel, check, workflowPage, tokenPage, quietUntil: () => quietUntil };
}

/** A run that is not finished yet. */
export const runActive = (r) => !!r && r.status !== 'completed';
