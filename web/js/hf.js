// Hugging Face client: sign-in (OAuth+PKCE on a Space, or a pasted token),
// whoami, commit, repo creation, file listing, private file download.
// Plain fetch, no library. Never logs the token.

const CFG = self.HW_CONFIG;
const AUTH_KEY = 'hw.auth';
const OAUTH_KEY = 'hw.oauth';

export class HfError extends Error {
  /** kind: 'auth' | 'forbidden' | 'notfound' | 'rate' | 'network' | 'server' | 'other' */
  constructor(kind, status, message, retryAfterS = null) {
    super(message || kind);
    this.kind = kind; this.status = status; this.retryAfterS = retryAfterS;
  }
}

// ---------- token storage ----------

export function getAuth() {
  try {
    const a = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
    if (!a || !a.token) return null;
    if (a.expiresAt && Date.now() > a.expiresAt) return null;
    return a;
  } catch (_) { return null; }
}

function setAuth(a) {
  localStorage.setItem(AUTH_KEY, JSON.stringify(a));
  window.dispatchEvent(new CustomEvent('hw-auth'));
}

export function signOut() {
  localStorage.removeItem(AUTH_KEY);
  window.dispatchEvent(new CustomEvent('hw-auth'));
}

export const userName = () => (getAuth() || {}).name || null;
export const datasetRepoId = () => (userName() ? `${userName()}/${CFG.datasetRepo}` : null);
export const modelRepoId = () => (userName() ? `${userName()}/${CFG.modelRepo}` : null);

// ---------- low-level request ----------

function retryAfter(res) {
  const ra = res.headers.get('retry-after');
  if (ra && /^\d+$/.test(ra.trim())) return Number(ra);
  const rl = res.headers.get('ratelimit') || '';
  const m = /t=(\d+)/.exec(rl);
  return m ? Number(m[1]) : null;
}

async function request(path, { method = 'GET', headers = {}, body, token, absolute = false } = {}) {
  const url = absolute ? path : CFG.hfBase + path;
  const h = Object.assign({}, headers);
  const tk = token || (getAuth() || {}).token;
  if (tk) h.Authorization = `Bearer ${tk}`;
  let res;
  try {
    res = await fetch(url, { method, headers: h, body, cache: 'no-store', credentials: 'omit' });
  } catch (e) {
    throw new HfError('network', 0, 'network error');
  }
  if (res.ok) return res;
  const msg = res.headers.get('x-error-message') || `HTTP ${res.status}`;
  if (res.status === 401) throw new HfError('auth', 401, msg);
  if (res.status === 403) throw new HfError('forbidden', 403, msg);
  if (res.status === 404) throw new HfError('notfound', 404, msg);
  if (res.status === 429) throw new HfError('rate', 429, msg, retryAfter(res));
  if (res.status >= 500) throw new HfError('server', res.status, msg, retryAfter(res));
  throw new HfError('other', res.status, msg);
}

// ---------- account ----------

/** GET /api/whoami-v2; returns {name, ...}. */
export async function whoami(token) {
  const res = await request('/api/whoami-v2', { token });
  return res.json();
}

/** Validate a pasted token and store it. Throws HfError on failure. */
export async function signInWithToken(token) {
  token = String(token || '').trim();
  if (!token) throw new HfError('auth', 0, 'empty token');
  const me = await whoami(token);
  if (!me || !me.name) throw new HfError('auth', 0, 'whoami without name');
  setAuth({ token, name: me.name, source: 'token', expiresAt: null });
  return me.name;
}

// ---------- OAuth with PKCE (only on a Space with hf_oauth: true) ----------

export function oauthAvailable() {
  const v = window.huggingface && window.huggingface.variables;
  return !!(v && v.OAUTH_CLIENT_ID);
}

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const redirectUri = () => location.origin + location.pathname;

export async function oauthStart() {
  const v = window.huggingface.variables;
  const verifier = randomString(48);
  const state = randomString(16);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  localStorage.setItem(OAUTH_KEY, JSON.stringify({ verifier, state, hash: location.hash, t: Date.now() }));
  const p = new URLSearchParams({
    client_id: v.OAUTH_CLIENT_ID, redirect_uri: redirectUri(),
    scope: 'openid profile write-repos', response_type: 'code', state,
    code_challenge: b64url(digest), code_challenge_method: 'S256',
  });
  const base = (v.OPENID_PROVIDER_URL || CFG.hfBase).replace(/\/$/, '');
  location.assign(`${base}/oauth/authorize?${p}`);
}

/** Call once at boot. Returns the user name if a redirect was completed, else null. */
export async function oauthHandleRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') || !q.has('state')) return null;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(OAUTH_KEY) || 'null'); } catch (_) {}
  localStorage.removeItem(OAUTH_KEY);
  const cleanUrl = location.pathname + ((saved && saved.hash) || location.hash || '');
  history.replaceState(null, '', cleanUrl);
  if (!saved || saved.state !== q.get('state') || !oauthAvailable()) throw new HfError('auth', 0, 'oauth state mismatch');
  const v = window.huggingface.variables;
  const base = (v.OPENID_PROVIDER_URL || CFG.hfBase).replace(/\/$/, '');
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code: q.get('code'), client_id: v.OAUTH_CLIENT_ID,
    redirect_uri: redirectUri(), code_verifier: saved.verifier,
  });
  const res = await request(`${base}/oauth/token`, {
    method: 'POST', absolute: true, body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const tok = await res.json();
  const me = await whoami(tok.access_token);
  setAuth({
    token: tok.access_token, name: me.name, source: 'oauth',
    expiresAt: tok.expires_in ? Date.now() + tok.expires_in * 1000 - 60000 : null,
  });
  return me.name;
}

// ---------- repos and files ----------

/** One NDJSON commit. files: [{path, text}]. */
export async function commit(repoId, summary, files, { repoType = 'dataset', revision = 'main' } = {}) {
  const lines = [{ key: 'header', value: { summary } }]
    .concat(files.map((f) => ({ key: 'file', value: { path: f.path, content: f.text, encoding: 'utf-8' } })));
  const body = lines.map((l) => JSON.stringify(l)).join('\n');
  const res = await request(`/api/${repoType}s/${repoId}/commit/${revision}`, {
    method: 'POST', body, headers: { 'Content-Type': 'application/x-ndjson' },
  });
  return res.json().catch(() => ({}));
}

/** Create the private dataset repo. An existing repo (409) counts as success. */
export async function createDatasetRepo(name = CFG.datasetRepo) {
  try {
    await request('/api/repos/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'dataset', name, private: true }),
    });
    return true;
  } catch (e) {
    if (e.status === 409) return true;
    throw e;
  }
}

/** List all file paths below `path` (recursive). Follows Link: rel="next".
 *  Returns null when the repo (or the folder) does not exist. */
export async function listFiles(repoId, path, { repoType = 'dataset', revision = 'main' } = {}) {
  let url = `${CFG.hfBase}/api/${repoType}s/${repoId}/tree/${revision}/${path}?recursive=true&expand=false`;
  const out = [];
  for (let page = 0; url && page < 200; page++) {
    let res;
    try { res = await request(url, { absolute: true }); }
    catch (e) { if (e.kind === 'notfound') return null; throw e; }
    const items = await res.json();
    for (const it of items) if (it.type === 'file') out.push(it.path);
    const link = res.headers.get('link') || '';
    const m = /<([^>]+)>;\s*rel="next"/.exec(link);
    url = m ? m[1] : null;
  }
  return out;
}

/** Download a (private) file as a Response. */
export function downloadFile(repoId, path, { repoType = 'model', revision = 'main' } = {}) {
  const prefix = repoType === 'model' ? '' : `/${repoType}s`;
  return request(`${prefix}/${repoId}/resolve/${revision}/${path}`);
}
