// Progress restored from the dataset listing, and offline start after the first load.
const fs = require('fs');
const path = require('path');
const L = require('./lib.cjs');

function promptIds() {
  try {
    const d = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'web', 'prompts', 'de-core.json'), 'utf8'));
    if (Array.isArray(d.prompts) && d.prompts.length > 2) return d.prompts.slice().sort((a, b) => a.block - b.block).map((p) => p.id);
  } catch (_) {}
  return ['fallback-0001', 'fallback-0002', 'fallback-0003'];
}

(async () => {
  const server = await L.start();
  const browser = await L.launch();
  try {
    // ---- progress from the tree API (two pages, Link: rel="next") ----
    const ids = promptIds();
    const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const treeCalls = [];
    const hf = (req) => {
      const u = new URL(req.url);
      if (u.pathname === '/api/whoami-v2') return { status: 200, body: { name: L.FAKE_USER } };
      if (u.pathname === `/api/datasets/${L.FAKE_USER}/handwriting-fable/tree/main/raw/v1`) {
        treeCalls.push(req.url);
        if (u.searchParams.get('cursor') === 'p2') {
          return { status: 200, body: [{ type: 'file', path: `raw/v1/s2/${ids[1]}__${uuid(2)}.json` }] };
        }
        return { status: 200, headers: { link: `<https://huggingface.co${u.pathname}?recursive=true&expand=false&cursor=p2>; rel="next"` },
                 body: [{ type: 'directory', path: 'raw/v1/s1' }, { type: 'file', path: `raw/v1/s1/${ids[0]}__${uuid(1)}.json` }, { type: 'file', path: 'raw/v1/s1/notes.txt' }] };
      }
      return null;
    };
    {
      const { page, ctx, errors } = await L.newApp(browser, server, { hash: '#/erfassen', signedIn: true, hf });
      await page.waitForSelector('#cap[data-state="write"]');
      await L.until(async () => (await page.textContent('#cap-total')).startsWith('2 von'));
      L.check('tree listing followed both pages', treeCalls.length === 2 && treeCalls[0].includes('recursive=true'), treeCalls.join(' '));
      L.check('progress restored from file names: 2 done', (await page.textContent('#cap-total')).startsWith('2 von'), await page.textContent('#cap-total'));
      const shown = await page.evaluate(() => window.__hw.app.prompts.prompts.find((p) => p.text === document.getElementById('cap-prompt').textContent).id);
      L.check('next prompt is the first one not in the dataset', shown === ids[2], shown);
      L.check('Zeile 3 of block 1', /Block 1 · Zeile 3 von/.test(await page.textContent('#cap-progress')));
      L.check('no page errors', errors.length === 0, errors.join(' | '));
      await ctx.close();
    }
    {
      // A dataset that does not exist yet (404) is fine.
      const { page, ctx, errors } = await L.newApp(browser, server, { hash: '#/erfassen', signedIn: true, hf: (r) => (new URL(r.url).pathname.includes('/tree/') ? { status: 404 } : null) });
      await page.waitForSelector('#cap[data-state="write"]');
      await page.waitForTimeout(300);
      L.check('404 on the listing: starts at line 1', /Zeile 1 von/.test(await page.textContent('#cap-progress')));
      L.check('404 on the listing: no errors', errors.filter((e) => !/Failed to load resource/.test(e)).length === 0, errors.join(' | '));
      await ctx.close();
    }

    // ---- offline start ----
    const { page, ctx } = await L.newApp(browser, server, { hash: '#/erfassen', serviceWorkers: 'allow' });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await L.until(() => page.evaluate(() => !!navigator.serviceWorker.controller), 10000);
    const cacheNames = await page.evaluate(() => caches.keys());
    L.check('service worker precached the shell under a versioned cache', cacheNames.some((c) => /^hw-shell-\d+\.\d+\.\d+/.test(c)), cacheNames.join());
    const cached = await page.evaluate(async () => { const c = await caches.open((await caches.keys()).find((k) => k.startsWith('hw-shell-'))); return (await c.keys()).map((r) => r.url); });
    L.check('no Hugging Face URL in the cache', cached.every((u) => !u.includes('huggingface.co')));
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => window.__hwReady);
    await page.waitForSelector('#cap[data-state="write"]', { timeout: 5000 });
    const txt = await page.textContent('#cap-prompt');
    L.check('offline reload shows the capture screen with a prompt', txt.trim().length > 5, txt);
    await page.goto(`http://localhost:${server.port}/`).catch((e) => console.log('goto /:', String(e).slice(0, 200)));
    await page.waitForSelector('.view:not([hidden])', { timeout: 5000 }).catch(() => {});
    L.check('offline "/" is answered by the service worker', await page.isVisible('.view:not([hidden])'));
    await ctx.close();
  } catch (e) {
    console.error(e); L.check('test ran without exception', false, String(e));
  } finally {
    await browser.close(); await server.close();
  }
  process.exit(L.summary() ? 0 : 1);
})();
