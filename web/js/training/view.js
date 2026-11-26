// The Training tab: start a run on GitHub and follow any run.
//
// Everything shown comes from the model repo (training/status.json, training/sample.png,
// trained_on.json), the dataset listing and the workflow's runs on GitHub; nothing
// important lives in the page, so closing and reopening it shows the same thing.
// Hugging Face is read every 20 s while the tab is visible, not at all while hidden.
// GitHub is asked sparingly (60 requests per hour per address without a token):
// on opening the tab, while a start is awaited, and now and then while a run is on.
import { createGitHub, runActive } from './github.js';
import { decide, view, isActive, curveLabel, DEFAULTS } from './state.js';
import { drawCurve } from './curve.js';

const STATUS = 'training/status.json';
const SAMPLE = 'training/sample.png';
const STOP = 'training/stop';
const OFFERED = 'hw.github.offered';
const SLACK = 60000;          // clocks of browser and GitHub may differ a little

const HTML = `
<div class="trn" id="trn" data-kind="loading">
  <div class="trn-head">
    <p class="trn-text" id="trn-text" role="status" aria-live="polite"><span id="trn-text-in">Einen Moment …</span><span class="pen-dot" id="trn-dot" aria-hidden="true" hidden></span></p>
    <p class="trn-sub" id="trn-sub" hidden></p>
  </div>
  <div class="trn-progress" id="trn-progress" hidden>
    <div class="trn-progress-row"><span id="trn-round"></span><span class="trn-left" id="trn-left"></span></div>
    <div class="trn-bar" id="trn-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-labelledby="trn-round"><span id="trn-fill"></span></div>
  </div>
  <div class="trn-actions" id="trn-actions">
    <button class="btn primary" id="trn-main" type="button" hidden></button>
    <a class="btn primary" id="trn-main-link" hidden></a>
    <button class="btn quiet" id="trn-second" type="button" hidden></button>
    <a class="btn quiet" id="trn-second-link" hidden></a>
  </div>
  <p class="trn-note" id="trn-note" role="status" hidden></p>
  <p class="trn-offer" id="trn-offer" hidden><span>Mit einem GitHub-Schlüssel startet das Training direkt von hier, ohne Umweg über GitHub.</span><a class="btn quiet" href="#/einstellungen" id="trn-offer-link">Einrichten</a></p>
  <figure class="trn-sample" id="trn-sample" hidden>
    <button class="trn-paper" id="trn-sample-open" type="button" aria-label="Probe groß anzeigen"><img id="trn-sample-img" alt="Probe: deine Zeilen und wie das Modell sie schreibt"></button>
    <figcaption id="trn-sample-cap"></figcaption>
  </figure>
  <figure class="trn-curve" id="trn-curve" hidden>
    <svg id="trn-svg" role="img" aria-label=""></svg>
    <div class="trn-axis" aria-hidden="true"><span>Start</span><span id="trn-axis-end"></span></div>
    <figcaption>Abweichung von deiner Schrift, niedriger ist besser</figcaption>
  </figure>
  <details class="trn-adv" id="trn-adv" hidden>
    <summary>Erweitert</summary>
    <div class="trn-adv-body">
      <label class="trn-field" for="trn-epochs">
        <span class="trn-field-text"><strong>Höchstens so viele Runden</strong><span class="muted">Es hört früher auf, wenn es nicht mehr besser wird.</span></span>
        <input id="trn-epochs" type="number" min="1" max="200" step="1" inputmode="numeric">
      </label>
      <label class="trn-field" for="trn-every">
        <span class="trn-field-text"><strong>Probe zeichnen</strong><span class="muted">Wie oft du siehst, wie das Modell gerade schreibt.</span></span>
        <select id="trn-every">
          <option value="1">nach jeder Runde</option>
          <option value="2">alle 2 Runden</option>
          <option value="5">alle 5 Runden</option>
          <option value="0">nie</option>
        </select>
      </label>
      <label class="switch-row trn-field" for="trn-lines">
        <span><strong>Nur ganze Zeilen</strong><span class="muted">Ohne die frühen Einzelwörter und Ziffern.</span></span>
        <input type="checkbox" role="switch" id="trn-lines">
      </label>
    </div>
  </details>
</div>
<dialog class="dlg trn-zoom" id="trn-zoom" aria-labelledby="trn-zoom-title">
  <div class="trn-zoom-head"><h2 id="trn-zoom-title">Probe</h2><button class="btn" id="trn-zoom-close" type="button">Schließen</button></div>
  <div class="trn-zoom-body"><img id="trn-zoom-img" alt="Probe: deine Zeilen und wie das Modell sie schreibt"></div>
</dialog>
<dialog class="dlg" id="trn-confirm" aria-labelledby="trn-confirm-title">
  <h2 id="trn-confirm-title">Training abbrechen?</h2>
  <p id="trn-confirm-text"></p>
  <div class="actions">
    <button class="btn" id="trn-confirm-no" type="button">Weiterlaufen lassen</button>
    <button class="btn primary" id="trn-confirm-yes" type="button">Abbrechen</button>
  </div>
</dialog>`;

export function createTrainingView(deps) {
  const { hf } = deps;
  const T = Object.assign({
    poll: 20000, fast: 5000,
    ghOpen: 60000,          // on opening the tab: ask GitHub if the last answer is older than this
    ghPending: 30000,       // while a start is awaited (without a token; with one: half)
    ghBusy: 60000,          // while a run is queued or running without a status yet
    ghActive: 5 * 60000,    // while a status says a GitHub run is training
    pendingMax: 15 * 60000, // give up waiting for a start after this long
  }, self.HW_TRAINING_TIMING || {});
  const gh = deps.github || createGitHub();
  const root = document.getElementById('v-training');
  root.innerHTML = HTML;
  const $ = (id) => document.getElementById(id);
  const el = {
    trn: $('trn'), dot: $('trn-dot'), text: $('trn-text-in'), sub: $('trn-sub'),
    progress: $('trn-progress'), round: $('trn-round'), left: $('trn-left'), bar: $('trn-bar'), fill: $('trn-fill'),
    main: $('trn-main'), mainLink: $('trn-main-link'), second: $('trn-second'), secondLink: $('trn-second-link'), note: $('trn-note'),
    offer: $('trn-offer'),
    sample: $('trn-sample'), sampleOpen: $('trn-sample-open'), sampleImg: $('trn-sample-img'), sampleCap: $('trn-sample-cap'),
    curve: $('trn-curve'), svg: $('trn-svg'), axisEnd: $('trn-axis-end'),
    adv: $('trn-adv'), epochs: $('trn-epochs'), every: $('trn-every'), linesOnly: $('trn-lines'),
    zoom: $('trn-zoom'), zoomImg: $('trn-zoom-img'), zoomClose: $('trn-zoom-close'),
    confirm: $('trn-confirm'), confirmText: $('trn-confirm-text'), confirmYes: $('trn-confirm-yes'), confirmNo: $('trn-confirm-no'),
  };

  const S = {
    visible: false, user: undefined, loaded: false, error: null,
    status: null, trainedOn: null, lines: null, stopPending: false,
    run: null, runAt: 0, ghQuiet: false,
    action: null, pending: null, note: '', kind: 'loading', offerNow: false,
    dirty: {}, sampleKey: null, sampleUrl: null, refreshedFor: null, timer: 0, loading: null, seq: 0,
  };

  // ---------- reading ----------

  async function readFile(path) {
    try { return await hf.downloadFile(hf.modelRepoId(), path); }
    catch (e) {
      if (e.kind === 'notfound') return null;
      if (e.kind === 'auth') {                       // the Hub says 401 for a missing private repo too
        const why = await hf.classify401().catch(() => 'network');
        if (why === 'notfound') return null;
        e.kind = why;
      }
      throw e;
    }
  }

  async function readJson(path) {
    const res = await readFile(path);
    if (!res) return null;
    try { return await res.json(); } catch (_) { return null; }
  }

  async function countLines(writer) {
    const paths = await hf.listFiles(hf.datasetRepoId(), writer ? `raw/v1/${writer}` : 'raw/v1');
    return (paths || []).filter((p) => p.endsWith('.json')).length;
  }

  const writerOf = () => (S.status && S.status.writer) || (S.trainedOn && S.trainedOn.writer)
    || ((deps.writer && deps.writer()) || {}).id || null;

  function resetFor(user) {
    S.user = user; S.loaded = false; S.error = null; S.status = null; S.trainedOn = null; S.lines = null;
    S.action = null; S.pending = null; S.stopPending = false; S.note = '';
    S.sampleKey = null; setSample(null);
  }

  /** How long a GitHub answer may be old before it is asked again. */
  function ghMaxAge(full) {
    const st = S.status;
    if (S.pending) return gh.token() ? T.ghPending / 2 : T.ghPending;
    if (isActive(st) && st.runner === 'github') return T.ghActive;
    if (runActive(S.run)) return T.ghBusy;          // until GitHub says the run is over, there is no start button
    return full ? T.ghOpen : Infinity;
  }

  async function askGitHub(full) {
    if (Date.now() - S.runAt < ghMaxAge(full)) return;
    try {
      S.run = await gh.latestRun();
      S.runAt = Date.now();
      S.ghQuiet = false;
    } catch (e) {
      S.ghQuiet = e.kind === 'rate';       // calm: what is known stays, it is asked again later
      if (e.kind !== 'rate') S.runAt = Date.now();      // not again at once
    }
  }

  /** What GitHub and the status say about a start that was asked for. */
  function settlePending() {
    const p = S.pending;
    if (!p) return;
    const st = S.status, run = S.run;
    if (st && Date.parse(st.started) >= p.at - SLACK) { S.pending = null; return; }        // the run reports
    if (run && Date.parse(run.created_at) >= p.at - SLACK) {
      p.manual = false;                                                                   // it was started
      if (run.status === 'completed') S.pending = null;                                   // and ended early
      return;
    }
    if (Date.now() - p.at > T.pendingMax) S.pending = null;
  }

  /** One look at everything; `full` also counts the lines. */
  function load({ full = false } = {}) {
    if (S.loading) return S.loading;
    S.loading = (async () => {
      const user = hf.userName();
      if (user !== S.user) { resetFor(user); full = true; }
      if (!user) return;
      const seq = ++S.seq;
      try {
        const before = S.status;
        const [status, trainedOn] = await Promise.all([
          readJson(STATUS),
          full || !S.loaded ? readJson('trained_on.json') : Promise.resolve(S.trainedOn),
          askGitHub(full),
        ]);
        if (seq !== S.seq || hf.userName() !== user) return;
        // a run has ended since the last look (also one never seen running): trained_on.json and the count may have changed
        const finishedNow = !!status && !isActive(status) && !!before && (isActive(before) || before.run_id !== status.run_id);
        S.status = status;
        S.trainedOn = finishedNow ? await readJson('trained_on.json') : trainedOn;
        if (full || S.lines === null || finishedNow) S.lines = await countLines(writerOf());
        S.stopPending = isActive(status) ? !!(await readFile(STOP)) : false;
        settlePending();
        S.loaded = true; S.error = null;
        if (status && status.state === 'done' && status.run_id !== S.refreshedFor) {
          S.refreshedFor = status.run_id;
          if (deps.modelChanged) Promise.resolve().then(() => deps.modelChanged()).catch(() => {});
        }
        await loadSample();
      } catch (e) {
        S.error = e && e.kind === 'auth' ? 'auth' : 'network';
      }
    })().finally(() => { S.loading = null; render(); });
    return S.loading;
  }

  function setSample(url) {
    if (S.sampleUrl) URL.revokeObjectURL(S.sampleUrl);
    S.sampleUrl = url;
    el.sampleImg.src = url || '';
    el.zoomImg.src = url || '';
  }

  async function loadSample() {
    const st = S.status;
    if (!st || st.sample_epoch === null || st.sample_epoch === undefined) { S.sampleKey = null; setSample(null); return; }
    const key = `${st.run_id}:${st.sample_epoch}:${st.sample_kind}`;
    if (key === S.sampleKey) return;
    const res = await readFile(SAMPLE).catch(() => null);
    if (!res) return;
    const blob = await res.blob().catch(() => null);
    if (!blob) return;
    S.sampleKey = key;
    setSample(URL.createObjectURL(blob));
  }

  // ---------- drawing ----------

  function input() {
    return {
      signedIn: S.user || null, loaded: S.loaded, error: S.error, status: S.status, lines: S.lines,
      trainedOn: S.trainedOn, run: S.run, action: S.action, pending: S.pending, now: Date.now(),
    };
  }

  function setAction(node, link, a, primary) {
    node.hidden = true; link.hidden = true;
    if (!a) return;
    const target = a.href ? link : node;
    target.hidden = false;
    target.textContent = a.label;
    target.dataset.act = a.id;
    if (a.href) {
      link.href = a.href;
      if (a.external) { link.target = '_blank'; link.rel = 'noopener'; } else { link.removeAttribute('target'); link.removeAttribute('rel'); }
    } else node.disabled = !!a.disabled;
    if (primary) target.classList.toggle('primary', a.id !== 'stop' && a.id !== 'cancel');
  }

  function offerOnce(want) {
    if (!want) return false;
    if (S.offerNow) return true;
    let seen = false;
    try { seen = localStorage.getItem(OFFERED) === '1'; localStorage.setItem(OFFERED, '1'); } catch (_) {}
    S.offerNow = !seen;            // shown on this visit, then not again
    return S.offerNow;
  }

  function render() {
    const i = input();
    const kind = decide(i);
    const v = view(kind, Object.assign(i, {
      hasToken: !!gh.token(), stopPending: S.stopPending, page: gh.workflowPage(),
      canCancel: !!gh.token() && runActive(S.run),
    }));
    S.kind = kind;
    el.trn.dataset.kind = kind;
    el.text.textContent = v.text;
    el.dot.hidden = !v.busy;
    el.sub.textContent = v.sub || ''; el.sub.hidden = !v.sub;
    el.progress.hidden = !v.progress;
    if (v.progress) {
      el.round.textContent = v.progress.round;
      el.left.textContent = v.progress.left || '';
      const pct = Math.round(100 * v.progress.fraction);
      el.fill.style.width = `${pct}%`;
      el.bar.setAttribute('aria-valuenow', String(pct));
    }
    setAction(el.main, el.mainLink, v.main, true);
    setAction(el.second, el.secondLink, v.second, false);
    const note = S.note || (S.ghQuiet && (S.pending || ['ghstarting', 'ghbusy'].includes(kind))
      ? 'GitHub bittet um eine kurze Pause. Es geht gleich von selbst weiter.' : '');
    el.note.textContent = note; el.note.hidden = !note;
    el.offer.hidden = !offerOnce(v.offer);
    const st = S.status || {};
    const showSample = !!(v.sample && S.sampleUrl);
    el.sample.hidden = !showSample;
    if (showSample) {
      el.sampleCap.textContent = st.sample_kind === 'best'
        ? 'So schreibt das fertige Modell. Oben jeweils deine Schrift, darunter das Modell.'
        : st.sample_epoch ? `Stand nach Runde ${st.sample_epoch}. Oben jeweils deine Schrift, darunter das Modell.`
          : 'Vor dem Training. Oben jeweils deine Schrift, darunter das Modell.';
    }
    const drawn = !!v.curve && drawCurve(el.svg, st.scores, st.best_epoch);
    el.curve.hidden = !drawn;
    if (drawn) {
      el.svg.setAttribute('aria-label', curveLabel(st.scores));
      el.axisEnd.textContent = `Runde ${st.scores.length - 1}`;
    }
    el.adv.hidden = !v.options;
    if (v.options) fillOptions();
  }

  // ---------- options ("Erweitert"; only with a token: a start on GitHub's page uses its own form) ----------

  function fillOptions() {
    if (!S.dirty.epochs) el.epochs.value = String(DEFAULTS.epochs);
    if (!S.dirty.sample_every) el.every.value = String(DEFAULTS.sample_every);
    if (!S.dirty.lines_only) el.linesOnly.checked = !!DEFAULTS.lines_only;
  }

  /** The workflow's inputs: only what the writer changed; the rest stays the driver's default. A start from here always trains. */
  function inputs({ resume = false } = {}) {
    const o = { force: 'true', resume: resume ? 'true' : 'false' };
    if (resume) return o;                                       // a resumed run keeps its own settings
    const n = Math.round(Number(el.epochs.value));
    if (S.dirty.epochs && Number.isFinite(n) && n >= 1 && n <= 200 && n !== DEFAULTS.epochs) o.epochs = String(n);
    const every = Number(el.every.value);
    if (S.dirty.sample_every && every !== DEFAULTS.sample_every) o.sample_every = String(every);
    if (S.dirty.lines_only && el.linesOnly.checked !== !!DEFAULTS.lines_only) o.lines_only = el.linesOnly.checked ? 'ja' : 'nein';
    return o;
  }

  // ---------- start / stop ----------

  const GH_FAIL = {
    auth: 'Der GitHub-Schlüssel gilt nicht mehr. Du kannst ihn in den Einstellungen neu eintragen.',
    forbidden: 'Der GitHub-Schlüssel darf das Training nicht starten. Er braucht „Actions: Read and write“ für dieses Repository.',
    notfound: 'Der GitHub-Schlüssel darf das Training nicht starten. Er braucht „Actions: Read and write“ für dieses Repository.',
    rate: 'GitHub bittet um eine kurze Pause. Bitte versuch es in ein paar Minuten noch einmal.',
    network: 'Keine Verbindung zu GitHub. Bitte versuch es noch einmal.',
    other: 'GitHub hat den Start nicht angenommen. Bitte versuch es noch einmal.',
  };

  async function dispatch(resume) {
    if (S.action) return;
    S.note = '';
    S.action = { kind: 'dispatching' }; render();
    try {
      const run = await gh.latestRun();                 // never two runs: look right before starting
      S.run = run; S.runAt = Date.now();
      if (runActive(run)) { S.action = null; S.note = 'Auf GitHub läuft schon ein Lauf.'; render(); return; }
      const at = Date.now();
      await gh.dispatch(inputs({ resume }));
      S.pending = { at, manual: false, resume };
      S.runAt = 0;
    } catch (e) {
      S.note = GH_FAIL[e.kind] || GH_FAIL.other;
    }
    S.action = null;
    render();
    await load();
    schedule();
  }

  /** Without a token: the link opens the workflow on GitHub; here we wait for the run to show. */
  function manualStart(resume) {
    S.pending = { at: Date.now(), manual: true, resume };
    S.note = '';
    render(); schedule();
  }

  async function cancelRun() {
    const run = S.run;
    if (!run || !runActive(run)) return;
    try { await gh.cancel(run.id); S.note = ''; S.runAt = 0; }
    catch (e) { S.note = e.kind === 'rate' ? GH_FAIL.rate : 'Das Abbrechen hat nicht geklappt. Auf GitHub geht es auch.'; }
    render(); await load(); schedule();
  }

  function confirmStop() {
    const st = S.status || {};
    el.confirmText.textContent = Number.isInteger(st.checkpoint_epoch) && st.checkpoint_epoch > 0
      ? `Bis Runde ${st.checkpoint_epoch} ist alles gesichert. Du kannst später dort weitermachen.`
      : 'Es endet nach der laufenden Runde. Ein neues Modell gibt es dann nicht.';
    return new Promise((resolve) => {
      const done = (v) => { el.confirm.removeEventListener('close', onClose); el.confirmYes.onclick = null; el.confirmNo.onclick = null; if (el.confirm.open) el.confirm.close(); resolve(v); };
      const onClose = () => done(false);
      el.confirm.addEventListener('close', onClose);
      el.confirmYes.onclick = () => done(true);
      el.confirmNo.onclick = () => done(false);
      el.confirm.showModal();
    });
  }

  /** Any runner: training/stop in the model repo ends the run after the round (with a checkpoint). */
  async function stopRun() {
    if (!(await confirmStop())) return;
    S.stopPending = true; S.note = ''; render();
    const st = S.status || {};
    try {
      await hf.commit(hf.modelRepoId(), 'Training abbrechen',
        [{ path: STOP, text: JSON.stringify({ requested_at: new Date().toISOString(), run_id: st.run_id || null }) }],
        { repoType: 'model' });
    } catch (_) {
      S.stopPending = false; S.note = 'Das Abbrechen hat nicht geklappt. Bitte versuch es noch einmal.';
    }
    render();
    schedule();
  }

  function act(id) {
    if (id === 'signin') deps.signIn();
    else if (id === 'start') dispatch(false);
    else if (id === 'resume') dispatch(true);
    else if (id === 'manual') manualStart(false);
    else if (id === 'manual-resume') manualStart(true);
    else if (id === 'forget') { S.pending = null; render(); }
    else if (id === 'cancel') cancelRun();
    else if (id === 'stop') stopRun();
  }

  // ---------- polling ----------

  function schedule() {
    clearTimeout(S.timer);
    if (!S.visible || document.hidden) return;
    const fast = !!S.pending || S.stopPending || !!S.action;
    S.timer = setTimeout(async () => { await load(); schedule(); }, fast ? T.fast : T.poll);
  }

  function wire() {
    for (const n of [el.main, el.second, el.mainLink, el.secondLink]) n.addEventListener('click', () => act(n.dataset.act));
    el.sampleOpen.addEventListener('click', () => { if (S.sampleUrl) el.zoom.showModal(); });
    el.zoomClose.addEventListener('click', () => el.zoom.close());
    el.zoom.addEventListener('click', (e) => { if (e.target === el.zoom) el.zoom.close(); });
    el.epochs.addEventListener('input', () => { S.dirty.epochs = true; });
    el.every.addEventListener('change', () => { S.dirty.sample_every = true; });
    el.linesOnly.addEventListener('change', () => { S.dirty.lines_only = true; });
    document.addEventListener('visibilitychange', () => {
      if (!S.visible) return;
      if (document.hidden) clearTimeout(S.timer);
      else load().then(schedule);
    });
    window.addEventListener('hw-auth', () => { if (S.visible) load({ full: true }).then(schedule); });
    window.addEventListener('hw-github', () => { S.note = ''; render(); });
    window.addEventListener('online', () => { if (S.visible) load().then(schedule); });
  }

  function init() { wire(); render(); }

  function show() {
    S.visible = true;
    S.note = '';
    render();
    load({ full: true }).then(schedule);
  }

  function hide() { S.visible = false; clearTimeout(S.timer); }

  return {
    init, show, hide,
    /** For tests. */
    debug: () => ({ kind: S.kind, status: S.status, lines: S.lines, run: S.run, action: S.action, pending: S.pending, stopPending: S.stopPending, sampleKey: S.sampleKey, refreshedFor: S.refreshedFor }),
  };
}
