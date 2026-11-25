// Boot, hash routing (#/erfassen #/schreiben #/einstellungen, #/start on first run),
// settings, sign-in, the waiting-lines indicator.
import * as store from './store.js';
import * as hf from './hf.js';
import * as outbox from './outbox.js';
import { loadPrompts } from './prompts.js';
import { makeWriter } from './writer.js';
import { capabilities } from './capture/recorder.js';
import { createCaptureView } from './capture/view.js';
import { createGenerateView } from './generate/view.js';

const CFG = self.HW_CONFIG;
const $ = (id) => document.getElementById(id);

const app = {
  prompts: { set: '', prompts: [], fallback: true },
  writers: [],            // known writers [{id, name}]
  writer: null,           // the one who writes now {id, name}; recording needs one
  localDone: new Set(),   // prompt ids of the current writer
  remoteDone: new Set(),  // ... that exist in the dataset (current writer)
  remoteAll: {},          // writer id -> prompt ids seen in the dataset
  skippedAll: {},         // writer id -> prompt ids skipped
  remoteUser: null,       // the account app.remoteAll belongs to
  repoDialogDismissed: false,
  framed: false,          // running inside the huggingface.co/spaces iframe
  skipped: new Set(),
  settings: { allowFinger: false },
  uaData: null,
  persisted: null,
  swState: 'nicht aktiv',
  capture: null,
  generate: null,
  route: null,
};
const doneIds = () => new Set([...app.localDone, ...app.remoteDone]);

// ---------- toast ----------

let toastTimer = null;
function toast(text, ms = 3200) {
  const t = $('toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- indicator ----------

/** An upload problem that waiting alone will not fix soon (not offline, not a short rate limit). */
const uploadProblem = (st) => !!(st.lastError && !['network', 'rate'].includes(st.lastError.kind));

async function updateWaiting() {
  const n = await store.countQueued().catch(() => 0);
  const el = $('waiting');
  const st = outbox.status();
  const problem = n > 0 && !st.running && uploadProblem(st) && !!hf.getAuth();
  el.classList.toggle('empty', n === 0);
  el.classList.toggle('problem', problem);
  el.setAttribute('aria-hidden', n === 0 ? 'true' : 'false');
  el.tabIndex = n === 0 ? -1 : 0;
  $('waiting-icon').setAttribute('href', problem ? '#i-cloud-alert' : '#i-cloud');
  $('waiting-text').textContent = st.running ? 'Lädt hoch …'
    : problem ? 'Hochladen klappt gerade nicht'
      : `${n} ${n === 1 ? 'Zeile wartet' : 'Zeilen warten'} aufs Hochladen`;
  $('waiting-short').textContent = st.running ? 'lädt …' : problem ? 'Problem' : `${n} ${n === 1 ? 'wartet' : 'warten'}`;
  el.title = !hf.getAuth() ? 'Zum Hochladen anmelden'
    : problem ? 'Hochladen klappt gerade nicht. Mehr in den Einstellungen.' : 'Wird automatisch hochgeladen';
  if (app.route === 'einstellungen') renderUploadStatus(n);
}

async function renderUploadStatus(n) {
  const st = outbox.status();
  const rejected = await store.countState('rejected').catch(() => 0);
  const rj = $('up-rejected');
  rj.hidden = rejected === 0;
  rj.textContent = `${rejected} ${rejected === 1 ? 'Zeile wurde' : 'Zeilen wurden'} von Hugging Face abgelehnt. Sie bleiben auf dem Gerät und in der Sicherung.`;
  let text;
  if (n === 0) text = 'Alles hochgeladen.';
  else if (!hf.getAuth()) text = `${n} ${n === 1 ? 'Zeile wartet' : 'Zeilen warten'}. Melde dich an, dann werden sie hochgeladen.`;
  else if (st.running) text = 'Lädt hoch …';
  else if (st.lastError && st.lastError.kind === 'network') text = `${n} ${n === 1 ? 'Zeile wartet' : 'Zeilen warten'}. Keine Verbindung, es wird später noch einmal versucht.`;
  else if (st.lastError && st.lastError.kind === 'rate') text = `${n} ${n === 1 ? 'Zeile wartet' : 'Zeilen warten'}. Hugging Face bittet um eine kurze Pause, es geht gleich weiter.`;
  else if (st.lastError && st.lastError.kind === 'notfound') text = `${n} ${n === 1 ? 'Zeile wartet' : 'Zeilen warten'}. In deinem Konto fehlt noch der Ort für deine Zeilen. „Jetzt hochladen“ legt ihn an.`;
  else if (st.lastError && st.lastError.kind === 'forbidden') text = `${n} ${n === 1 ? 'Zeile wartet' : 'Zeilen warten'}. Dein Zugang darf nicht hochladen. Melde dich mit Schreibrecht an.`;
  else if (st.lastError) text = `${n} ${n === 1 ? 'Zeile wartet' : 'Zeilen warten'}. Das letzte Hochladen hat nicht geklappt. Es wird später noch einmal versucht.`;
  else text = `${n} ${n === 1 ? 'Zeile wartet' : 'Zeilen warten'} aufs Hochladen.`;
  $('up-status').textContent = text;
  $('up-now').disabled = n === 0 || !hf.getAuth() || st.running;
}

// ---------- progress ----------

/** Progress is per writer: only lines written by the current writer count. */
async function loadLocalDone() {
  const all = await store.allLines();
  const w = app.writer;
  app.localDone = new Set(w ? all.filter((e) => e.record.writer_id === w.id).map((e) => e.prompt_id) : []);
}

/** Remote progress belongs to one account: a sign-out or a different account starts it empty. */
function syncRemoteUser() {
  const user = hf.userName();
  if (user === app.remoteUser) return;
  app.remoteUser = user;
  app.remoteAll = {};
  app.remoteDone = new Set();
  store.kvSet('remoteDone', { user, by: {} }).catch(() => {});
  if (app.capture) app.capture.refresh();
}

function saveRemoteDone() {
  const by = {};
  for (const [id, set] of Object.entries(app.remoteAll)) by[id] = [...set];
  return store.kvSet('remoteDone', { user: app.remoteUser, by }).catch(() => {});
}

async function refreshRemoteDone() {
  const repo = hf.datasetRepoId();
  if (!repo || !navigator.onLine || !app.writer) return;
  syncRemoteUser();
  const w = app.writer;
  try {
    // One listing of raw/v1; only the files below this writer's folder count.
    const paths = await hf.listFiles(repo, 'raw/v1');
    const ids = new Set();
    for (const p of paths || []) { const id = store.promptIdFromPath(p, w.id); if (id) ids.add(id); }
    app.remoteAll[w.id] = ids;
    await saveRemoteDone();
    if (app.writer && app.writer.id === w.id) {      // not if somebody else started writing meanwhile
      app.remoteDone = ids;
      if (app.capture) app.capture.refresh();
    }
  } catch (e) {
    // A 401 here often only means the dataset does not exist (yet) for this account.
    if (e.kind === 'auth' && (await hf.classify401(e)) === 'auth') {
      hf.signOut(); toast('Bitte melde dich neu an. Deine Zeilen bleiben gespeichert.');
    }
  }
}

// ---------- writers ----------

const saveSkipped = () => {
  if (app.writer) app.skippedAll[app.writer.id] = [...app.skipped];
  return store.kvSet('skippedBy', app.skippedAll);
};

/** Make a typed name the current writer (adds it to the known writers when new).
 *  Returns the writer, or null when no id can be made from the text. A switch starts
 *  a new session and loads that writer's progress. */
async function useWriter(text) {
  const made = makeWriter(text);
  if (!made) return null;
  const w = app.writers.find((x) => x.id === made.id) || made;
  if (!app.writers.some((x) => x.id === w.id)) {
    app.writers.push(w);
    await store.kvSet('writers', app.writers);
  }
  if (app.writer && app.writer.id === w.id) return w;
  app.writer = w;
  await store.kvSet('writer', w.id);
  app.remoteDone = new Set(app.remoteAll[w.id] || []);
  app.skipped = new Set(app.skippedAll[w.id] || []);
  await loadLocalDone();
  if (app.capture) app.capture.newSession();
  refreshRemoteDone();
  return w;
}

function renderWriters() {
  const list = $('wr-list');
  list.innerHTML = '';
  for (const w of app.writers) {
    const on = !!app.writer && app.writer.id === w.id;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'choice'; b.dataset.writer = w.id;
    b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', on ? 'true' : 'false');
    const name = document.createElement('span'); name.textContent = w.name;
    b.append(name);
    if (on) b.insertAdjacentHTML('beforeend', '<svg class="ic" aria-hidden="true"><use href="#i-check"/></svg>');
    list.append(b);
  }
  $('wr-current').textContent = app.writer ? app.writer.name : 'niemand';
}

function wireWriters() {
  $('wr-list').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-writer]');
    if (!b) return;
    const w = app.writers.find((x) => x.id === b.dataset.writer);
    if (!w || (app.writer && app.writer.id === w.id)) return;
    await useWriter(w.name);
    renderWriters();
    toast(`Jetzt schreibt ${w.name}.`);
  });
  const open = (on) => {
    $('wr-add-form').hidden = !on; $('wr-add').hidden = on; $('wr-err').hidden = true;
    if (on) { $('wr-input').value = ''; $('wr-input').focus(); }
  };
  $('wr-add').addEventListener('click', () => open(true));
  $('wr-cancel').addEventListener('click', () => open(false));
  $('wr-add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const w = await useWriter($('wr-input').value);
    if (!w) { $('wr-err').hidden = false; return; }
    open(false); renderWriters();
    toast(`Jetzt schreibt ${w.name}.`);
  });
}

// ---------- settings view ----------

function renderAccount() {
  const a = hf.getAuth();
  $('acc-out').hidden = !!a; $('acc-in').hidden = !a;
  if (a) $('acc-name').textContent = a.name;
  $('acc-oauth').hidden = !hf.oauthAvailable() || app.framed;
  $('start-signin').textContent = a ? `Angemeldet als ${a.name}` : 'Anmelden';
  $('start-signin').disabled = !!a;
}

async function renderDiagnostics() {
  const caps = capabilities();
  const last = await store.kvGet('lastLine', null).catch(() => null);
  const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate().catch(() => null) : null;
  const yes = (v) => (v ? 'ja' : 'nein');
  const all = await store.allLines().catch(() => []);
  const model = await app.generate.info().catch(() => null);
  const rows = [
    ['Zeilen-Ablage', hf.datasetRepoId() ? `${hf.datasetRepoId()} (privat)` : 'nach der Anmeldung'],
    ['Modell', hf.modelRepoId() ? `${hf.modelRepoId()} (privat)` : 'nach der Anmeldung'],
    ['Modell auf dem Gerät', model ? `${(model.bytes / 1e6).toFixed(1).replace('.', ',')} MB, ${model.sha256.slice(0, 8)}` : 'keins'],
    ['Letzter Upload-Fehler', (() => {
      const e = outbox.status().lastError;
      return e ? `${e.kind}${e.status ? ` (HTTP ${e.status})` : ''}, ${new Date(e.at).toLocaleTimeString('de-DE')}` : 'keiner';
    })()],
    ['Sicherer Kontext', yes(caps.secureContext)],
    ['pointerrawupdate', yes(caps.pointerrawupdate)],
    ['Coalesced Events', yes(caps.getCoalescedEvents)],
    ['Stiftrate letzte Zeile', last && last.rate_hz ? `${String(last.rate_hz).replace('.', ',')} Hz (${last.api}, ${last.points} Punkte)` : 'noch keine Zeile'],
    ['Pixelverhältnis (DPR)', String(devicePixelRatio).replace('.', ',')],
    ['Bildschirm', `${screen.width} × ${screen.height}, Fenster ${innerWidth} × ${innerHeight}`],
    ['Anzeigemodus', document.fullscreenElement ? 'Vollbild' : ['fullscreen', 'standalone', 'minimal-ui'].find((m) => matchMedia(`(display-mode: ${m})`).matches) || 'Browser'],
    ['Speicher dauerhaft', app.persisted === null ? 'unbekannt' : yes(app.persisted)],
    ['Speicher belegt', est ? `${(est.usage / 1e6).toFixed(1).replace('.', ',')} MB` : 'unbekannt'],
    ['Zeilen auf dem Gerät', String(all.length)],
    ['Offline-Modus', app.swState],
    ['Satz', `${app.prompts.set}${app.prompts.fallback ? ' (eingebaute Liste)' : ''}`],
    ['Version', CFG.version],
    ['Browser', navigator.userAgent],
  ];
  const dl = $('diag');
  dl.innerHTML = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  }
}

function renderSettings() {
  renderWriters();
  renderAccount();
  $('allow-finger').checked = !!app.settings.allowFinger;
  updateWaiting();
  renderDiagnostics();
}

// ---------- sign-in ----------

function openTokenDialog() {
  const d = $('dlg-token');
  $('tok-input').value = ''; $('tok-err').hidden = true;
  d.showModal();
}

async function afterSignIn(name) {
  renderAccount();
  toast(`Angemeldet als ${name}.`);
  await refreshRemoteDone();
  outbox.flush('auth');
}

function wireSignIn() {
  $('tok-cancel').addEventListener('click', () => $('dlg-token').close());
  $('tok-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = $('tok-ok');
    if (ok.disabled) return;
    ok.disabled = true;
    $('tok-err').hidden = true;
    try {
      const name = await hf.signInWithToken($('tok-input').value);
      $('dlg-token').close();
      await afterSignIn(name);
    } catch (err) {
      const msg = err.kind === 'network' ? 'Keine Verbindung zu Hugging Face. Bitte später noch einmal.'
        : err.kind === 'storage' ? 'Der Browser erlaubt hier keinen Speicher. Bitte öffne die App in einem normalen Fenster.'
          : 'Dieser Schlüssel funktioniert nicht. Bitte prüfe, ob er vollständig kopiert ist.';
      $('tok-err').textContent = msg; $('tok-err').hidden = false;
    } finally { ok.disabled = false; }
  });
  const oauth = () => hf.oauthStart().catch((e) => toast(e.kind === 'storage'
    ? 'Der Browser erlaubt hier keinen Speicher. Bitte öffne die App in einem normalen Fenster.'
    : 'Die Anmeldung hat nicht geklappt. Bitte noch einmal.', 5000));
  const signin = () => (hf.oauthAvailable() && !app.framed ? oauth() : openTokenDialog());
  app.signIn = signin;
  $('acc-oauth').addEventListener('click', oauth);
  $('acc-token').addEventListener('click', openTokenDialog);
  $('start-signin').addEventListener('click', signin);
  $('acc-signout').addEventListener('click', () => { hf.signOut(); renderSettings(); toast('Abgemeldet. Deine Zeilen bleiben auf diesem Gerät.'); });
  window.addEventListener('hw-auth', () => { syncRemoteUser(); renderAccount(); updateWaiting(); });
  window.addEventListener('hw-auth-expired', () => {
    syncRemoteUser(); renderAccount(); updateWaiting();
    toast('Die Anmeldung ist abgelaufen. Bitte melde dich neu an. Deine Zeilen bleiben gespeichert.', 6000);
  });
}

function wireRepoDialog() {
  const d = $('dlg-repo');
  $('repo-later').addEventListener('click', () => { app.repoDialogDismissed = true; d.close(); });
  $('repo-create').addEventListener('click', async () => {
    const b = $('repo-create');
    if (b.disabled) return;
    b.disabled = true; $('repo-err').hidden = true;
    try {
      await hf.createDatasetRepo(CFG.datasetRepo);
      d.close();
      toast('Angelegt. Deine Zeilen werden jetzt hochgeladen.');
      outbox.flush('repo-created');
    } catch (e) {
      $('repo-err').textContent = e.kind === 'conflict'
        ? 'Die Ablage gibt es schon, aber dein Zugang darf sie nicht sehen. Melde dich mit einem Schlüssel an, der Schreibrecht für dein Konto hat.'
        : e.kind === 'forbidden' || e.kind === 'auth'
          ? 'Dein Zugang darf nichts anlegen. Melde dich mit Schreibrecht an.'
          : 'Das Anlegen hat nicht geklappt. Bitte später noch einmal.';
      $('repo-err').hidden = false;
    } finally { b.disabled = false; }
  });
}

// ---------- routing ----------

const ROUTES = ['start', 'erfassen', 'schreiben', 'einstellungen'];

async function route() {
  let r = (location.hash.match(/^#\/([a-z]+)/) || [])[1];
  if (!ROUTES.includes(r)) r = (await store.kvGet('firstRunDone', false).catch(() => true)) ? 'erfassen' : 'start';
  if (r === 'erfassen' && !app.writer) r = 'start';       // no recording without a writer
  if (r !== (location.hash.match(/^#\/([a-z]+)/) || [])[1]) { history.replaceState(null, '', `#/${r}`); }
  if (app.route === 'erfassen' && r !== 'erfassen') app.capture.hide();
  if (app.route === 'schreiben' && r !== 'schreiben') app.generate.hide();
  app.route = r;
  document.body.dataset.route = r;
  for (const id of ROUTES) $(`v-${id}`).hidden = id !== r;
  for (const a of document.querySelectorAll('[data-route]')) {
    if (a.dataset.route === r) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  if (r === 'erfassen') app.capture.show();
  if (r === 'schreiben') app.generate.show();
  if (r === 'einstellungen') renderSettings();
  if (r === 'start') { renderAccount(); $('start-writer').value = app.writer ? app.writer.name : ''; $('start-err').hidden = true; }
}

// ---------- boot ----------

function showNoStorage() {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== 'v-nostore';
  document.body.dataset.route = 'nostore';
  $('bar').hidden = true;
}

async function boot() {
  document.addEventListener('contextmenu', (e) => { if (e.target.closest('#v-erfassen')) e.preventDefault(); });

  // Inside the huggingface.co/spaces page the app runs in an iframe, maybe with its own
  // storage: sign-in and install belong on the direct URL.
  try { app.framed = window.top !== window.self; } catch (_) { app.framed = true; }
  if (app.framed) {
    $('framed-link').href = location.origin + location.pathname;
    $('framed-note').hidden = false;
  }

  try { await store.check(); } catch (e) { console.error(e); showNoStorage(); return; }

  try {
    const name = await hf.oauthHandleRedirect();
    if (name) setTimeout(() => afterSignIn(name), 0);
  } catch (e) {
    toast(e.kind === 'cancelled' ? 'Anmeldung abgebrochen.' : 'Die Anmeldung hat nicht geklappt. Bitte noch einmal.');
  }

  app.settings = Object.assign(app.settings, await store.kvGet('settings', {}));
  app.writers = (await store.kvGet('writers', [])).filter((w) => w && w.id && w.name);
  const wid = await store.kvGet('writer', null);
  app.writer = app.writers.find((w) => w.id === wid) || null;
  app.skippedAll = await store.kvGet('skippedBy', {});
  app.skipped = new Set(app.writer ? app.skippedAll[app.writer.id] || [] : []);
  const rd = await store.kvGet('remoteDone', null);
  app.remoteUser = hf.userName();
  // Only a list kept for this very account can be trusted; anything else starts empty.
  if (rd && rd.user === app.remoteUser && rd.by && typeof rd.by === 'object') {
    for (const [id, ids] of Object.entries(rd.by)) app.remoteAll[id] = new Set(ids);
  }
  app.remoteDone = new Set(app.writer ? app.remoteAll[app.writer.id] || [] : []);
  await loadLocalDone();
  app.prompts = await loadPrompts(CFG.promptsUrl);

  if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
    navigator.userAgentData.getHighEntropyValues(['model', 'platform', 'platformVersion', 'fullVersionList'])
      .then((v) => { app.uaData = v; }).catch(() => {});
  }

  app.capture = createCaptureView({
    cfg: CFG, store, outbox, toast,
    prompts: () => app.prompts,
    doneIds,
    skippedIds: () => app.skipped,
    writer: () => app.writer,
    settings: () => app.settings,
    uaData: () => app.uaData,
    skip: async (id) => { app.skipped.add(id); await saveSkipped(); },
    lineSaved: async (record) => {
      if (record.writer_id === (app.writer && app.writer.id)) app.localDone.add(record.prompt.id);
      if (app.skipped.delete(record.prompt.id)) await saveSkipped();
      updateWaiting();
      if (app.persisted !== true) app.persisted = await store.requestPersist();
    },
  });

  app.generate = createGenerateView({ store, hf, toast, signIn: () => app.signIn() });
  await app.generate.init();

  outbox.install();
  outbox.onChange((type, d) => {
    if (type === 'uploaded') {
      syncRemoteUser();
      for (const u of d.done) {
        (app.remoteAll[u.writer] = app.remoteAll[u.writer] || new Set()).add(u.promptId);
        if (app.writer && app.writer.id === u.writer) app.remoteDone.add(u.promptId);
      }
      saveRemoteDone();
    }
    if (type === 'all-uploaded') toast('Alles hochgeladen.');
    if (type === 'auth-required') toast('Bitte melde dich neu an. Deine Zeilen bleiben gespeichert.', 5000);
    if (type === 'forbidden') toast('Dein Zugang darf nicht hochladen. Melde dich mit Schreibrecht an.', 5000);
    // After "Später" the dialog comes back only when the writer asks to upload.
    if (type === 'repo-missing' && !$('dlg-repo').open && (!app.repoDialogDismissed || d.reason === 'manual')) {
      $('repo-err').hidden = true; $('dlg-repo').showModal();
    }
    updateWaiting();
  });

  wireSignIn();
  wireRepoDialog();

  wireWriters();
  const startGo = async () => {
    const w = await useWriter($('start-writer').value);
    if (!w) { $('start-err').hidden = false; $('start-writer').focus(); return; }
    await store.kvSet('firstRunDone', true);
    app.capture.enterFullscreen();
    location.hash = '#/erfassen';
  };
  $('start-go').addEventListener('click', startGo);
  $('start-writer').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); startGo(); } });
  $('start-writer').addEventListener('input', () => { $('start-err').hidden = true; });
  $('allow-finger').addEventListener('change', async (e) => {
    app.settings.allowFinger = e.target.checked;
    app.capture.setPenOnly(!e.target.checked);
    await store.kvSet('settings', app.settings);
  });
  $('up-now').addEventListener('click', () => outbox.flush('manual'));
  $('backup').addEventListener('click', async () => {
    const text = await store.backupJsonl();
    const n = text ? text.split('\n').filter(Boolean).length : 0;
    const blob = new Blob([text], { type: 'application/x-ndjson' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `handschrift-sicherung-${new Date().toISOString().slice(0, 10)}.jsonl`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    $('backup-status').textContent = `${n} ${n === 1 ? 'Zeile' : 'Zeilen'} gesichert.`;
  });

  window.addEventListener('hashchange', route);
  await route();
  updateWaiting();

  app.persisted = await store.requestPersist();
  if ('serviceWorker' in navigator && window.isSecureContext) {
    // A new worker taking over means new code on disk; the running page is still the old one.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('Es gibt eine neue Version. Bitte die App einmal schließen und neu öffnen.', 8000);
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
      app.swState = 'wird eingerichtet';
      const ready = () => { app.swState = 'bereit'; };
      if (reg.active) ready();
      navigator.serviceWorker.ready.then(ready);
    }).catch(() => { app.swState = 'nicht verfügbar'; });
  }

  outbox.flush('start');
  refreshRemoteDone();
  window.addEventListener('online', refreshRemoteDone);
}

window.__hw = { app, store, hf, outbox, get capture() { return app.capture; }, get generate() { return app.generate; } };
window.__hwReady = boot().then(() => true, (e) => { console.error(e); return false; });
