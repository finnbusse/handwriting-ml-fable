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
import { createTrainingView } from './training/view.js';
import { createGitHub } from './training/github.js';
import { createGitHubSettings } from './training/github-settings.js';
import { normalize as normalizeDisplay } from './capture/ink.js';
import { createLookControls } from './capture/look.js';
import { createLibraryView } from './library.js';

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
  displayBy: {},          // writer id -> "Stift & Papier" options (display only, never what is recorded)
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
  look: null,             // the "Stift & Papier" controls in Einstellungen
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

// ---------- indicator and "is it safe?" ----------

/** An upload problem that waiting alone will not fix soon (not offline, not a short rate limit). */
const uploadProblem = (st) => !!(st.lastError && !['network', 'rate'].includes(st.lastError.kind));
const zeilen = (n) => `${n} ${n === 1 ? 'Zeile' : 'Zeilen'}`;
const LONG_WAIT_MS = 60 * 60 * 1000;   // lines waiting longer than this get a word on what to do

/** "heute, 14:32 Uhr" / "gestern, 09:05 Uhr" / "3.11.2026, 14:32 Uhr" */
function when(at) {
  const d = new Date(at);
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (d.toDateString() === new Date().toDateString()) return `heute, ${time} Uhr`;
  if (d.toDateString() === y.toDateString()) return `gestern, ${time} Uhr`;
  return `${d.toLocaleDateString('de-DE')}, ${time} Uhr`;
}

function since(ms) {
  const h = Math.floor(ms / 3600000);
  if (h < 2) return 'über einer Stunde';
  if (h < 48) return `über ${h} Stunden`;
  return `über ${Math.floor(h / 24)} Tagen`;
}

/** Everything the status texts are made from. */
async function safety() {
  const c = await store.counts().catch(() => ({ total: 0, queued: 0, sent: 0, verified: 0, rejected: 0 }));
  const st = outbox.status();
  const user = hf.userName();
  const oldest = c.queued ? await store.oldestQueuedAt().catch(() => null) : null;
  return {
    c, st, auth: !!hf.getAuth(), offline: navigator.onLine === false,
    // Signed out, the last check of whoever was signed in is still worth showing.
    lastCheck: st.lastCheck && (!user || st.lastCheck.user === user) ? st.lastCheck : null,
    waitedMs: oldest ? Date.now() - Date.parse(oldest) : 0,
  };
}

/** The status texts in plain German, from the counts and the outbox state (pure). */
function safetyTexts({ c, st, auth, offline, lastCheck, waitedMs }) {
  const n = c.queued;
  const t = {};
  // headline: only lines seen in the dataset count as safe
  if (c.total === 0) t.main = 'Noch keine Zeilen auf diesem Gerät.';
  else if (c.verified === c.total) t.main = c.total === 1 ? '1 Zeile ist sicher gespeichert.' : `Alle ${c.total} Zeilen sind sicher gespeichert.`;
  else if (c.verified === 0) t.main = c.total === 1 ? '1 Zeile ist auf diesem Gerät gespeichert.' : `${c.total} Zeilen sind auf diesem Gerät gespeichert.`;
  else t.main = `${c.verified} von ${c.total} Zeilen sind sicher gespeichert.`;
  t.level = c.total === 0 ? 'none' : c.verified === c.total ? 'ok' : 'wait';
  t.local = c.verified > 0 && c.verified < c.total ? 'Alle anderen sind auf diesem Gerät gespeichert.' : '';
  // waiting lines, with the reason when there is one
  const w = `${zeilen(n)} ${n === 1 ? 'wartet' : 'warten'} auf das Hochladen.`;
  const kind = st.lastError && st.lastError.kind;
  if (n === 0) t.queued = '';
  else if (!auth) t.queued = `${w} Melde dich an, dann werden sie hochgeladen.`;
  else if (st.running) t.queued = `${w} Lädt hoch …`;
  else if (kind === 'network') t.queued = `${w} Keine Verbindung, es wird später noch einmal versucht.`;
  else if (kind === 'rate') t.queued = `${w} Hugging Face bittet um eine kurze Pause, es geht gleich weiter.`;
  else if (kind === 'notfound') t.queued = `${w} In deinem Konto fehlt noch der Ort für deine Zeilen. „Jetzt hochladen“ legt ihn an.`;
  else if (kind === 'forbidden') t.queued = `${w} Dein Zugang darf nicht hochladen. Melde dich mit Schreibrecht an.`;
  else if (kind) t.queued = `${w} Das letzte Hochladen hat nicht geklappt. Es wird später noch einmal versucht.`;
  else t.queued = w;
  // sent, not seen yet
  t.pending = c.sent ? `${zeilen(c.sent)} ${c.sent === 1 ? 'wird' : 'werden'} noch geprüft.` : '';
  // the check itself
  const last = lastCheck ? ` Zuletzt geprüft: ${when(lastCheck.at)}.` : '';
  const prob = st.checkProblem && st.checkProblem.kind;
  if (st.checking) t.check = 'Wird gerade geprüft …';
  else if (!auth) t.check = lastCheck ? `Zuletzt geprüft: ${when(lastCheck.at)}. Zum Prüfen bitte anmelden.` : 'Noch nicht geprüft. Zum Prüfen bitte anmelden.';
  else if (offline || prob === 'offline') t.check = `Noch nicht geprüft (offline).${last}`;
  else if (prob === 'notfound' && !lastCheck) t.check = kind === 'notfound' ? 'Noch nicht geprüft.' : 'Noch nicht geprüft: In deinem Konto gibt es den Ort für deine Zeilen noch nicht.';
  else if (prob) t.check = `Die Prüfung hat gerade nicht geklappt, es wird später noch einmal versucht.${last}`;
  else t.check = lastCheck ? `Zuletzt geprüft: ${when(lastCheck.at)}.` : 'Noch nicht geprüft.';
  // lines that could not go up for a longer time: calm, with what to do
  t.help = '';
  if (n > 0 && !st.running && waitedMs >= LONG_WAIT_MS) {
    const head = `Seit ${since(waitedMs)} ${n === 1 ? 'konnte 1 Zeile' : `konnten ${n} Zeilen`} nicht hochgeladen werden.`
      + ` ${n === 1 ? 'Sie ist' : 'Sie sind'} auf diesem Gerät gespeichert und ${n === 1 ? 'geht' : 'gehen'} nicht verloren.`;
    let todo;
    if (!auth) todo = 'Melde dich oben unter „Konto“ an, dann werden sie hochgeladen.';
    else if (kind === 'notfound') todo = 'In deinem Konto fehlt der Ort für deine Zeilen: Tippe auf „Jetzt hochladen“, dann wird er angelegt.';
    else if (kind === 'forbidden' || kind === 'auth') todo = 'Dein Zugang darf nicht hochladen: Melde dich mit einem Schlüssel an, der Schreibrecht hat.';
    else if (offline || kind === 'network') todo = 'Es fehlt die Verbindung. Sobald das Gerät online ist, geht es von selbst weiter.';
    else todo = 'Es wird immer wieder von selbst versucht.';
    t.help = `${head} ${todo} Wenn du magst, lade zusätzlich die Sicherung herunter.`;
    t.level = 'help';
    t.queued = w;   // the reason is in the help text; say it once
  }
  // the small indicator in the top bar
  const problem = n > 0 && !st.running && uploadProblem(st) && auth;
  t.barEmpty = c.total === 0;
  t.barProblem = problem;
  t.barSafe = !problem && n === 0 && c.sent === 0 && c.total > 0 && c.verified === c.total;
  t.barIcon = problem ? '#i-cloud-alert' : t.barSafe ? '#i-cloud-check' : '#i-cloud';
  if (st.running && n > 0) { t.barLong = 'Lädt hoch …'; t.barShort = 'lädt …'; }
  else if (problem) { t.barLong = 'Hochladen klappt gerade nicht'; t.barShort = 'Problem'; }
  else if (n > 0) { t.barLong = `${n} ${n === 1 ? 'Zeile wartet' : 'Zeilen warten'} aufs Hochladen`; t.barShort = `${n} ${n === 1 ? 'wartet' : 'warten'}`; }
  else if (c.sent > 0) { t.barLong = `${zeilen(c.sent)} ${c.sent === 1 ? 'wird' : 'werden'} geprüft`; t.barShort = 'wird geprüft'; }
  else if (t.barSafe) { t.barLong = c.total === 1 ? '1 Zeile sicher gespeichert' : `Alle ${c.total} Zeilen sicher gespeichert`; t.barShort = 'alles sicher'; }
  else { t.barLong = `${c.verified} von ${c.total} Zeilen sicher`; t.barShort = `${c.verified} sicher`; }
  t.barTitle = !auth ? 'Zum Hochladen anmelden'
    : problem ? 'Hochladen klappt gerade nicht. Mehr in den Einstellungen.'
      : t.barSafe ? 'Alle Zeilen wurden bei Hugging Face wiedergefunden.' : 'Wird automatisch hochgeladen und geprüft';
  return t;
}

let statusSeq = 0;
async function updateWaiting() {
  const seq = ++statusSeq;
  const s = await safety();
  if (seq !== statusSeq) return;            // a newer update is on its way
  const t = safetyTexts(s);
  const el = $('waiting');
  el.classList.toggle('empty', t.barEmpty);
  el.classList.toggle('problem', t.barProblem);
  el.classList.toggle('safe', t.barSafe);
  el.setAttribute('aria-hidden', t.barEmpty ? 'true' : 'false');
  el.tabIndex = t.barEmpty ? -1 : 0;
  $('waiting-icon').setAttribute('href', t.barIcon);
  $('waiting-text').textContent = t.barLong;
  $('waiting-short').textContent = t.barShort;
  el.title = t.barTitle;
  if (app.route === 'einstellungen') renderUploadStatus(s, t);
}

function renderUploadStatus(s, t) {
  const show = (id, text) => { const e = $(id); e.textContent = text; e.hidden = !text; };
  $('safe').dataset.level = t.level;
  $('safe-icon').setAttribute('href', t.level === 'ok' ? '#i-cloud-check' : t.level === 'help' ? '#i-info' : '#i-cloud');
  $('safe-main').textContent = t.main;
  show('safe-local', t.local);
  show('up-status', t.queued);
  show('safe-pending', t.pending);
  $('safe-check-text').textContent = t.check;
  show('safe-help', t.help);
  const rejected = s.c.rejected;
  const rj = $('up-rejected');
  rj.hidden = rejected === 0;
  rj.textContent = `${rejected} ${rejected === 1 ? 'Zeile wurde' : 'Zeilen wurden'} von Hugging Face abgelehnt. Sie bleiben auf dem Gerät und in der Sicherung.`;
  $('up-now').hidden = s.c.queued === 0;
  $('up-now').disabled = !s.auth || s.st.running;
  $('safe-check').disabled = !s.auth || s.st.checking || s.st.running;
}

// ---------- progress ----------

/** Progress is per writer: only lines written by the current writer count. */
async function loadLocalDone() {
  const all = await store.allLines();
  const w = app.writer;
  // A deleted line (tombstone) does not count as written: its prompt comes back.
  app.localDone = new Set(w ? all.filter((e) => store.isLive(e) && e.record.writer_id === w.id).map((e) => e.prompt_id) : []);
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

/** Progress from a listing of raw/v1 (the one the check made): every writer's folder. */
function applyListing({ paths, user }) {
  if (user !== hf.userName()) return;
  syncRemoteUser();
  const by = {};
  for (const w of app.writers) by[w.id] = new Set();
  for (const p of paths) {
    const m = store.parsePath(p);
    if (m) (by[m.writer] = by[m.writer] || new Set()).add(m.promptId);
  }
  app.remoteAll = by;
  saveRemoteDone();
  if (app.writer) {
    app.remoteDone = new Set(by[app.writer.id] || []);
    if (app.capture) app.capture.refresh();
  }
}

/** One listing serves both the progress and the check (outbox.verify). */
let listedOnce = false;
function refreshRemoteDone({ force = true } = {}) {
  if (!force && listedOnce) return Promise.resolve();
  return outbox.verify('progress');
}

// ---------- Stift & Papier ----------

const displayOf = (w) => normalizeDisplay(w ? app.displayBy[w.id] : null);

/** Remember the current writer's look on this device and show it on the sheet. */
async function saveDisplay(o) {
  const d = normalizeDisplay(o);
  if (app.capture) app.capture.setDisplay(d);
  if (!app.writer) return;
  app.displayBy[app.writer.id] = d;
  if (app.look && app.route === 'einstellungen') app.look.render();
  await store.kvSet('displayBy', app.displayBy);
}

function renderLook() {
  $('look-for').textContent = app.writer ? `Gilt für ${app.writer.name}. Ändert nur, wie die Schrift aussieht, nicht was aufgezeichnet wird.` : '';
  $('g-look-box').hidden = !app.writer;
  $('look-none').hidden = !!app.writer;
  if (app.writer && app.look) app.look.render();
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
  if (app.capture) { app.capture.setDisplay(displayOf(w)); app.capture.newSession(); }
  refreshRemoteDone({ force: false });     // the last listing already holds every writer
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
    renderWriters(); renderLook();
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
    open(false); renderWriters(); renderLook();
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
    ['Zeilen nach Zustand', (() => {
      const c = { queued: 0, sent: 0, verified: 0, rejected: 0, deleted: 0 };
      for (const e of all) if (e.state in c) c[e.state]++;
      return `${c.verified} geprüft, ${c.sent} gesendet, ${c.queued} wartend, ${c.rejected} abgelehnt, ${c.deleted} gelöscht`;
    })()],
    ['Vorschau-Bilder', (() => {
      const up = all.filter((e) => e.state === 'sent' || e.state === 'verified');
      const open = up.filter((e) => !e.preview_at).length;
      return open ? `${open} von ${up.length} noch offen` : 'vollständig';
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
  renderLook();
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

const ROUTES = ['start', 'erfassen', 'schreiben', 'training', 'einstellungen', 'zeilen'];

async function route() {
  let r = (location.hash.match(/^#\/([a-z]+)/) || [])[1];
  if (!ROUTES.includes(r)) r = (await store.kvGet('firstRunDone', false).catch(() => true)) ? 'erfassen' : 'start';
  if ((r === 'erfassen' || r === 'zeilen') && !app.writer) r = 'start';   // no recording (and no own lines) without a writer
  if (r !== (location.hash.match(/^#\/([a-z]+)/) || [])[1]) { history.replaceState(null, '', `#/${r}`); }
  if (app.route === 'erfassen' && r !== 'erfassen') app.capture.hide();
  if (app.route === 'schreiben' && r !== 'schreiben') app.generate.hide();
  if (app.route === 'zeilen' && r !== 'zeilen') app.library.hide();
  const from = app.route;
  if (app.route === 'training' && r !== 'training') app.training.hide();
  app.route = r;
  document.body.dataset.route = r;
  for (const id of ROUTES) $(`v-${id}`).hidden = id !== r;
  for (const a of document.querySelectorAll('[data-route]')) {
    if (a.dataset.route === r) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  if (r === 'erfassen') app.capture.show();
  if (r === 'schreiben') app.generate.show();
  if (r === 'training') app.training.show();
  if (r === 'einstellungen') { renderSettings(); app.githubSettings.render(); }
  if (r === 'zeilen') app.library.show(from);
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
  app.displayBy = (await store.kvGet('displayBy', {})) || {};
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
    display: () => displayOf(app.writer),
    saveDisplay,
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

  // "Meine Zeilen": a deleted line no longer counts as written, so its prompt comes back.
  app.library = createLibraryView({
    root: $('v-zeilen'), toast, writer: () => app.writer,
    changed: async (type, d) => {
      if (type === 'deleted') {
        if (!d.stillWritten) {
          if (app.remoteAll[d.writer]) app.remoteAll[d.writer].delete(d.promptId);
          if (app.writer && app.writer.id === d.writer) app.remoteDone.delete(d.promptId);
          saveRemoteDone();
        }
        await loadLocalDone();
        if (app.capture) app.capture.refresh();
        outbox.verify('library');      // the listing has the last word on the progress
      }
      updateWaiting();
    },
  });

  app.generate = createGenerateView({ store, hf, toast, signIn: () => app.signIn() });
  await app.generate.init();
  // A finished training: Schreiben looks for the new model at once (its checksum decides whether to download).
  // Training runs on GitHub; the optional token for starting it from here is set up in Einstellungen.
  app.github = createGitHub();
  app.githubSettings = createGitHubSettings($('gh-settings'), app.github);
  app.training = createTrainingView({ hf, github: app.github, signIn: () => app.signIn(), writer: () => app.writer, modelChanged: () => app.generate.refresh() });
  app.training.init();

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
    if (type === 'listed') { listedOnce = true; applyListing(d); }
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
  app.look = createLookControls($('look-settings'), { get: () => displayOf(app.writer), set: saveDisplay });
  const startGo = async () => {
    const w = await useWriter($('start-writer').value);
    if (!w) { $('start-err').hidden = false; $('start-writer').focus(); return; }
    await store.kvSet('firstRunDone', true);
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
  $('safe-check').addEventListener('click', () => { outbox.checkNow(); updateWaiting(); });
  window.addEventListener('online', updateWaiting);
  window.addEventListener('offline', updateWaiting);
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

  outbox.startup();      // upload what waits, missing previews, and one listing: check + progress
}

window.__hw = { app, store, hf, outbox, get library() { return app.library; }, saveDisplay, safetyTexts, updateStatus: updateWaiting, get capture() { return app.capture; }, get generate() { return app.generate; }, get training() { return app.training; } };
window.__hwReady = boot().then(() => true, (e) => { console.error(e); return false; });
