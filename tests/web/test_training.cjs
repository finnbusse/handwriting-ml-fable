// The Training tab, against a fake model repo (huggingface.co) and a fake trainer Space
// (<user>-handschrift-training.hf.space):
//   every state (signed out, too few lines, ready, asleep/waking, not set up, refused,
//   broken, starting, running, stopping, stopped, failed, interrupted, done, run elsewhere),
//   start / stop / resume, options, errors, reopening during a run, gentle polling,
//   touch targets, screenshots (tablet and phone, light and dark).
const L = require('./lib.cjs');

const U = L.FAKE_USER;
const REPO = `/${U}/handwriting-fable-model/resolve/main/`;
const RUNNER = `https://${U}-handschrift-training.hf.space`;
const TIMING = { poll: 400, fast: 200, wakeEvery: 150, wakeLimit: 5000, restartAfter: 700 };
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d+Z$/, 'Z');
const MIN = 60000;
let SAMPLE_PNG = null;

/** A sample picture like the driver's: written lines, real ones black, the model's blue (drawn, not real handwriting). */
async function makeSample(browser) {
  const page = await browser.newPage();
  const data = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 1000; c.height = 510;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    const texts = ['Heute ist ein schöner Tag', 'Viele Grüße aus Detmold', 'Treffen um 14:30 Uhr'];
    let y = 22;
    texts.forEach((t, k) => {
      for (const [who, color] of [['Deine Schrift', '#000'], ['Modell', '#2141B8']]) {
        g.fillStyle = '#222'; g.font = '11px sans-serif'; g.fillText(`${who}: ${t}`, 40, y);
        g.strokeStyle = color; g.lineWidth = 2.2; g.beginPath();
        for (let x = 0; x < 640; x += 2) {
          const yy = y + 34 + 12 * Math.sin(x / (7 + k)) * Math.cos(x / 41) + (who === 'Modell' ? 1.5 * Math.sin(x / 13) : 0);
          if (x === 0 || x % 90 === 0) g.moveTo(80 + x, yy); else g.lineTo(80 + x, yy);
        }
        g.stroke(); y += 85;
      }
    });
    return c.toDataURL('image/png');
  });
  await page.close();
  return Buffer.from(data.split(',')[1], 'base64');
}

function mkStatus(state, o = {}) {
  return Object.assign({
    format: 1, run_id: 'r1', state, runner: 'space', runner_url: null, started: iso(22 * MIN), updated: iso(MIN),
    epoch: 7, epochs: 30, best_epoch: 6, scores: [-1.4, -1.62, -1.71, -1.76, -1.8, -1.83, -1.86, -1.85],
    minutes: 21.4, minutes_left: 70, epoch_minutes: 3, lines: 125, data: { train_lines: 160 }, writer: 'finn',
    lines_only: false, resumed_from: null, sample_epoch: 7, sample_kind: 'progress', checkpoint_epoch: 5,
    message: null, error: null, model_sha256: null,
  }, o);
}

/** The fake world: model repo, dataset listing, the Space's state on the Hub, the runner service. */
function world(init = {}) {
  const w = Object.assign({
    status: null, trainedOn: { lines: 100, date: '2026-11-20T10:00:00+00:00', writer: 'finn' }, lines: 125,
    stopFile: false, sample: true, offline: false,
    stage: 'RUNNING', missing: false, up: true, owner: U, running: false, job: null,
    wakeAfter: 0, startMode: 'ok', startFailExit: null,
    defaults: { epochs: 30, lines_only: false, sample_every: 1, max_minutes: 240, writer: 'finn' },
    commits: [], starts: [], stops: 0, wakes: 0, restarts: 0, statusGets: 0, modelJsonGets: 0, runnerAuth: [],
  }, init);
  w.hf = async (req) => {
    if (w.offline) return 'abort';
    const u = new URL(req.url);
    const p = u.pathname;
    if (p === '/api/whoami-v2') return { status: 200, body: { name: U } };
    if (p.startsWith(REPO)) {
      const f = p.slice(REPO.length);
      const nf = { status: 404, headers: { 'x-error-code': 'EntryNotFound' } };
      if (f === 'training/status.json') { w.statusGets++; return w.status ? { status: 200, body: w.status } : nf; }
      if (f === 'trained_on.json') return w.trainedOn ? { status: 200, body: w.trainedOn } : nf;
      if (f === 'training/sample.png') return w.sample ? { status: 200, headers: { 'content-type': 'image/png' }, body: SAMPLE_PNG } : nf;
      if (f === 'training/stop') return w.stopFile ? { status: 200, body: '{}' } : nf;
      if (f === 'model.json') { w.modelJsonGets++; return nf; }
      return nf;
    }
    if (p === `/api/datasets/${U}/handwriting-fable/tree/main/raw/v1/finn`) {
      return { status: 200, body: Array.from({ length: w.lines }, (_, k) => ({ type: 'file', path: `raw/v1/finn/s1/de-core-${k}__x.json` })) };
    }
    if (p === `/api/models/${U}/handwriting-fable-model/commit/main` && req.method === 'POST') {
      const nd = req.body.split('\n').map((l) => JSON.parse(l));
      const files = nd.filter((x) => x.key === 'file').map((x) => x.value.path);
      w.commits.push({ files, auth: req.headers.authorization });
      if (files.includes('training/stop')) w.stopFile = true;
      return { status: 200, body: { success: true } };
    }
    if (p === `/api/spaces/${U}/handschrift-training`) {
      if (w.missing) return { status: 404, headers: { 'x-error-code': 'RepoNotFound' } };
      return { status: 200, body: { id: `${U}/handschrift-training`, runtime: { stage: w.stage } } };
    }
    if (p === `/api/spaces/${U}/handschrift-training/restart` && req.method === 'POST') {
      w.restarts++; w.stage = 'APP_STARTING'; w.wakeAfter = Math.min(w.wakeAfter, w.wakes + 2);
      return { status: 200, body: {} };
    }
    return null;
  };
  w.routes = async (ctx) => {
    await ctx.route(/^https:\/\/[a-z0-9-]+\.hf\.space\//, async (route, request) => {
      const u = new URL(request.url());
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST' };
      if (u.origin !== RUNNER) return route.abort('connectionrefused');
      if (u.pathname === '/' && request.method() === 'GET') {           // the no-cors wake-up visit
        w.wakes++;
        if (!w.up && w.wakeAfter && w.wakes >= w.wakeAfter) { w.up = true; w.stage = 'RUNNING'; }
        return route.fulfill({ status: 200, body: 'ok' });
      }
      if (w.offline || !w.up) return route.abort('connectionrefused');   // asleep: Hugging Face's page has no CORS headers
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const json = (status, body) => route.fulfill({ status, headers: Object.assign({ 'content-type': 'application/json' }, cors), body: JSON.stringify(body) });
      const auth = request.headers().authorization;
      w.runnerAuth.push(auth || null);
      const owner = auth === `Bearer ${L.FAKE_TOKEN}` && w.owner === U;
      if (u.pathname === '/status') {
        const job = w.job && Object.assign({}, w.job, owner ? { log: ['epoch 1'], message: w.job.message || null } : {});
        return json(200, { service: 'handschrift-training', owner: w.owner, running: w.running, job, defaults: w.defaults, authorized: owner });
      }
      if (u.pathname === '/start' && request.method() === 'POST') {
        const body = JSON.parse(request.postData() || '{}');
        w.starts.push({ body, auth });
        if (w.startMode === '500') return json(500, { ok: false, error: 'server' });
        if (w.startMode === 'owner' || w.owner !== U) return json(403, { ok: false, error: 'owner' });
        if (w.running) return json(409, { ok: false, error: 'busy' });
        const runId = `run-${w.starts.length}`;
        w.job = { run_id: runId, started: iso(0), finished: null, exit_code: null, stop_requested: false };
        if (w.startFailExit) {                                         // the driver ends before its first status
          Object.assign(w.job, { exit_code: 1, finished: iso(0), message: w.startFailExit });
        } else {
          w.running = true;
          w.status = mkStatus('starting', { run_id: runId, epoch: 0, scores: [], best_epoch: null, sample_epoch: null, checkpoint_epoch: null, started: iso(0), updated: iso(0), minutes_left: null, resumed_from: body.resume ? 5 : null });
        }
        return json(200, { ok: true, run_id: runId, started: iso(0) });
      }
      if (u.pathname === '/stop' && request.method() === 'POST') {
        w.stops++;
        if (!w.running) return json(409, { ok: false, error: 'idle' });
        w.job.stop_requested = true;
        return json(200, { ok: true });
      }
      return json(404, {});
    });
  };
  return w;
}

async function open(browser, server, w, opts = {}) {
  const A = await L.newApp(browser, server, Object.assign({
    hash: '#/training', signedIn: true, hf: w.hf, routes: w.routes,
    init: `self.HW_TRAINING_TIMING = ${JSON.stringify(TIMING)};`,
  }, opts));
  return A;
}

const kind = (page) => page.evaluate(() => window.__hw.training.debug().kind);
const waitKind = (page, k, timeout = 8000) => L.until(async () => (await kind(page)) === k, timeout, 40)
  .catch(async () => { throw new Error(`expected state ${k}, have ${await kind(page)}`); });
const text = (page) => page.textContent('#trn-text-in');
const sub = (page) => page.textContent('#trn-sub');
const visible = (page, sel) => page.isVisible(sel);
const mainLabel = async (page) => (await visible(page, '#trn-main')) ? page.textContent('#trn-main') : (await visible(page, '#trn-main-link')) ? page.textContent('#trn-main-link') : null;

/** Every visible button / link / field of the tab and the top bar is at least 48 x 48 CSS px. */
async function targets(page) {
  return page.evaluate(() => [...document.querySelectorAll('#v-training button, #v-training a, #v-training input, #v-training select, #v-training summary, .bar a, .bar button')]
    .filter((e) => e.checkVisibility({ visibilityProperty: true }) && !e.hidden)
    .map((e) => { const t = e.matches('input') && e.closest('label') || e; const r = t.getBoundingClientRect(); return [e.id || e.textContent.trim().slice(0, 20) || e.tagName, Math.round(r.width), Math.round(r.height)]; })
    .filter(([, w, h]) => w < 47.5 || h < 47.5));
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function checkLayout(page, tag) {
  const small = await targets(page);
  L.check(`${tag}: touch targets at least 48 px`, small.length === 0, JSON.stringify(small));
  L.check(`${tag}: no horizontal scrolling`, await noHScroll(page));
}

// ---------------------------------------------------------------- scenes

async function signedOutAndFew(browser, server) {
  const w = world();
  let A = await open(browser, server, w, { signedIn: false });
  await waitKind(A.page, 'signedout');
  L.check('signed out: asks to sign in', /Melde dich an/.test(await text(A.page)) && (await mainLabel(A.page)) === 'Anmelden');
  L.check('signed out: the tab is in the top bar and current', (await A.page.getAttribute('a[data-route="training"]', 'aria-current')) === 'page');
  L.check('signed out: nothing asked of Hugging Face or the runner', w.statusGets === 0 && w.runnerAuth.length === 0);
  await checkLayout(A.page, 'signed out');
  await L.shot(A.page, 'training-01-signedout');
  await A.page.click('#trn-main');
  L.check('signed out: "Anmelden" opens the sign-in', await A.page.isVisible('#dlg-token'));
  await A.ctx.close();

  const w2 = world({ lines: 12 });
  A = await open(browser, server, w2);
  await waitKind(A.page, 'few');
  L.check('few lines: says how many are needed and there are', (await text(A.page)) === 'Für ein Training braucht es mindestens 20 Zeilen. Bisher sind es 12.', await text(A.page));
  L.check('few lines: sends to Erfassen', (await mainLabel(A.page)) === 'Zeilen schreiben' && (await A.page.getAttribute('#trn-main-link', 'href')) === '#/erfassen');
  L.check('few lines: no start, no options', !(await visible(A.page, '#trn-main')) && !(await visible(A.page, '#trn-adv')));
  await A.ctx.close();
}

async function readyStartSleepingRunFlow(browser, server) {
  const w = world({ up: false, stage: 'SLEEPING', wakeAfter: 4 });
  const A = await open(browser, server, w);
  const { page } = A;
  await waitKind(page, 'ready');
  L.check('ready: lines and new lines', (await text(page)) === '125 Zeilen sind da, 25 davon neu seit dem letzten Training.', await text(page));
  L.check('ready: one main action "Training starten"', (await mainLabel(page)) === 'Training starten' && !(await visible(page, '#trn-second')));
  L.check('ready: says it can take a while and the app may close', /Du kannst die App dabei schließen/.test(await sub(page)), await sub(page));
  L.check('ready: "Erweitert" is there but closed', await visible(page, '#trn-adv') && !(await page.evaluate(() => document.getElementById('trn-adv').open)));
  L.check('ready: a sleeping runner is woken quietly on opening', w.wakes >= 1, String(w.wakes));
  await checkLayout(page, 'ready');
  await L.shot(page, 'training-02-ready-tablet');
  await page.click('#trn-adv summary');
  await page.waitForTimeout(100);
  L.check('options: defaults are the driver\'s', (await page.inputValue('#trn-epochs')) === '30' && (await page.inputValue('#trn-every')) === '1' && !(await page.isChecked('#trn-lines')));
  await checkLayout(page, 'options open');
  await L.shot(page, 'training-03-ready-options');
  await page.click('#trn-adv summary');

  // start: the runner is asleep -> waking, then it answers and the run starts
  w.up = false; w.wakes = 0; w.wakeAfter = 4;
  await page.click('#trn-main');
  await waitKind(page, 'waking', 4000);
  L.check('asleep: one plain sentence, no button', /wird geweckt/.test(await text(page)) && !(await mainLabel(page)) && await visible(page, '#trn-dot'));
  await L.shot(page, 'training-04-waking');
  await L.until(() => w.starts.length === 1, 8000);
  L.check('start: sent once the runner answered, with the token, no options changed = none sent',
    JSON.stringify(w.starts[0].body) === '{}' && w.starts[0].auth === `Bearer ${L.FAKE_TOKEN}`, JSON.stringify(w.starts[0]));
  await waitKind(page, 'starting');
  L.check('starting: says the lines are loaded, offers to stop', /Das Training beginnt/.test(await text(page)) && (await mainLabel(page)) === 'Abbrechen');
  await L.shot(page, 'training-05-starting');

  // the driver reports rounds
  w.status = mkStatus('running', { run_id: 'run-1', epoch: 0, scores: [-1.4], best_epoch: null, sample_epoch: 0, minutes_left: null, epoch_minutes: null, started: iso(2 * MIN), updated: iso(0) });
  await L.until(async () => /Die erste Runde läuft/.test(await page.textContent('#trn-left')), 4000);
  L.check('running, round 1: no time estimate yet', (await page.textContent('#trn-round')) === 'Runde 1 von 30');
  w.status = mkStatus('running', { run_id: 'run-1', updated: iso(0) });
  await L.until(async () => (await page.textContent('#trn-round')) === 'Runde 8 von 30', 4000);
  L.check('running: "Runde 8 von 30" and roughly how long', (await page.textContent('#trn-left')) === 'noch etwa eine Stunde', await page.textContent('#trn-left'));
  L.check('running: progress bar at 7 of 30', (await page.getAttribute('#trn-bar', 'aria-valuenow')) === '23');
  L.check('running: where it runs', /^Läuft auf Hugging Face, seit \d\d:\d\d Uhr\. Es lernt aus 125 Zeilen\.$/.test(await sub(page)), await sub(page));
  await L.until(() => page.evaluate(() => { const i = document.getElementById('trn-sample-img'); return i.complete && i.naturalWidth === 1000 && !document.getElementById('trn-sample').hidden; }), 4000);
  L.check('running: the latest sample is shown', true);
  L.check('running: sample caption names the round', (await page.textContent('#trn-sample-cap')).startsWith('Stand nach Runde 7.'));
  const curve = await page.evaluate(() => ({ pts: document.querySelector('#trn-svg polyline').getAttribute('points').split(' ').length, best: document.querySelectorAll('#trn-svg .dot.best').length, label: document.getElementById('trn-svg').getAttribute('aria-label'), cap: document.querySelector('#trn-curve figcaption').textContent }));
  L.check('running: a small curve of the score, the best round marked, labelled in words', curve.pts === 8 && curve.best === 1 && curve.cap === 'Abweichung von deiner Schrift, niedriger ist besser' && /gesunken/.test(curve.label), JSON.stringify(curve));
  L.check('running: no start button, no options', !(await visible(page, '#trn-adv')) && (await mainLabel(page)) === 'Abbrechen');
  await checkLayout(page, 'running');
  await L.shot(page, 'training-06-running-tablet');

  // tap the sample to enlarge
  await page.click('#trn-sample-open');
  L.check('sample: tap enlarges it', await page.evaluate(() => document.getElementById('trn-zoom').open));
  await L.shot(page, 'training-07-sample-zoom');
  await page.click('#trn-zoom-close');
  L.check('sample: "Schließen" closes', !(await page.evaluate(() => document.getElementById('trn-zoom').open)));

  // reopening the page during the run: the same picture, from the repo alone
  const page2 = await A.ctx.newPage();
  await page2.goto(server.url + '#/training');
  await page2.waitForFunction(() => window.__hwReady);
  await waitKind(page2, 'running');
  L.check('reopened during a run: shows the run at once', (await page2.textContent('#trn-round')) === 'Runde 8 von 30');
  await page2.close();

  // stop
  await page.click('#trn-main');
  L.check('stop: asks first', await page.evaluate(() => document.getElementById('trn-confirm').open));
  L.check('stop: the question says what is kept', /Bis Runde 5 ist alles gesichert/.test(await page.textContent('#trn-confirm-text')));
  await L.shot(page, 'training-08-stop-confirm');
  await page.click('#trn-confirm-no');
  L.check('stop: "Weiterlaufen lassen" changes nothing', w.commits.length === 0 && w.stops === 0);
  await page.click('#trn-main');
  await page.click('#trn-confirm-yes');
  await L.until(() => w.commits.length === 1 && w.stops === 1, 4000);
  L.check('stop: training/stop written to the model repo, and the runner told', w.commits[0].files.join() === 'training/stop' && w.commits[0].auth === `Bearer ${L.FAKE_TOKEN}`);
  await L.until(async () => /nach dieser Runde beendet/.test(await text(page)), 3000);
  L.check('stop: says it ends after this round, button disabled', await page.isDisabled('#trn-main') && (await mainLabel(page)) === 'Wird beendet …');
  await L.shot(page, 'training-09-stopping');
  w.status = mkStatus('stopped', { run_id: 'run-1', epoch: 8, checkpoint_epoch: 8, message: 'Abgebrochen nach Runde 8.', updated: iso(0) });
  w.stopFile = false; w.running = false; w.job.exit_code = 0;
  await waitKind(page, 'stopped');
  L.check('stopped: the reason in plain words', (await text(page)) === 'Abgebrochen nach Runde 8.' && /weitermachen/.test(await sub(page)));
  L.check('stopped: "Fortsetzen", and quietly "Von vorn beginnen"', (await mainLabel(page)) === 'Fortsetzen' && (await page.textContent('#trn-second')) === 'Von vorn beginnen');
  await checkLayout(page, 'stopped');
  await L.shot(page, 'training-10-stopped');

  // resume
  await page.click('#trn-main');
  await L.until(() => w.starts.length === 2, 5000);
  L.check('resume: start with {resume: true}', JSON.stringify(w.starts[1].body) === '{"resume":true}', JSON.stringify(w.starts[1].body));
  await waitKind(page, 'starting');

  // ... it runs to the end: done, and Schreiben is told to look for the new model
  const before = w.modelJsonGets;
  w.status = mkStatus('publishing', { run_id: 'run-2', epoch: 30, updated: iso(0) });
  await waitKind(page, 'publishing');
  L.check('publishing: "Fast fertig", no button', /Fast fertig/.test(await text(page)) && !(await mainLabel(page)));
  w.status = mkStatus('done', { run_id: 'run-2', epoch: 30, best_epoch: 27, sample_epoch: 27, sample_kind: 'best', updated: iso(0), minutes_left: 0, model_sha256: 'ab'.repeat(32), scores: Array.from({ length: 31 }, (_, k) => -1.4 - 0.5 * (1 - Math.exp(-k / 6)) + (k > 27 ? 0.003 * (k - 27) : 0)) });
  w.trainedOn = { lines: 125, date: iso(0), writer: 'finn' };
  w.running = false;
  await waitKind(page, 'done');
  await L.until(() => w.modelJsonGets > before, 4000);
  L.check('done: Schreiben looked for the new model at once', w.modelJsonGets > before);
  L.check('done: says the new model is in use', (await text(page)) === 'Fertig. Dein neues Modell ist jetzt in Gebrauch.' && /Am besten war Runde 27/.test(await sub(page)), await sub(page));
  L.check('done: "Ausprobieren" leads to Schreiben', (await mainLabel(page)) === 'Ausprobieren' && (await page.getAttribute('#trn-main-link', 'href')) === '#/schreiben');
  await L.until(async () => (await page.textContent('#trn-sample-cap')).startsWith('So schreibt das fertige Modell'), 3000);
  L.check('done: with the final sample', true);
  await checkLayout(page, 'done');
  await L.shot(page, 'training-11-done');
  const refreshedOnce = w.modelJsonGets;
  await page.waitForTimeout(1200);
  L.check('done: the model refresh is asked for once, not on every poll', w.modelJsonGets === refreshedOnce, `${refreshedOnce} -> ${w.modelJsonGets}`);

  // gentle polling: nothing while another tab is shown
  await page.click('a[data-route="schreiben"]');
  await page.waitForTimeout(300);
  const n = w.statusGets;
  await page.waitForTimeout(1500);
  L.check('polling: stops while the tab is not shown', w.statusGets === n, `${n} -> ${w.statusGets}`);
  await page.click('a[data-route="training"]');
  await L.until(() => w.statusGets > n, 3000);
  L.check('polling: resumes when the tab is shown again', true);
  const errs = A.errors.filter((e) => !/Failed to load resource|ERR_|net::/.test(e));
  L.check('no page errors', errs.length === 0, errs.join(' | '));
  await A.ctx.close();
}

async function optionsSent(browser, server) {
  const w = world({ status: mkStatus('done', { updated: iso(3 * 24 * 60 * MIN), best_epoch: 12 }), lines: 140 });
  const { page, ctx } = await open(browser, server, w);
  await waitKind(page, 'ready');
  L.check('ready after an earlier training: new lines counted from trained_on.json', /140 Zeilen sind da, 40 davon neu/.test(await text(page)));
  await page.click('#trn-adv summary');
  await page.fill('#trn-epochs', '12');
  await page.selectOption('#trn-every', '5');
  await page.click('#trn-lines');
  await page.click('#trn-main');
  await L.until(() => w.starts.length === 1, 4000);
  L.check('options: only the changed ones are sent', JSON.stringify(w.starts[0].body) === '{"epochs":12,"sample_every":5,"lines_only":true}', JSON.stringify(w.starts[0].body));
  await ctx.close();
}

async function elsewhereAndStale(browser, server) {
  // a run started on GitHub: shown, no start button, stop through the repo only
  const w = world({ status: mkStatus('running', { runner: 'github', runner_url: 'https://github.com/x/y/actions/runs/1', updated: iso(2 * MIN) }) });
  let A = await open(browser, server, w);
  await waitKind(A.page, 'running');
  L.check('elsewhere: shows where it runs', /^Läuft auf GitHub/.test(await sub(A.page)), await sub(A.page));
  L.check('elsewhere: no start button while it runs, "Abbrechen" instead', (await mainLabel(A.page)) === 'Abbrechen' && !(await visible(A.page, '#trn-adv')));
  await A.page.click('#trn-main'); await A.page.click('#trn-confirm-yes');
  await L.until(() => w.commits.length === 1, 3000);
  L.check('elsewhere: stop goes through the model repo; the runner is not involved', w.stops === 0 && w.commits[0].files.join() === 'training/stop');
  await A.ctx.close();

  // a "running" status that has not moved for an hour: interrupted
  const w2 = world({ status: mkStatus('running', { updated: iso(60 * MIN) }) });
  A = await open(browser, server, w2);
  await waitKind(A.page, 'interrupted');
  L.check('stale: "stehen geblieben", with what is kept', /stehen geblieben/.test(await text(A.page)) && /Bis Runde 5 ist alles gesichert/.test(await sub(A.page)));
  L.check('stale: "Fortsetzen"', (await mainLabel(A.page)) === 'Fortsetzen');
  await L.shot(A.page, 'training-12-interrupted');
  await A.ctx.close();

  // the Space restarted (no job any more) two minutes after the last round
  const w3 = world({ status: mkStatus('running', { updated: iso(2 * MIN) }), running: false, job: null });
  A = await open(browser, server, w3);
  await waitKind(A.page, 'interrupted');
  L.check('runner lost its job: interrupted, not "running" forever', true);
  await A.ctx.close();

  // a failed run: the driver's reason; without a checkpoint "Nochmal versuchen"
  const w4 = world({ status: mkStatus('failed', { message: 'Die Verbindung zu Hugging Face ist abgebrochen.', checkpoint_epoch: null, updated: iso(5 * MIN) }) });
  A = await open(browser, server, w4);
  await waitKind(A.page, 'failed');
  L.check('failed: plain reason', (await text(A.page)) === 'Das Training hat nicht geklappt.' && (await sub(A.page)) === 'Die Verbindung zu Hugging Face ist abgebrochen.');
  L.check('failed: "Nochmal versuchen"', (await mainLabel(A.page)) === 'Nochmal versuchen' && !(await visible(A.page, '#trn-second')));
  await checkLayout(A.page, 'failed');
  await L.shot(A.page, 'training-13-failed');
  await A.ctx.close();
}

async function runnerProblems(browser, server) {
  // not set up
  let w = world({ missing: true, up: false });
  let A = await open(browser, server, w);
  await waitKind(A.page, 'nosetup');
  L.check('not set up: says so and names it', /noch nicht eingerichtet/.test(await text(A.page)) && (await sub(A.page)).includes(`${U}/handschrift-training`));
  L.check('not set up: "Nochmal prüfen"', (await mainLabel(A.page)) === 'Nochmal prüfen');
  await L.shot(A.page, 'training-14-nosetup');
  w.missing = false; w.up = true;
  await A.page.click('#trn-main');
  await waitKind(A.page, 'ready');
  L.check('not set up -> set up: "Nochmal prüfen" finds it', true);
  await A.ctx.close();

  // another account's runner
  w = world({ owner: 'someoneelse' });
  A = await open(browser, server, w);
  await waitKind(A.page, 'refused');
  L.check('refuses: another account, no button', /anderen Konto/.test(await text(A.page)) && !(await mainLabel(A.page)));
  await L.shot(A.page, 'training-15-refused');
  await A.ctx.close();

  // the runner says 403 at the start
  w = world({ startMode: 'owner' });
  A = await open(browser, server, w);
  await waitKind(A.page, 'ready');
  await A.page.click('#trn-main');
  await waitKind(A.page, 'refused');
  L.check('refuses at start (403): shown as "anderes Konto"', true);
  await A.ctx.close();

  // a server error at the start: a short note, try again
  w = world({ startMode: '500' });
  A = await open(browser, server, w);
  await waitKind(A.page, 'ready');
  await A.page.click('#trn-main');
  await L.until(async () => A.page.isVisible('#trn-note'), 4000);
  L.check('start error: plain note, still ready', (await A.page.textContent('#trn-note')) === 'Der Start hat nicht geklappt. Bitte versuch es noch einmal.' && (await kind(A.page)) === 'ready');
  await A.ctx.close();

  // the driver ended before its first status (e.g. a token that cannot write)
  w = world({ startFailExit: 'Dein Hugging-Face-Zugang darf das Modell nicht speichern. Bitte melde dich neu an.' });
  A = await open(browser, server, w);
  await waitKind(A.page, 'ready');
  await A.page.click('#trn-main');
  await waitKind(A.page, 'startfail');
  L.check('start failed early: the runner\'s reason', (await sub(A.page)).startsWith('Dein Hugging-Face-Zugang darf'), await sub(A.page));
  await A.ctx.close();

  // broken Space, and one that does not wake up (a restart is tried once)
  w = world({ up: false, stage: 'RUNTIME_ERROR' });
  A = await open(browser, server, w);
  await waitKind(A.page, 'broken');
  L.check('broken: link to the Space page', (await A.page.getAttribute('#trn-main-link', 'href')) === `https://huggingface.co/spaces/${U}/handschrift-training`);
  await A.ctx.close();
  w = world({ up: false, stage: 'SLEEPING', wakeAfter: 0 });
  A = await open(browser, server, w);
  await waitKind(A.page, 'ready');
  await A.page.click('#trn-main');
  await waitKind(A.page, 'waking');
  await waitKind(A.page, 'wakefail', 9000);
  L.check('never wakes: one restart was tried, then a plain sentence and "Nochmal versuchen"', w.restarts === 1 && (await mainLabel(A.page)) === 'Nochmal versuchen', String(w.restarts));
  await A.ctx.close();

  // offline at first, then back
  w = world({ offline: true });
  A = await open(browser, server, w);
  await waitKind(A.page, 'offline');
  L.check('offline: says it tries again', /nicht erreichbar/.test(await text(A.page)) && !(await mainLabel(A.page)));
  w.offline = false;
  await waitKind(A.page, 'ready', 5000);
  L.check('offline -> online: recovers by itself', true);
  await A.ctx.close();
}

async function phoneAndDark(browser, server) {
  for (const [scheme, vp, tag] of [['light', { width: 412, height: 915 }, 'phone'], ['dark', { width: 412, height: 915 }, 'phone-dark'], ['dark', { width: 1280, height: 800 }, 'tablet-dark']]) {
    for (const st of ['ready', 'running', 'done']) {
      const status = st === 'ready' ? null : st === 'running' ? mkStatus('running', { updated: iso(0) })
        : mkStatus('done', { epoch: 30, best_epoch: 27, sample_kind: 'best', sample_epoch: 27, updated: iso(0), scores: Array.from({ length: 31 }, (_, k) => -1.4 - 0.5 * (1 - Math.exp(-k / 6)) + (k > 27 ? 0.003 * (k - 27) : 0)) });
      const w = world({ status, trainedOn: st === 'done' ? { lines: 125, writer: 'finn' } : { lines: 100, writer: 'finn' } });
      const { page, ctx } = await open(browser, server, w, { viewport: vp, colorScheme: scheme, dsf: vp.width < 500 ? 2.625 : 2 });
      await waitKind(page, st);
      if (st !== 'ready') await L.until(() => page.evaluate(() => !document.getElementById('trn-sample').hidden && document.getElementById('trn-sample-img').naturalWidth > 0), 4000);
      await checkLayout(page, `${tag} ${st}`);
      const bar = await page.evaluate(() => { const b = document.getElementById('bar'); return b.scrollWidth <= b.clientWidth + 1; });
      L.check(`${tag} ${st}: the top bar with three tabs fits`, bar);
      await L.shot(page, `training-20-${tag}-${st}`);
      if (st === 'running' && vp.width < 500) {
        await page.evaluate(() => document.getElementById('v-training').scrollTo(0, 99999));
        await page.waitForTimeout(100);
        await L.shot(page, `training-21-${tag}-${st}-scrolled`);
      }
      await ctx.close();
    }
  }
}

(async () => {
  const server = await L.start();
  const browser = await L.launch();
  try {
    SAMPLE_PNG = await makeSample(browser);
    await signedOutAndFew(browser, server);
    await readyStartSleepingRunFlow(browser, server);
    await optionsSent(browser, server);
    await elsewhereAndStale(browser, server);
    await runnerProblems(browser, server);
    await phoneAndDark(browser, server);
  } catch (e) {
    console.error(e); L.check('test ran without exception', false, String(e && e.stack || e));
  } finally {
    await browser.close(); await server.close();
  }
  process.exit(L.summary() ? 0 : 1);
})();
