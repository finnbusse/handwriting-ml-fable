// The Training tab, against a fake model repo (huggingface.co) and a fake GitHub
// (api.github.com for the workflow's runs and the start, github.com for its page):
//   every state (signed out, too few lines, ready, waiting for a start by hand,
//   starting on GitHub, a run busy, a run that ended before any status, starting,
//   running, stopping, stopped, failed, interrupted, done, a run elsewhere),
//   start with and without a GitHub token, the token in Einstellungen, stop, resume,
//   options, rate limits, reopening during a run, gentle polling, touch targets,
//   screenshots (tablet and phone, light and dark).
const fs = require('fs');
const path = require('path');
const L = require('./lib.cjs');

const U = L.FAKE_USER;
const REPO = `/${U}/handwriting-fable-model/resolve/main/`;
const GH_REPO = 'finnbusse/handwriting-ml-fable';
const GH_PAGE = `https://github.com/${GH_REPO}/actions/workflows/retrain.yml`;
const GH_TOKEN = 'github_pat_11TESTONLYabcdefghijklmnopqrstuvwxyz_9wXy';
const TIMING = { poll: 400, fast: 200, ghOpen: 60000, ghPending: 600, ghBusy: 800, ghActive: 1500, pendingMax: 60000 };
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d+Z$/, 'Z');
const MIN = 60000;
let SAMPLE_PNG = null;
const RUN_URL = (id) => `https://github.com/${GH_REPO}/actions/runs/${id}`;

// The driver's defaults, read from scripts/retrain.py: the tab must offer the same.
const PYSRC = fs.readFileSync(path.resolve(__dirname, '..', '..', 'scripts', 'retrain.py'), 'utf8');
const PY = {
  EPOCHS: Number(/^EPOCHS = (\d+)/m.exec(PYSRC)[1]),
  SAMPLE_EVERY: Number(/^SAMPLE_EVERY = (\d+)/m.exec(PYSRC)[1]),
  LINES_ONLY: /^LINES_ONLY = (True|False)/m.exec(PYSRC)[1] === 'True',
};
const SCORES30 = Array.from({ length: 31 }, (_, k) => -1.4 - 0.5 * (1 - Math.exp(-k / 6)) + (k > 27 ? 0.003 * (k - 27) : 0));
let LEAK = false;     // the GitHub token seen anywhere but api.github.com

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
    format: 1, run_id: 'r1', state, runner: 'github', runner_url: RUN_URL(8999), started: iso(22 * MIN), updated: iso(MIN),
    epoch: 7, epochs: 30, best_epoch: 6, scores: [-1.4, -1.62, -1.71, -1.76, -1.8, -1.83, -1.86, -1.85],
    minutes: 21.4, minutes_left: 70, epoch_minutes: 3, lines: 125, data: { train_lines: 160 }, writer: 'finn',
    lines_only: false, resumed_from: null, sample_epoch: 7, sample_kind: 'progress', checkpoint_epoch: 5,
    message: null, error: null, model_sha256: null,
  }, o);
}


/** The fake world: model repo, dataset listing, GitHub. */
function world(init = {}) {
  const w = Object.assign({
    status: null, trainedOn: { lines: 100, date: '2026-11-20T10:00:00+00:00', writer: 'finn' }, lines: 125,
    stopFile: false, sample: true, offline: false,
    // GitHub
    branch: 'main', runs: [], nextRun: 9001, tokenOk: GH_TOKEN, tokenScope: true, rate: null, rateUntil: 0,
    autoRun: true,             // a dispatch makes a queued run at once
    dispatches: [], cancels: [], ghRequests: [], ghRunsGets: 0,
    commits: [], statusGets: 0, modelJsonGets: 0,
  }, init);
  w.hf = async (req) => {
    if (JSON.stringify(req).includes('github_pat')) LEAK = true;
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
    return null;
  };
  w.addRun = (o = {}) => {
    const id = w.nextRun++;
    const r = Object.assign({ id, run_number: id - 9000, status: 'queued', conclusion: null, created_at: iso(0), updated_at: iso(0), html_url: RUN_URL(id) }, o);
    w.runs.unshift(r);
    return r;
  };
  w.routes = async (ctx) => {
    await ctx.route(/^https:\/\/(api\.)?github\.com\//, async (route, request) => {
      const u = new URL(request.url());
      const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'ETag, Link, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset' };
      if (u.hostname === 'github.com' && JSON.stringify(request.headers()).includes('github_pat')) LEAK = true;
      if (u.hostname === 'github.com') return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>GitHub</title>workflow page' });
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: Object.assign({ 'access-control-allow-headers': 'Authorization, Content-Type, Accept', 'access-control-allow-methods': 'GET, POST' }, cors) });
      const auth = request.headers().authorization || null;
      w.ghRequests.push({ method: request.method(), path: u.pathname, auth });
      const json = (status, body, headers = {}) => route.fulfill({ status, headers: Object.assign({ 'content-type': 'application/json' }, cors, headers), body: body === null ? '' : JSON.stringify(body) });
      if (w.offline) return route.abort('internetdisconnected');
      if (w.rate && Date.now() < w.rateUntil) {
        return w.rate === '429'
          ? json(429, { message: 'Too many requests' }, { 'retry-after': '2' })
          : json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(w.rateUntil / 1000)) });
      }
      const tokenFine = auth === `Bearer ${w.tokenOk}`;
      if (auth && !tokenFine) return json(401, { message: 'Bad credentials' });
      const base = `/repos/${GH_REPO}`;
      if (u.pathname === base) return json(200, { full_name: GH_REPO, default_branch: w.branch, private: false });
      if (u.pathname === `${base}/actions/workflows/retrain.yml`) return w.tokenScope || !auth ? json(200, { id: 1, path: '.github/workflows/retrain.yml' }) : json(404, { message: 'Not Found' });
      if (u.pathname === `${base}/actions/workflows/retrain.yml/runs`) {
        w.ghRunsGets++;
        return json(200, { total_count: w.runs.length, workflow_runs: w.runs.slice(0, Number(u.searchParams.get('per_page') || 30)) });
      }
      if (u.pathname === `${base}/actions/workflows/retrain.yml/dispatches` && request.method() === 'POST') {
        if (!auth) return json(401, { message: 'Requires authentication' });
        if (!w.tokenScope) return json(403, { message: 'Resource not accessible by personal access token' });
        w.dispatches.push(JSON.parse(request.postData() || '{}'));
        if (w.autoRun) w.addRun();
        return json(204, null);
      }
      const m = /^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/cancel$/.exec(u.pathname);
      if (m && request.method() === 'POST') {
        if (!tokenFine) return json(401, { message: 'Requires authentication' });
        w.cancels.push(Number(m[1]));
        const r = w.runs.find((x) => x.id === Number(m[1]));
        if (r) Object.assign(r, { status: 'completed', conclusion: 'cancelled' });
        return json(202, {});
      }
      return json(404, { message: 'Not Found' });
    });
  };
  return w;
}

const consoleLog = [];
async function open(browser, server, w, opts = {}) {
  const init = [`self.HW_TRAINING_TIMING = ${JSON.stringify(TIMING)};`];
  if (opts.ghToken) init.push(`if (!localStorage.getItem('hw.github')) localStorage.setItem('hw.github', JSON.stringify({ token: ${JSON.stringify(opts.ghToken)} }));`);
  if (opts.offered) init.push("localStorage.setItem('hw.github.offered', '1');");
  const A = await L.newApp(browser, server, Object.assign({
    hash: '#/training', signedIn: true, hf: w.hf, routes: w.routes, init: init.join('\n'),
  }, opts));
  A.page.on('console', (m) => consoleLog.push(m.text()));
  return A;
}

const kind = (page) => page.evaluate(() => window.__hw.training.debug().kind);
const waitKind = (page, k, timeout = 8000) => L.until(async () => (await kind(page)) === k, timeout, 40)
  .catch(async () => { throw new Error(`expected state ${k}, have ${await kind(page)}`); });
const text = (page) => page.textContent('#trn-text-in');
const sub = (page) => page.textContent('#trn-sub');
const visible = (page, sel) => page.isVisible(sel);
const mainLabel = async (page) => (await visible(page, '#trn-main')) ? page.textContent('#trn-main') : (await visible(page, '#trn-main-link')) ? page.textContent('#trn-main-link') : null;
const secondLabel = async (page) => (await visible(page, '#trn-second')) ? page.textContent('#trn-second') : (await visible(page, '#trn-second-link')) ? page.textContent('#trn-second-link') : null;
const startShown = async (page) => /Training starten|Nochmal versuchen|Fortsetzen|Neu trainieren|Von vorn/.test(`${await mainLabel(page)} ${await secondLabel(page)}`);

/** Every visible button / link / field of the view and the top bar is at least 48 x 48 CSS px. */
async function targets(page, scope = '#v-training') {
  return page.evaluate((sc) => [...document.querySelectorAll(`${sc} button, ${sc} a, ${sc} input, ${sc} select, ${sc} summary, .bar a, .bar button`)]
    .filter((e) => e.checkVisibility({ visibilityProperty: true }) && !e.hidden)
    .map((e) => { const t = e.matches('input') && e.closest('label') || e; const r = t.getBoundingClientRect(); return [e.id || e.textContent.trim().slice(0, 20) || e.tagName, Math.round(r.width), Math.round(r.height)]; })
    .filter(([, w, h]) => w < 47.5 || h < 47.5), scope);
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function checkLayout(page, tag, scope) {
  const small = await targets(page, scope);
  L.check(`${tag}: touch targets at least 48 px`, small.length === 0, JSON.stringify(small));
  L.check(`${tag}: no horizontal scrolling`, await noHScroll(page));
}

/** The token may be typed into its field, but never shows up in the page or the console. */
async function tokenNowhere(page) {
  const html = await page.evaluate(() => document.documentElement.outerHTML + [...document.querySelectorAll('input')].map((i) => i.value).join(' '));
  return !html.includes(GH_TOKEN) && !html.includes(GH_TOKEN.slice(0, -4)) && !consoleLog.some((l) => l.includes(GH_TOKEN));
}

// ---------------------------------------------------------------- scenes

async function signedOutAndFew(browser, server) {
  const w = world();
  let A = await open(browser, server, w, { signedIn: false });
  await waitKind(A.page, 'signedout');
  L.check('signed out: asks to sign in', /Melde dich an/.test(await text(A.page)) && (await mainLabel(A.page)) === 'Anmelden');
  L.check('signed out: the tab is in the top bar and current', (await A.page.getAttribute('a[data-route="training"]', 'aria-current')) === 'page');
  L.check('signed out: nothing asked of Hugging Face or GitHub', w.statusGets === 0 && w.ghRequests.length === 0);
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
  L.check('few lines: no start, no options', !(await startShown(A.page)) && !(await visible(A.page, '#trn-adv')));
  await A.ctx.close();
}

/** No setup at all: the button opens the workflow on GitHub, the run then shows up by itself. */
async function zeroSetupRunFlow(browser, server) {
  const w = world();
  const A = await open(browser, server, w);
  const { page, ctx } = A;
  await waitKind(page, 'ready');
  L.check('ready: lines and new lines', (await text(page)) === '125 Zeilen sind da, 25 davon neu seit dem letzten Training.', await text(page));
  L.check('ready: says where it runs, that it is free, and that the app may close', /kostenlos auf GitHub\. Du kannst die App dabei schließen\./.test(await sub(page)), await sub(page));
  L.check('no token: "Training starten" opens the workflow page on GitHub in a new tab',
    (await mainLabel(page)) === 'Training starten' && (await page.getAttribute('#trn-main-link', 'href')) === GH_PAGE && (await page.getAttribute('#trn-main-link', 'target')) === '_blank');
  L.check('no token: no options (GitHub\'s own form has them)', !(await visible(page, '#trn-adv')));
  L.check('no token: the token is offered once, quietly', await visible(page, '#trn-offer') && (await page.getAttribute('#trn-offer-link', 'href')) === '#/einstellungen');
  L.check('opening the tab: GitHub asked once, without a token', w.ghRunsGets === 1 && w.ghRequests.every((r) => !r.auth), JSON.stringify(w.ghRequests));
  await checkLayout(page, 'ready (no token)');
  await L.shot(page, 'training-02-ready-tablet');

  const [popup] = await Promise.all([ctx.waitForEvent('page'), page.click('#trn-main-link')]);
  await popup.waitForLoadState().catch(() => {});
  L.check('zero setup: the right page opened', popup.url() === GH_PAGE, popup.url());
  await popup.close();
  await waitKind(page, 'ghwait');
  L.check('zero setup: says what to tap on GitHub', (await text(page)) === 'Tippe auf GitHub auf „Run workflow“ und dann auf den grünen Knopf „Run workflow“.' && /erscheint das Training hier von selbst/.test(await sub(page)));
  L.check('zero setup: GitHub can be opened again, or the wait given up', (await mainLabel(page)) === 'GitHub öffnen' && (await secondLabel(page)) === 'Doch nicht');
  await checkLayout(page, 'waiting for a start by hand');
  await L.shot(page, 'training-03-ghwait');
  // ... the writer taps "Run workflow" on GitHub
  const run = w.addRun({ created_at: iso(-2000) });
  await waitKind(page, 'ghstarting', 5000);
  L.check('starting on GitHub: honest about the two minutes', (await text(page)) === 'Das Training startet auf GitHub. Das dauert etwa zwei Minuten.' && (await sub(page)) === 'Der Lauf wartet noch auf einen freien Rechner.', await sub(page));
  L.check('starting on GitHub: no start button, a link to the run', !(await startShown(page)) && (await page.getAttribute('#trn-second-link', 'href')) === run.html_url);
  await L.shot(page, 'training-04-ghstarting');
  run.status = 'in_progress';
  await L.until(async () => (await sub(page)) === 'Der Rechner wird gerade eingerichtet.', 4000);
  L.check('starting on GitHub: in progress -> "wird eingerichtet"', true);
  // a page opened now (reopening) knows a run is on its way, from GitHub alone
  const p2 = await ctx.newPage();
  await p2.goto(server.url + '#/training'); await p2.waitForFunction(() => window.__hwReady);
  await waitKind(p2, 'ghbusy');
  L.check('reopened while the run starts: no start button, says it starts', !(await startShown(p2)) && /startet gerade ein Lauf/.test(await p2.textContent('#trn-text-in')));
  L.check('reopened: the offer is not shown a second time', !(await p2.isVisible('#trn-offer')));
  await p2.close();

  // the driver reports
  w.status = mkStatus('starting', { run_id: 'r2', epoch: 0, scores: [], best_epoch: null, sample_epoch: null, checkpoint_epoch: null, started: iso(0), updated: iso(0), minutes_left: null, runner_url: run.html_url });
  await waitKind(page, 'starting');
  L.check('starting: the lines are loaded, it can be stopped', /Das Training beginnt/.test(await text(page)) && (await mainLabel(page)) === 'Abbrechen');
  const ghBefore = w.ghRunsGets;
  w.status = mkStatus('running', { run_id: 'r2', epoch: 0, scores: [-1.4], best_epoch: null, sample_epoch: 0, minutes_left: null, epoch_minutes: null, started: iso(2 * MIN), updated: iso(0), runner_url: run.html_url });
  await L.until(async () => /Die erste Runde läuft/.test(await page.textContent('#trn-left')), 4000);
  L.check('running, round 1: no time estimate yet', (await page.textContent('#trn-round')) === 'Runde 1 von 30');
  w.status = mkStatus('running', { run_id: 'r2', updated: iso(0), runner_url: run.html_url });
  await L.until(async () => (await page.textContent('#trn-round')) === 'Runde 8 von 30', 4000);
  L.check('running: "Runde 8 von 30" and roughly how long', (await page.textContent('#trn-left')) === 'noch etwa eine Stunde', await page.textContent('#trn-left'));
  L.check('running: progress bar at 7 of 30', (await page.getAttribute('#trn-bar', 'aria-valuenow')) === '23');
  L.check('running: where it runs', /^Läuft auf GitHub, seit \d\d:\d\d Uhr\. Es lernt aus 125 Zeilen\.$/.test(await sub(page)), await sub(page));
  await L.until(() => page.evaluate(() => { const i = document.getElementById('trn-sample-img'); return i.complete && i.naturalWidth === 1000 && !document.getElementById('trn-sample').hidden; }), 4000);
  L.check('running: the latest sample is shown', (await page.textContent('#trn-sample-cap')).startsWith('Stand nach Runde 7.'));
  const curve = await page.evaluate(() => ({ pts: document.querySelector('#trn-svg polyline').getAttribute('points').split(' ').length, best: document.querySelectorAll('#trn-svg .dot.best').length, label: document.getElementById('trn-svg').getAttribute('aria-label'), cap: document.querySelector('#trn-curve figcaption').textContent }));
  L.check('running: a small curve of the score, best round marked, labelled in words', curve.pts === 8 && curve.best === 1 && curve.cap === 'Abweichung von deiner Schrift, niedriger ist besser' && /gesunken/.test(curve.label), JSON.stringify(curve));
  await checkLayout(page, 'running');
  await L.shot(page, 'training-06-running-tablet');
  await page.waitForTimeout(1000);
  L.check('running: GitHub is asked rarely while the status reports (not on every poll)', w.ghRunsGets - ghBefore <= 2, `${w.ghRunsGets - ghBefore}`);

  await page.click('#trn-sample-open');
  L.check('sample: tap enlarges it', await page.evaluate(() => document.getElementById('trn-zoom').open));
  await L.shot(page, 'training-07-sample-zoom');
  await page.click('#trn-zoom-close');

  // stop: through the model repo
  await page.click('#trn-main');
  L.check('stop: asks first, says what is kept', await page.evaluate(() => document.getElementById('trn-confirm').open) && /Bis Runde 5 ist alles gesichert/.test(await page.textContent('#trn-confirm-text')));
  await L.shot(page, 'training-08-stop-confirm');
  await page.click('#trn-confirm-no');
  L.check('stop: "Weiterlaufen lassen" changes nothing', w.commits.length === 0);
  await page.click('#trn-main'); await page.click('#trn-confirm-yes');
  await L.until(() => w.commits.length === 1, 4000);
  L.check('stop: training/stop written to the model repo (no GitHub token needed)', w.commits[0].files.join() === 'training/stop' && w.cancels.length === 0);
  await L.until(async () => /nach dieser Runde beendet/.test(await text(page)), 3000);
  L.check('stop: says it ends after this round, button disabled', await page.isDisabled('#trn-main') && (await mainLabel(page)) === 'Wird beendet …');
  await L.shot(page, 'training-09-stopping');
  w.status = mkStatus('stopped', { run_id: 'r2', epoch: 8, checkpoint_epoch: 8, message: 'Abgebrochen nach Runde 8.', updated: iso(0), runner_url: run.html_url });
  w.stopFile = false; Object.assign(run, { status: 'completed', conclusion: 'success' });
  await waitKind(page, 'stopped');
  await L.until(async () => (await mainLabel(page)) === 'Fortsetzen', 5000).catch(() => {});   // once GitHub says the run is over
  L.check('stopped: the reason in plain words', (await text(page)) === 'Abgebrochen nach Runde 8.' && /weitermachen/.test(await sub(page)));
  L.check('stopped: "Fortsetzen" (on GitHub), quietly "Von vorn beginnen"', (await mainLabel(page)) === 'Fortsetzen' && (await page.getAttribute('#trn-main-link', 'href')) === GH_PAGE && (await secondLabel(page)) === 'Von vorn beginnen', JSON.stringify([await mainLabel(page), await page.getAttribute('#trn-main-link', 'href'), await secondLabel(page), await kind(page), await page.evaluate(() => window.__hw.training.debug().run)]));
  await checkLayout(page, 'stopped');
  await L.shot(page, 'training-10-stopped');
  const [p3] = await Promise.all([ctx.waitForEvent('page'), page.click('#trn-main-link')]);
  await p3.close();
  await waitKind(page, 'ghwait');
  L.check('resume by hand: says to tick "fortsetzen"', /Haken bei „fortsetzen“/.test(await text(page)));
  await page.click('#trn-second');
  await waitKind(page, 'stopped');
  L.check('"Doch nicht": back where it was', true);

  // done -> Schreiben looks for the new model
  const before = w.modelJsonGets;
  w.status = mkStatus('done', { run_id: 'r3', epoch: 30, best_epoch: 27, sample_epoch: 27, sample_kind: 'best', started: iso(0), updated: iso(0), minutes_left: 0, scores: SCORES30 });
  w.trainedOn = { lines: 125, date: iso(0), writer: 'finn' };
  await waitKind(page, 'done');
  await L.until(() => w.modelJsonGets > before, 4000);
  L.check('done: Schreiben looked for the new model at once', true);
  L.check('done: says the new model is in use', (await text(page)) === 'Fertig. Dein neues Modell ist jetzt in Gebrauch.' && /Am besten war Runde 27/.test(await sub(page)));
  L.check('done: "Ausprobieren" leads to Schreiben', (await mainLabel(page)) === 'Ausprobieren' && (await page.getAttribute('#trn-main-link', 'href')) === '#/schreiben');
  await L.until(async () => (await page.textContent('#trn-sample-cap')).startsWith('So schreibt das fertige Modell'), 3000);
  await checkLayout(page, 'done');
  await L.shot(page, 'training-11-done');
  const once = w.modelJsonGets;
  await page.waitForTimeout(1200);
  L.check('done: the model refresh is asked for once, not on every poll', w.modelJsonGets === once);

  // gentle polling
  await page.click('a[data-route="schreiben"]');
  await page.waitForTimeout(300);
  const n = w.statusGets, g = w.ghRequests.length;
  await page.waitForTimeout(1500);
  L.check('polling: nothing while the tab is not shown', w.statusGets === n && w.ghRequests.length === g, `${n}->${w.statusGets} ${g}->${w.ghRequests.length}`);
  await page.click('a[data-route="training"]');
  await L.until(() => w.statusGets > n, 3000);
  const errs = A.errors.filter((e) => !/Failed to load resource|ERR_|net::/.test(e));
  L.check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/** With a GitHub token: the app starts the workflow itself. */
async function tokenFlow(browser, server) {
  const w = world({ branch: 'claude/compassionate-davinci-h0fyky' });
  let A = await open(browser, server, w, { ghToken: GH_TOKEN });
  let { page } = A;
  await waitKind(page, 'ready');
  L.check('token: "Training starten" is a button here, options are there, no offer', (await mainLabel(page)) === 'Training starten' && await visible(page, '#trn-main') && await visible(page, '#trn-adv') && !(await visible(page, '#trn-offer')));
  await page.click('#trn-adv summary');
  L.check('options: defaults are the driver\'s (scripts/retrain.py)', (await page.inputValue('#trn-epochs')) === String(PY.EPOCHS) && (await page.inputValue('#trn-every')) === String(PY.SAMPLE_EVERY) && (await page.isChecked('#trn-lines')) === PY.LINES_ONLY);
  await checkLayout(page, 'options open');
  await L.shot(page, 'training-05-ready-options');
  await page.fill('#trn-epochs', '18');     // any value other than the default
  await page.selectOption('#trn-every', '5');
  await page.click('#trn-lines');
  await page.click('#trn-main');
  await L.until(() => w.dispatches.length === 1, 5000);
  const d = w.dispatches[0];
  L.check('dispatch: on the default branch read from GitHub', d.ref === 'claude/compassionate-davinci-h0fyky', JSON.stringify(d));
  L.check('dispatch: always "train now" (force), only the changed options', JSON.stringify(d.inputs) === JSON.stringify({ force: 'true', resume: 'false', epochs: '18', sample_every: '5', lines_only: PY.LINES_ONLY ? 'nein' : 'ja' }), JSON.stringify(d.inputs));
  const disp = w.ghRequests.find((r) => r.path.endsWith('/dispatches'));
  L.check('dispatch: the token went to api.github.com', disp && disp.auth === `Bearer ${GH_TOKEN}`);
  const lookedFirst = w.ghRequests.findIndex((r) => r.path.endsWith('/runs')) < w.ghRequests.findIndex((r) => r.path.endsWith('/dispatches'));
  L.check('dispatch: GitHub was asked for a running run right before', lookedFirst);
  await waitKind(page, 'ghstarting');
  L.check('token: starting on GitHub, can be cancelled there from here', (await mainLabel(page)) === 'Abbrechen' && !(await startShown(page)));
  await page.click('#trn-main');
  await L.until(() => w.cancels.length === 1, 4000);
  L.check('cancel before training: the GitHub run is cancelled', w.cancels[0] === w.runs[0].id);
  await waitKind(page, 'ghfailed');
  L.check('cancelled before training: says so, links to the run, offers to start again',
    /wurde abgebrochen, bevor das Training begonnen hat/.test(await text(page)) && (await page.getAttribute('#trn-second-link', 'href')) === w.runs[0].html_url && (await mainLabel(page)) === 'Nochmal versuchen');

  // no second start while a run is queued: the button is not there, and a stale page is refused by the check right before
  w.addRun({ status: 'queued', created_at: iso(10000) });
  await page.reload(); await page.waitForFunction(() => window.__hwReady);
  await waitKind(page, 'ghbusy');
  L.check('a run queued on GitHub: no start button', !(await startShown(page)));
  await A.ctx.close();

  // a run that fails before writing any status
  const w2 = world();
  A = await open(browser, server, w2, { ghToken: GH_TOKEN });
  page = A.page;
  await waitKind(page, 'ready');
  await page.click('#trn-main');
  await L.until(() => w2.dispatches.length === 1, 4000);
  await waitKind(page, 'ghstarting');
  Object.assign(w2.runs[0], { status: 'completed', conclusion: 'failure' });
  await waitKind(page, 'ghfailed', 5000);
  L.check('failed before any status: plain words and the run on GitHub', (await text(page)) === 'Der Lauf auf GitHub ist abgebrochen, bevor das Training begonnen hat.' && (await sub(page)) === 'Auf GitHub steht, woran es lag.' && (await page.getAttribute('#trn-second-link', 'href')) === w2.runs[0].html_url);
  await checkLayout(page, 'failed before status');
  await L.shot(page, 'training-12-ghfailed');
  // reopening shows the same, from GitHub alone
  const p2 = await A.ctx.newPage();
  await p2.goto(server.url + '#/training'); await p2.waitForFunction(() => window.__hwReady);
  await waitKind(p2, 'ghfailed');
  L.check('failed before any status: reopening shows it too', true);
  await p2.close();
  // errors at the start: calm notes, still ready
  w2.runs = [];
  w2.tokenScope = false;
  await page.reload(); await page.waitForFunction(() => window.__hwReady);
  await waitKind(page, 'ready');
  await page.click('#trn-main');
  await L.until(() => page.isVisible('#trn-note'), 4000);
  L.check('start refused (403): the token needs "Actions: Read and write"', /Actions: Read and write/.test(await page.textContent('#trn-note')) && (await kind(page)) === 'ready');
  w2.tokenScope = true; w2.tokenOk = 'something-else';
  await page.click('#trn-main');
  await L.until(async () => /gilt nicht mehr/.test(await page.textContent('#trn-note')), 4000);
  L.check('start with an expired token (401): says so, points to Einstellungen', true);
  L.check('token: never in the page or the console', await tokenNowhere(page));
  await A.ctx.close();
}

async function rateLimits(browser, server) {
  for (const kindOf of ['403', '429']) {
    const w = world();
    const { page, ctx } = await open(browser, server, w, { offered: true });
    await waitKind(page, 'ready');
    const [pop] = await Promise.all([ctx.waitForEvent('page'), page.click('#trn-main-link')]);
    await pop.close();
    await waitKind(page, 'ghwait');
    w.rate = kindOf; w.rateUntil = Date.now() + 2500;
    w.addRun({ created_at: iso(-2000) });
    await L.until(() => page.isVisible('#trn-note'), 5000);
    L.check(`rate limit ${kindOf}: a calm note, the screen stays`, (await page.textContent('#trn-note')) === 'GitHub bittet um eine kurze Pause. Es geht gleich von selbst weiter.' && ['ghwait', 'ghstarting'].includes(await kind(page)));
    const n = w.ghRequests.length;
    await page.waitForTimeout(1200);
    L.check(`rate limit ${kindOf}: no further requests until GitHub allows them`, w.ghRequests.length === n, `${n} -> ${w.ghRequests.length}`);
    if (kindOf === '403') await L.shot(page, 'training-13-ratelimit');
    await waitKind(page, 'ghstarting', 8000);
    L.check(`rate limit ${kindOf}: afterwards it goes on by itself`, !(await page.isVisible('#trn-note')));
    await ctx.close();
  }
}

async function settingsToken(browser, server) {
  const w = world();
  const { page, ctx } = await open(browser, server, w, { hash: '#/einstellungen', viewport: { width: 412, height: 915 }, dsf: 2.625 });
  await page.waitForSelector('#gh-settings:not([hidden])');
  L.check('settings: numbered steps and a link to create the token', (await page.$$eval('.gh-steps li', (l) => l.length)) === 5 && (await page.getAttribute('#gh-token-link', 'href')) === 'https://github.com/settings/personal-access-tokens/new');
  L.check('settings: names the one repository and "Actions: Read and write"', (await page.textContent('#gh-repo')) === GH_REPO && /„Actions“ „Read and write“/.test(await page.textContent('.gh-steps')));
  await page.evaluate(() => document.getElementById('gh-settings').scrollIntoView());
  await checkLayout(page, 'settings: token steps', '#gh-settings');
  await L.shot(page, 'training-30-settings-phone');
  await page.fill('#gh-input', 'github_pat_wrong');
  await page.click('#gh-save');
  await L.until(() => page.isVisible('#gh-err'), 4000);
  L.check('settings: a wrong token is refused plainly, not stored', /funktioniert nicht/.test(await page.textContent('#gh-err')) && !(await page.evaluate(() => localStorage.getItem('hw.github'))));
  await page.fill('#gh-input', GH_TOKEN);
  await page.click('#gh-save');
  await page.waitForSelector('#gh-saved:not([hidden])');
  L.check('settings: saved, shown only by its last four characters', (await page.textContent('#gh-saved-text')) === 'Ein Schlüssel ist gespeichert (endet auf „9wXy“). Er liegt nur auf diesem Gerät.');
  const check = w.ghRequests.find((r) => r.auth === `Bearer ${GH_TOKEN}`);
  L.check('settings: checked against api.github.com only', !!check && check.path === `/repos/${GH_REPO}/actions/workflows/retrain.yml`);
  L.check('settings: the token is nowhere in the page or console', await tokenNowhere(page));
  await L.shot(page, 'training-31-settings-saved');
  await page.click('a[data-route="training"]');
  await waitKind(page, 'ready');
  L.check('settings -> Training: the start is direct now', await visible(page, '#trn-main') && (await mainLabel(page)) === 'Training starten');
  await page.click('a[data-route="einstellungen"]');
  await page.click('#gh-remove');
  L.check('settings: the token can be removed', !(await page.evaluate(() => localStorage.getItem('hw.github'))) && await page.isVisible('#gh-new'));
  await ctx.close();
}

async function elsewhereAndStale(browser, server) {
  const w = world({ status: mkStatus('running', { runner: 'colab', runner_url: null, updated: iso(2 * MIN) }) });
  let A = await open(browser, server, w);
  await waitKind(A.page, 'running');
  L.check('elsewhere (Colab): shows where it runs', /^Läuft in Google Colab/.test(await sub(A.page)));
  L.check('elsewhere: no start button while it runs, "Abbrechen" instead', (await mainLabel(A.page)) === 'Abbrechen' && !(await visible(A.page, '#trn-adv')));
  await A.page.click('#trn-main'); await A.page.click('#trn-confirm-yes');
  await L.until(() => w.commits.length === 1, 3000);
  L.check('elsewhere: stop goes through the model repo', w.commits[0].files.join() === 'training/stop');
  await A.ctx.close();

  const w2 = world({ status: mkStatus('running', { updated: iso(60 * MIN) }) });
  A = await open(browser, server, w2);
  await waitKind(A.page, 'interrupted');
  L.check('stale: "stehen geblieben", with what is kept, "Fortsetzen"', /stehen geblieben/.test(await text(A.page)) && /Bis Runde 5 ist alles gesichert/.test(await sub(A.page)) && (await mainLabel(A.page)) === 'Fortsetzen');
  await L.shot(A.page, 'training-14-interrupted');
  await A.ctx.close();

  // the GitHub run of a "running" status was cancelled on GitHub
  const w3 = world();
  const r = w3.addRun({ status: 'completed', conclusion: 'cancelled', created_at: iso(30 * MIN) });
  w3.status = mkStatus('running', { updated: iso(2 * MIN), runner_url: r.html_url });
  A = await open(browser, server, w3);
  await waitKind(A.page, 'interrupted');
  L.check('its GitHub run has ended: interrupted at once, not "running" for 20 minutes', true);
  await A.ctx.close();

  // a run without any status for a long time (e.g. old code): said honestly, no start
  const w4 = world();
  w4.addRun({ status: 'in_progress', created_at: iso(45 * MIN) });
  A = await open(browser, server, w4);
  await waitKind(A.page, 'ghbusy');
  L.check('a long run without status: says it shows no progress here, no start', /keinen Fortschritt/.test(await text(A.page)) && !(await startShown(A.page)) && (await A.page.getAttribute('#trn-second-link', 'href')) === w4.runs[0].html_url);
  await A.ctx.close();

  const w5 = world({ status: mkStatus('failed', { message: 'Die Verbindung zu Hugging Face ist abgebrochen.', checkpoint_epoch: null, updated: iso(5 * MIN) }) });
  A = await open(browser, server, w5);
  await waitKind(A.page, 'failed');
  L.check('failed: plain reason, "Nochmal versuchen"', (await sub(A.page)) === 'Die Verbindung zu Hugging Face ist abgebrochen.' && (await mainLabel(A.page)) === 'Nochmal versuchen');
  await checkLayout(A.page, 'failed');
  await L.shot(A.page, 'training-15-failed');
  await A.ctx.close();

  // Hugging Face offline at first, then back
  const w6 = world({ offline: true });
  A = await open(browser, server, w6);
  await waitKind(A.page, 'offline');
  L.check('offline: says it tries again', /nicht erreichbar/.test(await text(A.page)) && !(await mainLabel(A.page)));
  w6.offline = false;
  await waitKind(A.page, 'ready', 5000);
  L.check('offline -> online: recovers by itself', true);
  await A.ctx.close();
}

async function phoneAndDark(browser, server) {
  for (const [scheme, vp, tag] of [['light', { width: 412, height: 915 }, 'phone'], ['dark', { width: 412, height: 915 }, 'phone-dark'], ['dark', { width: 1280, height: 800 }, 'tablet-dark']]) {
    for (const st of ['ready', 'ghstarting', 'running', 'done']) {
      const status = st === 'running' ? mkStatus('running', { updated: iso(0) })
        : st === 'done' ? mkStatus('done', { epoch: 30, best_epoch: 27, sample_kind: 'best', sample_epoch: 27, updated: iso(0), scores: SCORES30 }) : null;
      const w = world({ status, trainedOn: st === 'done' ? { lines: 125, writer: 'finn' } : { lines: 100, writer: 'finn' } });
      if (st === 'ghstarting') w.addRun({ status: 'queued', created_at: iso(5000) });
      const { page, ctx } = await open(browser, server, w, { viewport: vp, colorScheme: scheme, dsf: vp.width < 500 ? 2.625 : 2 });
      await waitKind(page, st === 'ghstarting' ? 'ghbusy' : st);
      if (st === 'running' || st === 'done') await L.until(() => page.evaluate(() => !document.getElementById('trn-sample').hidden && document.getElementById('trn-sample-img').naturalWidth > 0), 4000);
      await checkLayout(page, `${tag} ${st}`);
      const bar = await page.evaluate(() => { const b = document.getElementById('bar'); return b.scrollWidth <= b.clientWidth + 1; });
      L.check(`${tag} ${st}: the top bar with three tabs fits`, bar);
      await L.shot(page, `training-20-${tag}-${st}`);
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
    await zeroSetupRunFlow(browser, server);
    await tokenFlow(browser, server);
    await rateLimits(browser, server);
    await settingsToken(browser, server);
    await elsewhereAndStale(browser, server);
    await phoneAndDark(browser, server);
    L.check('the GitHub token went to api.github.com only (never to Hugging Face or github.com)', !LEAK);
  } catch (e) {
    console.error(e); L.check('test ran without exception', false, String(e && e.stack || e));
  } finally {
    await browser.close(); await server.close();
  }
  process.exit(L.summary() ? 0 : 1);
})();
