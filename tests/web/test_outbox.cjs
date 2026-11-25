// Outbox against a mocked Hugging Face: one NDJSON commit per batch, lines leave
// the outbox only after 2xx, and stay queued / are retried after 401, 429, network errors.
const L = require('./lib.cjs');

(async () => {
  const server = await L.start();
  const browser = await L.launch();
  let mode = 'ok';
  let tokenValid = true;      // whoami answers 401 while false (a revoked token)
  let createMode = 'ok';
  const commits = [];
  const previewCommits = [];   // the second, best-effort commit (preview/...): counted apart
  const hf = (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/api/whoami-v2') {
      return tokenValid && req.headers.authorization === `Bearer ${L.FAKE_TOKEN}` ? { status: 200, body: { name: L.FAKE_USER, type: 'user' } } : { status: 401 };
    }
    // The Hub answers 401 (not 404) for a dataset that does not exist.
    if (u.pathname.includes('/tree/')) return { status: 401, headers: { 'x-error-code': 'RepoNotFound', 'x-error-message': 'Repository not found' } };
    if (u.pathname === '/api/repos/create') {
      commits.push(Object.assign({ mode: 'create-' + createMode }, req));
      if (createMode === '409') return { status: 409, headers: { 'x-error-message': 'You already created this dataset repo' } };
      mode = 'ok'; return { status: 200, body: { url: 'x' } };
    }
    if (u.pathname.endsWith('/commit/main') && req.body.includes('"path":"preview/')) {
      previewCommits.push(req); return { status: 200, body: { success: true } };
    }
    if (u.pathname.endsWith('/commit/main')) {
      commits.push(Object.assign({ mode }, req));
      if (mode === '401') return { status: 401, headers: { 'x-error-message': 'Invalid credentials in Authorization header' } };
      if (mode === '401repo') return { status: 401, headers: { 'x-error-code': 'RepoNotFound', 'x-error-message': 'Repository not found' } };
      if (mode === '401bare') return { status: 401 };
      if (mode === '404') return { status: 404, headers: { 'x-error-code': 'RepoNotFound' } };
      if (mode === '500') return { status: 500, headers: { 'retry-after': '120' } };
      if (mode === 'poison' && req.body.includes('poison-line__')) return { status: 422, headers: { 'x-error-message': 'Invalid file' } };
      if (mode === '429') return { status: 429, headers: { 'retry-after': '1' } };
      if (mode === 'network') return 'abort';
      return { status: 200, body: { success: true, commitOid: 'a'.repeat(40) } };
    }
    return null;
  };
  try {
    const { page, cdp, errors } = await L.newApp(browser, server, { hash: '#/erfassen', signedIn: true, hf, writer: 'Finn' });
    await page.waitForSelector('#cap[data-state="write"]');
    await page.waitForTimeout(150);
    const queued = () => page.evaluate(() => window.__hw.store.countQueued());
    const p = L.pen(cdp);
    async function line() {
      const rect = await L.canvasRect(page);
      const base = rect.top + rect.height * 0.64;
      await p.stroke(L.glyph(rect.left + 80, base, 6));
      await L.settle(page);
      await page.click('#cap-done');
      await page.waitForSelector('#cap[data-state="confirm"]');
      await L.settle(page);
      await page.click('#confirm-ok');
      await page.waitForSelector('#cap[data-state="write"]');
    }

    mode = '401'; tokenValid = false;
    for (let i = 0; i < 4; i++) await line();
    await page.waitForTimeout(200);
    L.check('fewer than 5 waiting lines: no upload yet', commits.length === 0, String(commits.length));
    L.check('indicator says 4 lines are waiting', (await page.textContent('#waiting-text')).startsWith('4 Zeilen warten'));
    await line();
    await page.waitForFunction(() => !window.__hw.outbox.status().running && window.__hw.outbox.status().lastError);
    L.check('5th line triggers one commit', commits.length === 1);
    L.check('after 401 all 5 lines stay queued', (await queued()) === 5);
    L.check('after 401 the token is cleared (sign in again)', await page.evaluate(() => !window.__hw.hf.getAuth()));

    // Sign in again through the settings dialog; this flushes -> 429.
    mode = '429'; tokenValid = true;
    await page.click('a[data-route="einstellungen"]');
    await page.click('#acc-token');
    await page.fill('#tok-input', L.FAKE_TOKEN);
    await page.click('#tok-ok');
    await page.waitForFunction(() => window.__hw.hf.getAuth());
    await page.waitForFunction((n) => window.__hw.outbox.status().lastError && window.__hw.outbox.status().lastError.kind === 'rate', 2);
    L.check('signing in again retries the upload', commits.length === 2 && commits[1].mode === '429');
    L.check('a 401 RepoNotFound on the tree listing does not sign out', await page.evaluate(() => !!window.__hw.hf.getAuth()));
    L.check('after 429 the lines stay queued', (await queued()) === 5);
    L.check('settings explain the wait', (await page.textContent('#up-status')).includes('Pause'));

    // Automatic retry after Retry-After: 1 s -> network error.
    mode = 'network';
    await page.waitForFunction(() => window.__hw.outbox.status().lastError && window.__hw.outbox.status().lastError.kind === 'network', null, { timeout: 5000 });
    L.check('429 is retried automatically after Retry-After', commits.length === 3 && commits[2].mode === 'network');
    L.check('after a network error the lines stay queued', (await queued()) === 5);

    // Back online -> retried -> success.
    mode = 'ok';
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await L.until(async () => (await queued()) === 0);
    const ok = commits[commits.length - 1];
    L.check('"online" retries and the commit succeeds', commits.length === 4 && ok.mode === 'ok');
    await page.waitForFunction(() => document.getElementById('toast').textContent === 'Alles hochgeladen.', null, { timeout: 3000 }).catch(() => {});
    L.check('success is confirmed with "Alles hochgeladen."', (await page.textContent('#toast')) === 'Alles hochgeladen.', await page.textContent('#toast'));
    L.check('commit URL is the user\'s dataset', ok.url === `https://huggingface.co/api/datasets/${L.FAKE_USER}/handwriting-fable/commit/main`, ok.url);
    L.check('Authorization: Bearer <token>', ok.headers.authorization === `Bearer ${L.FAKE_TOKEN}`);
    L.check('Content-Type: application/x-ndjson', ok.headers['content-type'] === 'application/x-ndjson', ok.headers['content-type']);
    const nd = ok.body.split('\n').map((l) => JSON.parse(l));
    L.check('one NDJSON body: header + 5 files', nd.length === 6 && nd[0].key === 'header' && nd[0].value.summary === 'Erfassung: 5 Zeilen' && nd.slice(1).every((x) => x.key === 'file' && x.value.encoding === 'utf-8'), nd[0] && JSON.stringify(nd[0]));
    const entries = await L.lines(page);
    const byPath = new Map(entries.map((e) => [e.path, e]));
    L.check('file paths are raw/v1/<writer>/<session>/<prompt>__<id>.json of the stored lines', nd.slice(1).every((x) => byPath.has(x.value.path) && /^raw\/v1\/finn\/[^/]+\/[^/]+__[0-9a-f-]{36}\.json$/.test(x.value.path)));
    L.check('file content is the stored record', nd.slice(1).every((x) => JSON.parse(x.value.content).id === byPath.get(x.value.path).id));
    L.check('lines marked sent only after 2xx', entries.every((e) => e.state === 'sent' && e.uploaded_at), entries.map((e) => e.state).join());
    L.check('a listing that fails (401 RepoNotFound) verifies nothing: still "sent"', entries.every((e) => e.state === 'sent' && !e.verified_at));
    await L.until(async () => (await page.textContent('#waiting-text')) === '5 Zeilen werden geprüft', 3000).catch(() => {});
    L.check('indicator: nothing waits, 5 lines are still being checked', (await page.textContent('#waiting-text')) === '5 Zeilen werden geprüft', await page.textContent('#waiting-text'));

    // Missing dataset, answered with 401 RepoNotFound -> offer to create it (no sign-out) -> upload.
    mode = '401repo';
    await page.click('a[data-route="erfassen"]');
    await page.waitForSelector('#cap[data-state="write"]');
    await page.waitForTimeout(100);
    await line();
    await page.evaluate(() => window.__hw.outbox.flush('manual'));
    await page.waitForSelector('#dlg-repo[open]');
    L.check('401 RepoNotFound on commit opens the "anlegen" dialog', true);
    L.check('... and keeps the writer signed in', await page.evaluate(() => !!window.__hw.hf.getAuth()));
    L.check('the line stays queued meanwhile', (await queued()) === 1);
    await page.click('#repo-later');
    await page.evaluate(() => window.__hw.outbox.flush('session-end'));
    await page.waitForTimeout(400);
    L.check('after "Später" an automatic flush does not open the dialog again', !(await page.isVisible('#dlg-repo')));
    // A bare 401 while whoami still works means "no access to that repo", not "signed out".
    mode = '401bare';
    await page.evaluate(() => window.__hw.outbox.flush('manual'));
    await page.waitForSelector('#dlg-repo[open]');
    L.check('a bare 401 with a working token: dialog again on "Jetzt hochladen", still signed in', await page.evaluate(() => !!window.__hw.hf.getAuth()));
    createMode = '409';
    await page.click('#repo-create');
    await page.waitForSelector('#repo-err:not([hidden])');
    L.check('409 on create is not reported as success', (await page.textContent('#repo-err')).includes('gibt es schon') && (await queued()) === 1, await page.textContent('#repo-err'));
    createMode = 'ok';
    await page.click('#repo-create');
    await L.until(async () => (await queued()) === 0);
    const create = commits.find((c) => c.mode === 'create-ok');
    L.check('repo created private as dataset handwriting-fable', create && JSON.stringify(JSON.parse(create.body)) === JSON.stringify({ type: 'dataset', name: 'handwriting-fable', private: true }));
    L.check('upload follows creation', commits[commits.length - 1].mode === 'ok', commits.map((c) => c.mode + ':' + (c.body || '').split('\n').length).join(' '));

    // Batches of at most 25 lines.
    const before = commits.length;
    await page.evaluate(async () => {
      const all = await window.__hw.store.allLines();
      const tpl = all[0].record;
      for (let i = 0; i < 30; i++) {
        const r = JSON.parse(JSON.stringify(tpl));
        r.id = crypto.randomUUID(); r.prompt.id = `batch-${i}`; r.created_at = new Date(Date.now() + i).toISOString();
        await window.__hw.store.putLine(r);
      }
      await window.__hw.outbox.flush('manual');
    });
    await L.until(async () => (await queued()) === 0);
    const sizes = commits.slice(before).map((c) => c.body.split('\n').length - 1);
    L.check('30 lines go up as 25 + 5', sizes.join() === '25,5', sizes.join());

    // One line the server refuses must not block the others (no head-of-line blocking).
    mode = 'poison';
    const before2 = commits.length;
    await page.evaluate(async () => {
      const all = await window.__hw.store.allLines();
      const tpl = all[0].record;
      for (let i = 0; i < 6; i++) {
        const r = JSON.parse(JSON.stringify(tpl));
        r.id = crypto.randomUUID(); r.prompt.id = i === 0 ? 'poison-line' : `good-${i}`; r.created_at = new Date(Date.now() + 1000 + i).toISOString();
        await window.__hw.store.putLine(r);
      }
      await window.__hw.outbox.flush('manual');
    });
    await L.until(async () => (await queued()) === 0);
    const states = await page.evaluate(async () => (await window.__hw.store.allLines()).filter((e) => /poison|good-/.test(e.prompt_id)).map((e) => `${e.prompt_id}:${e.state}`).sort());
    L.check('a refused line is set aside, the 5 others are uploaded', states.join() === 'good-1:sent,good-2:sent,good-3:sent,good-4:sent,good-5:sent,poison-line:rejected', states.join());
    L.check('no back-off is left behind', await page.evaluate(() => !window.__hw.outbox.status().lastError && !window.__hw.outbox.status().notBefore), `${commits.length - before2} commits`);
    await page.click('a[data-route="einstellungen"]');
    await page.waitForSelector('#up-rejected:not([hidden])', { timeout: 3000 }).catch(() => {});
    L.check('settings show the refused line', (await page.textContent('#up-rejected')).startsWith('1 Zeile wurde von Hugging Face abgelehnt'), await page.textContent('#up-rejected'));

    // A server error is shown in the top bar (not as a normal wait) and honours Retry-After.
    mode = '500';
    await page.evaluate(async () => {
      const all = await window.__hw.store.allLines();
      const r = JSON.parse(JSON.stringify(all[0].record));
      r.id = crypto.randomUUID(); r.prompt.id = 'after-500'; r.created_at = new Date(Date.now() + 5000).toISOString();
      await window.__hw.store.putLine(r);
      await window.__hw.outbox.flush('manual');
    });
    await page.waitForFunction(() => document.getElementById('waiting').classList.contains('problem'), null, { timeout: 3000 }).catch(() => {});
    L.check('upload failure: indicator says "Hochladen klappt gerade nicht"', (await page.textContent('#waiting-text')) === 'Hochladen klappt gerade nicht'
      && (await page.getAttribute('#waiting-icon', 'href')) === '#i-cloud-alert');
    L.check('5xx Retry-After: 120 s is respected', await page.evaluate(() => window.__hw.outbox.status().notBefore - Date.now() > 100000));
    L.check('the status text carries no HTTP code', !/\d{3}/.test(await page.textContent('#up-status')), await page.textContent('#up-status'));
    L.check('no page errors', errors.filter((e) => !/Failed to load resource|ERR_/.test(e)).length === 0, errors.join(' | '));
  } catch (e) {
    console.error(e); L.check('test ran without exception', false, String(e));
  } finally {
    await browser.close(); await server.close();
  }
  process.exit(L.summary() ? 0 : 1);
})();
