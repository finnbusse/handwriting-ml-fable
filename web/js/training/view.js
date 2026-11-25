// The Training tab: start a run on the trainer Space and follow any run.
//
// Everything shown comes from the model repo (training/status.json, training/sample.png,
// trained_on.json), the dataset listing and the trainer Space; nothing important lives
// in the page, so closing and reopening it during a run shows the same thing.
// It polls gently: every 20 s while the tab is visible, not at all while hidden.
import { createRunner } from './runner.js';
import { decide, view, isActive, curveLabel, FALLBACK_DEFAULTS } from './state.js';
import { drawCurve } from './curve.js';

const STATUS = 'training/status.json';
const SAMPLE = 'training/sample.png';
const STOP = 'training/stop';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HTML = `
<div class="trn" id="trn" data-kind="loading">
  <div class="trn-head">
    <p class="trn-text" id="trn-text" role="status" aria-live="polite"><span class="pen-dot" id="trn-dot" aria-hidden="true" hidden></span><span id="trn-text-in">Einen Moment …</span></p>
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
  </div>
  <p class="trn-note" id="trn-note" role="status" hidden></p>
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
  const T = Object.assign({ poll: 20000, fast: 5000, wakeEvery: 5000, wakeLimit: 5 * 60000, restartAfter: 30000 },
    self.HW_TRAINING_TIMING || {});
  const runner = deps.runner || createRunner({ hf });
  const root = document.getElementById('v-training');
  root.innerHTML = HTML;
  const $ = (id) => document.getElementById(id);
  const el = {
    trn: $('trn'), dot: $('trn-dot'), text: $('trn-text-in'), sub: $('trn-sub'),
    progress: $('trn-progress'), round: $('trn-round'), left: $('trn-left'), bar: $('trn-bar'), fill: $('trn-fill'),
    main: $('trn-main'), mainLink: $('trn-main-link'), second: $('trn-second'), note: $('trn-note'),
    sample: $('trn-sample'), sampleOpen: $('trn-sample-open'), sampleImg: $('trn-sample-img'), sampleCap: $('trn-sample-cap'),
    curve: $('trn-curve'), svg: $('trn-svg'), axisEnd: $('trn-axis-end'),
    adv: $('trn-adv'), epochs: $('trn-epochs'), every: $('trn-every'), linesOnly: $('trn-lines'),
    zoom: $('trn-zoom'), zoomImg: $('trn-zoom-img'), zoomClose: $('trn-zoom-close'),
    confirm: $('trn-confirm'), confirmText: $('trn-confirm-text'), confirmYes: $('trn-confirm-yes'), confirmNo: $('trn-confirm-no'),
  };

  const S = {
    visible: false, user: undefined, loaded: false, error: null,
    status: null, trainedOn: null, lines: null, runner: null, stopPending: false,
    action: null, pending: null, note: '', kind: 'loading',
    defaults: Object.assign({}, FALLBACK_DEFAULTS), dirty: {},
    sampleKey: null, sampleUrl: null, refreshedFor: null, timer: 0, loading: null, seq: 0,
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
    || (S.runner && S.runner.kind === 'ok' && S.runner.data.defaults && S.runner.data.defaults.writer)
    || ((deps.writer && deps.writer()) || {}).id || null;

  function resetFor(user) {
    S.user = user; S.loaded = false; S.error = null; S.status = null; S.trainedOn = null; S.lines = null;
    S.runner = null; S.action = null; S.pending = null; S.stopPending = false; S.note = '';
    S.sampleKey = null; setSample(null);
  }

  /** One look at everything; `full` also counts the lines and asks the trainer Space. */
  function load({ full = false } = {}) {
    if (S.loading) return S.loading;
    S.loading = (async () => {
      const user = hf.userName();
      if (user !== S.user) { resetFor(user); full = true; }
      if (!user) return;
      const seq = ++S.seq;
      try {
        const before = S.status;
        const askRunner = full || !!S.pending || (isActive(S.status) && S.status.runner === 'space');
        const [status, trainedOn, probe] = await Promise.all([
          readJson(STATUS),
          full || !S.loaded ? readJson('trained_on.json') : Promise.resolve(S.trainedOn),
          askRunner ? runner.probe() : Promise.resolve(S.runner),
        ]);
        if (seq !== S.seq || hf.userName() !== user) return;
        const finishedNow = isActive(before) && status && !isActive(status);
        S.status = status;
        S.runner = probe;
        if (probe && probe.kind === 'ok' && probe.data.defaults) S.defaults = Object.assign({}, FALLBACK_DEFAULTS, probe.data.defaults);
        S.trainedOn = finishedNow ? await readJson('trained_on.json') : trainedOn;
        if (full || S.lines === null || finishedNow) S.lines = await countLines(writerOf());
        S.stopPending = isActive(status) ? !!(await readFile(STOP)) : false;
        if (S.pending && status && status.run_id === S.pending.run_id) S.pending = null;
        S.loaded = true; S.error = null;
        if (full && probe && probe.kind === 'sleeping' && !isActive(status)) runner.wake();   // be awake by the time "Training starten" is tapped
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
      trainedOn: S.trainedOn, runner: S.runner, action: S.action, pending: S.pending, now: Date.now(),
    };
  }

  function setAction(node, link, a) {
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
    if (node === el.main) node.classList.toggle('primary', a.id !== 'stop');
  }

  function render() {
    const i = input();
    const kind = decide(i);
    const job = S.runner && S.runner.kind === 'ok' && S.runner.data.job;
    const v = view(kind, Object.assign(i, {
      stopPending: S.stopPending, defaults: S.defaults, spaceId: runner.spaceId(), pageUrl: runner.pageUrl(),
      runnerMessage: job && job.message,
    }));
    S.kind = kind;
    el.trn.dataset.kind = kind;
    el.text.textContent = v.text;
    el.dot.hidden = !v.busy;
    el.sub.textContent = v.sub || ''; el.sub.hidden = !v.sub;
    // progress
    el.progress.hidden = !v.progress;
    if (v.progress) {
      el.round.textContent = v.progress.round;
      el.left.textContent = v.progress.left || '';
      const pct = Math.round(100 * v.progress.fraction);
      el.fill.style.width = `${pct}%`;
      el.bar.setAttribute('aria-valuenow', String(pct));
    }
    // actions
    setAction(el.main, el.mainLink, v.main);
    el.second.hidden = !v.second;
    if (v.second) { el.second.textContent = v.second.label; el.second.dataset.act = v.second.id; }
    el.note.textContent = S.note; el.note.hidden = !S.note;
    // sample
    const st = S.status || {};
    const showSample = !!(v.sample && S.sampleUrl);
    el.sample.hidden = !showSample;
    if (showSample) {
      el.sampleCap.textContent = st.sample_kind === 'best'
        ? `So schreibt das fertige Modell. Oben jeweils deine Schrift, darunter das Modell.`
        : st.sample_epoch ? `Stand nach Runde ${st.sample_epoch}. Oben jeweils deine Schrift, darunter das Modell.`
          : 'Vor dem Training. Oben jeweils deine Schrift, darunter das Modell.';
    }
    // curve
    const drawn = !!v.curve && drawCurve(el.svg, st.scores, st.best_epoch);
    el.curve.hidden = !drawn;
    if (drawn) {
      el.svg.setAttribute('aria-label', curveLabel(st.scores));
      el.axisEnd.textContent = `Runde ${st.scores.length - 1}`;
    }
    // options
    el.adv.hidden = !v.options;
    if (v.options) fillOptions();
  }

  // ---------- options ("Erweitert") ----------

  function fillOptions() {
    const d = S.defaults;
    if (!S.dirty.epochs) el.epochs.value = String(d.epochs);
    if (!S.dirty.sample_every) el.every.value = String([0, 1, 2, 5].includes(d.sample_every) ? d.sample_every : 1);
    if (!S.dirty.lines_only) el.linesOnly.checked = !!d.lines_only;
  }

  /** Only what the writer changed is sent; everything else stays the driver's default. */
  function chosenOptions() {
    const o = {};
    const n = Math.round(Number(el.epochs.value));
    if (S.dirty.epochs && Number.isFinite(n) && n >= 1 && n <= 200 && n !== S.defaults.epochs) o.epochs = n;
    const every = Number(el.every.value);
    if (S.dirty.sample_every && every !== S.defaults.sample_every) o.sample_every = every;
    if (S.dirty.lines_only && el.linesOnly.checked !== !!S.defaults.lines_only) o.lines_only = el.linesOnly.checked;
    return o;
  }

  // ---------- start / stop ----------

  function note(text) { S.note = text || ''; render(); }

  async function startRun(options) {
    if (S.action && ['waking', 'launching'].includes(S.action.kind)) return;
    const user = hf.userName();
    if (!user) return;
    S.note = '';
    S.action = { kind: 'launching' }; render();
    const t0 = Date.now();
    let restarted = false, probe;
    for (;;) {
      probe = await runner.probe();
      S.runner = probe;
      if (hf.userName() !== user) { S.action = null; render(); return; }      // signed out meanwhile
      if (probe.kind === 'ok') break;
      if (probe.kind === 'missing') { S.action = { kind: 'nosetup' }; render(); return; }
      if (probe.kind === 'auth') { S.action = { kind: 'auth' }; S.error = 'auth'; render(); return; }
      if (probe.kind === 'broken' || probe.kind === 'paused') { S.action = null; render(); return; }
      // asleep or still starting: wake it and keep trying quietly
      if (S.action.kind !== 'waking') { S.action = { kind: 'waking' }; render(); }
      runner.wake();
      if (probe.kind === 'sleeping' && !restarted && Date.now() - t0 > T.restartAfter) { restarted = true; await runner.restart(); }
      if (Date.now() - t0 > T.wakeLimit) { S.action = { kind: 'wakefail' }; render(); return; }
      await sleep(T.wakeEvery);
    }
    if (probe.data.owner && probe.data.owner.toLowerCase() !== user.toLowerCase()) { S.action = { kind: 'refused' }; render(); return; }
    if (probe.data.running) { S.action = null; note('Auf dem Trainingsrechner läuft schon ein Training.'); await load(); schedule(); return; }
    S.action = { kind: 'launching' }; render();
    try {
      const r = await runner.start(options);
      S.pending = { run_id: r.run_id, at: Date.now() };
      S.action = null; S.stopPending = false;
    } catch (e) {
      if (e.kind === 'owner') S.action = { kind: 'refused' };
      else if (e.kind === 'auth') { S.action = { kind: 'auth' }; S.error = 'auth'; }
      else if (e.kind === 'busy') { S.action = null; S.note = 'Auf dem Trainingsrechner läuft schon ein Training.'; }
      else if (e.kind === 'options') { S.action = null; S.note = 'Diese Einstellungen gehen nicht. Bitte prüfe „Erweitert“.'; }
      else { S.action = null; S.note = 'Der Start hat nicht geklappt. Bitte versuch es noch einmal.'; }
    }
    render();
    await load();
    schedule();
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

  async function stopRun() {
    if (!(await confirmStop())) return;
    S.stopPending = true; S.note = ''; render();
    let asked = false;
    const st = S.status || {};
    try {
      await hf.commit(hf.modelRepoId(), 'Training abbrechen',
        [{ path: STOP, text: JSON.stringify({ requested_at: new Date().toISOString(), run_id: st.run_id || (S.pending && S.pending.run_id) || null }) }],
        { repoType: 'model' });
      asked = true;
    } catch (_) { /* the runner may still take it */ }
    if ((st.runner === 'space' || S.pending) && S.runner && S.runner.kind === 'ok') {
      try { await runner.stop(); asked = true; } catch (_) {}
    }
    if (!asked) { S.stopPending = false; S.note = 'Das Abbrechen hat nicht geklappt. Bitte versuch es noch einmal.'; }
    render();
    schedule();
  }

  function act(id) {
    if (id === 'signin') deps.signIn();
    else if (id === 'start') startRun(chosenOptions());
    else if (id === 'resume') startRun({ resume: true });
    else if (id === 'stop') stopRun();
    else if (id === 'recheck') { S.action = null; load({ full: true }); }
  }

  // ---------- polling ----------

  function schedule() {
    clearTimeout(S.timer);
    if (!S.visible || document.hidden) return;
    const fast = !!S.pending || S.stopPending || (S.action && ['waking', 'launching'].includes(S.action.kind));
    S.timer = setTimeout(async () => { await load(); schedule(); }, fast ? T.fast : T.poll);
  }

  function wire() {
    el.main.addEventListener('click', () => act(el.main.dataset.act));
    el.second.addEventListener('click', () => act(el.second.dataset.act));
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
    window.addEventListener('online', () => { if (S.visible) load().then(schedule); });
  }

  function init() { wire(); render(); }

  function show() {
    S.visible = true;
    if (S.action && !['waking', 'launching'].includes(S.action.kind)) S.action = null;
    S.note = '';
    render();
    load({ full: true }).then(schedule);
  }

  function hide() { S.visible = false; clearTimeout(S.timer); }

  return {
    init, show, hide,
    /** For tests. */
    debug: () => ({ kind: S.kind, status: S.status, lines: S.lines, runner: S.runner, action: S.action, pending: S.pending, stopPending: S.stopPending, sampleKey: S.sampleKey, defaults: S.defaults, refreshedFor: S.refreshedFor }),
  };
}
