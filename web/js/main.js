// Boot, hash routing (#/erfassen #/schreiben #/einstellungen, #/start on first run),
// settings, sign-in, the waiting-lines indicator.
import * as store from './store.js';
import * as hf from './hf.js';
import * as outbox from './outbox.js';
import { loadPrompts } from './prompts.js';
import { capabilities } from './capture/recorder.js';
import { createCaptureView } from './capture/view.js';

const CFG = self.HW_CONFIG;
const $ = (id) => document.getElementById(id);

const app = {
  prompts: { set: '', prompts: [], fallback: true },
  localDone: new Set(),
  remoteDone: new Set(),
  skipped: new Set(),
  settings: { allowFinger: false },
  uaData: null,
  persisted: null,
  swState: 'nicht aktiv',
  capture: null,
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

async function updateWaiting() {
  const n = await store.countQueued().catch(() => 0);
  const el = $('waiting');
  el.hidden = n === 0;
  const st = outbox.status();
  $('waiting-text').textContent = st.running ? 'Lädt hoch …'
    : `${n} ${n === 1 ? 'Zeile wartet' : 'Zeilen warten'} aufs Hochladen`;
  $('waiting-short').textContent = st.running ? '…' : `${n} ${n === 1 ? 'wartet' : 'warten'}`;
  el.title = hf.getAuth() ? 'Wird automatisch hochgeladen' : 'Zum Hochladen anmelden';
  if (app.route === 'einstellungen') renderUploadStatus(n);
}

function renderUploadStatus(n) {
  const st = outbox.status();
  let text;
  if (n === 0) text = 'Alles hochgeladen.';
  else if (!hf.getAuth()) text = `${n} ${n === 1 ? 'Zeile wartet' : 'Zeilen warten'}. Melde dich an, dann werden sie hochgeladen.`;
  else if (st.running) text = 'Lädt hoch …';
  else if (st.lastError && st.lastError.kind === 'network') text = `${n} ${n === 1 ? 'Zeile wartet' : 'Zeilen warten'}. Keine Verbindung, es wird später noch einmal versucht.`;
  else if (st.lastError && st.lastError.kind === 'rate') text = `${n} ${n === 1 ? 'Zeile wartet' : 'Zeilen warten'}. Hugging Face bittet um eine kurze Pause, es geht gleich weiter.`;
  else if (st.lastError && st.lastError.kind === 'notfound') text = `${n} ${n === 1 ? 'Zeile wartet' : 'Zeilen warten'}. In deinem Konto fehlt noch der Ort für deine Zeilen. „Jetzt hochladen“ legt ihn an.`;
  else if (st.lastError && st.lastError.kind === 'forbidden') text = `${n} ${n === 1 ? 'Zeile wartet' : 'Zeilen warten'}. Dein Zugang darf nicht hochladen. Melde dich mit Schreibrecht an.`;
  else if (st.lastError) text = `${n} ${n === 1 ? 'Zeile wartet' : 'Zeilen warten'}. Das letzte Hochladen hat nicht geklappt (${st.lastError.status || 'keine Antwort'}).`;
  else text = `${n} ${n === 1 ? 'Zeile wartet' : 'Zeilen warten'} aufs Hochladen.`;
  $('up-status').textContent = text;
  $('up-now').disabled = n === 0 || !hf.getAuth();
}

// ---------- progress ----------

async function loadLocalDone() {
  const all = await store.allLines();
  app.localDone = new Set(all.map((e) => e.prompt_id));
}

async function refreshRemoteDone() {
  const repo = hf.datasetRepoId();
  if (!repo || !navigator.onLine) return;
  try {
    const paths = await hf.listFiles(repo, 'raw/v1');
    const ids = new Set();
    for (const p of paths || []) { const id = store.promptIdFromPath(p); if (id) ids.add(id); }
    app.remoteDone = ids;
    await store.kvSet('remoteDone', [...ids]);
    if (app.capture) app.capture.refresh();
  } catch (e) {
    if (e.kind === 'auth') { hf.signOut(); toast('Bitte melde dich neu an. Deine Zeilen bleiben gespeichert.'); }
  }
}

// ---------- settings view ----------

function renderAccount() {
  const a = hf.getAuth();
  $('acc-out').hidden = !!a; $('acc-in').hidden = !a;
  $('acc-oauth').hidden = !hf.oauthAvailable();
  if (a) $('acc-name').textContent = a.name;
  const user = a ? a.name : '<dein Konto>';
  $('repo-dataset').textContent = `${user}/${CFG.datasetRepo} (privat)`;
  $('repo-model').textContent = `${user}/${CFG.modelRepo} (privat)`;
  $('start-signin').textContent = a ? `Angemeldet als ${a.name}` : 'Anmelden';
  $('start-signin').disabled = !!a;
}

async function renderDiagnostics() {
  const caps = capabilities();
  const last = await store.kvGet('lastLine', null).catch(() => null);
  const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate().catch(() => null) : null;
  const yes = (v) => (v ? 'ja' : 'nein');
  const all = await store.allLines().catch(() => []);
  const rows = [
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
        : 'Dieser Token funktioniert nicht. Bitte prüfe, ob er vollständig kopiert ist.';
      $('tok-err').textContent = msg; $('tok-err').hidden = false;
    } finally { ok.disabled = false; }
  });
  const signin = () => (hf.oauthAvailable() ? hf.oauthStart() : openTokenDialog());
  $('acc-oauth').addEventListener('click', () => hf.oauthStart());
  $('acc-token').addEventListener('click', openTokenDialog);
  $('start-signin').addEventListener('click', signin);
  $('acc-signout').addEventListener('click', () => { hf.signOut(); renderSettings(); toast('Abgemeldet. Deine Zeilen bleiben auf diesem Gerät.'); });
  window.addEventListener('hw-auth', () => { renderAccount(); updateWaiting(); });
}

function wireRepoDialog() {
  const d = $('dlg-repo');
  $('repo-later').addEventListener('click', () => d.close());
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
      $('repo-err').textContent = e.kind === 'forbidden' || e.kind === 'auth'
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
  if (!ROUTES.includes(r)) r = (await store.kvGet('firstRunDone', false)) ? 'erfassen' : 'start';
  if (r !== (location.hash.match(/^#\/([a-z]+)/) || [])[1]) { history.replaceState(null, '', `#/${r}`); }
  if (app.route === 'erfassen' && r !== 'erfassen') app.capture.hide();
  app.route = r;
  document.body.dataset.route = r;
  for (const id of ROUTES) $(`v-${id}`).hidden = id !== r;
  for (const a of document.querySelectorAll('[data-route]')) {
    if (a.dataset.route === r) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  if (r === 'erfassen') app.capture.show();
  if (r === 'einstellungen') renderSettings();
  if (r === 'start') renderAccount();
}

// ---------- boot ----------

async function boot() {
  document.addEventListener('contextmenu', (e) => { if (e.target.closest('#v-erfassen')) e.preventDefault(); });

  try {
    const name = await hf.oauthHandleRedirect();
    if (name) setTimeout(() => afterSignIn(name), 0);
  } catch (e) { toast('Die Anmeldung hat nicht geklappt. Bitte noch einmal.'); }

  app.settings = Object.assign(app.settings, await store.kvGet('settings', {}));
  app.skipped = new Set(await store.kvGet('skipped', []));
  app.remoteDone = new Set(await store.kvGet('remoteDone', []));
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
    settings: () => app.settings,
    uaData: () => app.uaData,
    skip: async (id) => { app.skipped.add(id); await store.kvSet('skipped', [...app.skipped]); },
    lineSaved: async (record) => {
      app.localDone.add(record.prompt.id);
      if (app.skipped.delete(record.prompt.id)) await store.kvSet('skipped', [...app.skipped]);
      updateWaiting();
      if (app.persisted !== true) app.persisted = await store.requestPersist();
    },
  });

  outbox.install();
  outbox.onChange((type, d) => {
    if (type === 'uploaded') { for (const id of d.promptIds) app.remoteDone.add(id); store.kvSet('remoteDone', [...app.remoteDone]); }
    if (type === 'auth-required') toast('Bitte melde dich neu an. Deine Zeilen bleiben gespeichert.', 5000);
    if (type === 'forbidden') toast('Dein Zugang darf nicht hochladen. Melde dich mit Schreibrecht an.', 5000);
    if (type === 'repo-missing' && !$('dlg-repo').open) { $('repo-err').hidden = true; $('dlg-repo').showModal(); }
    updateWaiting();
  });

  wireSignIn();
  wireRepoDialog();

  $('start-go').addEventListener('click', async () => {
    await store.kvSet('firstRunDone', true);
    app.capture.enterFullscreen();
    location.hash = '#/erfassen';
  });
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
    navigator.serviceWorker.register('sw.js').then((reg) => {
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

window.__hw = { app, store, hf, outbox, get capture() { return app.capture; } };
window.__hwReady = boot().then(() => true, (e) => { console.error(e); return false; });
