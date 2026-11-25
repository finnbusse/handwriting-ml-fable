// Screenshots of every screen: tablet landscape 1280x800 @2x, phone 412x915, plus dark mode.
const L = require('./lib.cjs');

/** Cursive-looking ink: one looped stroke per word, an i-dot here and there. */
async function writeWords(page, cdp, text, maxWidthFrac = 0.9) {
  const rect = await L.canvasRect(page);
  const base = rect.top + rect.height * 0.64;
  const p = L.pen(cdp);
  const words = text.split(/\s+/);
  const chars = text.replace(/\s/g, '').length;
  const unit = Math.min(20, (rect.width * maxWidthFrac - 60) / (chars + words.length * 0.8));
  let x = rect.left + 44;
  for (const w of words) {
    const n = w.length;
    const pts = [];
    const steps = n * 10;
    for (let i = 0; i <= steps; i++) {
      const a = (i / 10) * Math.PI * 2;
      const tall = /[A-ZÄÖÜbdfhklt]/.test(w[Math.min(n - 1, Math.floor(i / 10))]) ? 2.1 : 1;
      pts.push([x + (i / 10) * unit + Math.sin(a) * unit * 0.32, base - (1 - Math.cos(a)) * unit * 0.42 * tall, 0.4]);
    }
    await p.stroke(pts);
    if (/i/.test(w)) { const k = w.indexOf('i'); await p.stroke([[x + (k + 0.5) * unit, base - unit * 1.35], [x + (k + 0.5) * unit + 0.8, base - unit * 1.32], [x + (k + 0.5) * unit + 1, base - unit * 1.3]]); }
    x += (n + 0.8) * unit;
  }
}

async function run(browser, server, tag, viewport, dsf, colorScheme) {
  const hf = (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/api/whoami-v2') return { status: 200, body: { name: L.FAKE_USER } };
    if (u.pathname.includes('/tree/')) return { status: 404 };
    if (u.pathname.endsWith('/commit/main')) return { status: 404 };
    return null;
  };
  const shoot = (page, name) => L.shot(page, `${tag}-${name}`);
  // Signed out first.
  let { page, cdp, ctx, errors } = await L.newApp(browser, server, { viewport, dsf, colorScheme, hf });
  await page.waitForSelector('#v-start:not([hidden])');
  await shoot(page, '01-start-first');
  await page.fill('#start-writer', 'Finn');
  await shoot(page, '01-start');
  await page.click('#start-go');
  await page.waitForSelector('#cap[data-state="write"]');
  await page.evaluate(() => document.fullscreenElement && document.exitFullscreen());
  await page.waitForTimeout(250);
  await shoot(page, '02-capture-empty');
  const prompt = await page.textContent('#cap-prompt');
  await writeWords(page, cdp, prompt);
  await page.waitForTimeout(100);
  await shoot(page, '03-capture-ink');
  await L.settle(page);
  await page.click('#cap-clear');
  await page.waitForTimeout(100);
  await shoot(page, '03b-cleared-toast');
  await L.settle(page);
  await page.click('#cap-undo');
  await L.settle(page);
  await page.click('#cap-done');
  await page.waitForSelector('#cap[data-state="confirm"]');
  await page.waitForTimeout(150);
  await shoot(page, '04-confirm');
  await L.settle(page);
  await page.click('#confirm-ok');
  await page.waitForSelector('#cap[data-state="write"]');
  const rect = await L.canvasRect(page);
  await L.pen(cdp).stroke(L.glyph(rect.left + 60, rect.top + rect.height * 0.64, 8));
  await L.pen(cdp).stroke([[rect.left + rect.width - 30, rect.top + rect.height - 16], [rect.left + rect.width - 29.5, rect.top + rect.height - 15.5], [rect.left + rect.width - 29, rect.top + rect.height - 15]]);
  await L.settle(page);
  await page.click('#cap-done');
  await page.waitForSelector('#cap[data-state="confirm"]');
  await page.waitForTimeout(150);
  await shoot(page, '05-confirm-flagged');
  await L.settle(page);
  await page.click('#confirm-redo');
  await page.waitForSelector('#cap[data-state="write"]');
  await L.pen(cdp).stroke(L.glyph(rect.left + 60, rect.top + rect.height * 0.64, 8));
  await page.evaluate(() => { window.__hw.capture.recorder.paused = true; document.getElementById('cap').dataset.state = 'pause'; });
  await shoot(page, '06-pause');
  await L.settle(page);
  await page.click('#pause-ok');
  // Finish block 1: mark all but the current prompt as done.
  await page.evaluate(() => {
    const app = window.__hw.app;
    const cur = document.getElementById('cap-prompt').textContent;
    const b1 = app.prompts.prompts.filter((p) => p.block === app.prompts.prompts[0].block);
    for (const p of b1) if (p.text !== cur) app.localDone.add(p.id);
  });
  await writeWords(page, cdp, prompt.slice(0, 18));
  await L.settle(page);
  await page.click('#cap-done');
  await page.waitForSelector('#cap[data-state="confirm"]');
  await L.settle(page);
  await page.click('#confirm-ok');
  await page.waitForTimeout(150);
  const st = await page.getAttribute('#cap', 'data-state');
  await shoot(page, st === 'block' ? '07-block-done' : '07-all-done');
  if (st === 'block') {
    await L.settle(page);
    await page.click('#block-pause');
    await shoot(page, '08-resting');
  }
  await page.evaluate(() => { document.getElementById('all-text').textContent = 'Danke! Alle 100 Zeilen sind geschrieben.'; document.getElementById('cap').dataset.state = 'all'; });
  await shoot(page, '09-all-done');
  await page.click('a[data-route="schreiben"]');
  await page.waitForSelector('#v-schreiben:not([hidden])');
  await shoot(page, '10-schreiben');
  await page.click('a[data-route="einstellungen"]');
  await page.waitForSelector('#v-einstellungen:not([hidden])');
  await page.waitForTimeout(150);
  await shoot(page, '11-settings-signed-out');
  await page.click('#acc-token');
  await shoot(page, '12-token-dialog');
  await page.fill('#tok-input', L.FAKE_TOKEN);
  await page.click('#tok-ok');
  await page.waitForSelector('#dlg-repo[open]', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(200);
  if (await page.isVisible('#dlg-repo')) {
    await shoot(page, '13-repo-dialog');
    await page.click('#repo-later');
  }
  await page.waitForTimeout(150);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shoot(page, '14-settings-signed-in');
  await page.evaluate(() => { const v = document.getElementById('v-einstellungen'); v.scrollTop = v.scrollHeight; });
  await page.waitForTimeout(100);
  await shoot(page, '15-settings-diagnostics');
  L.check(`${tag}: no page errors`, errors.filter((e) => !/Failed to load resource/.test(e)).length === 0, errors.join(' | '));
  await ctx.close();
}

(async () => {
  const server = await L.start();
  const browser = await L.launch();
  try {
    await run(browser, server, 'tablet', { width: 1280, height: 800 }, 2, 'light');
    await run(browser, server, 'phone', { width: 412, height: 915 }, 2, 'light');
    await run(browser, server, 'tablet-dark', { width: 1280, height: 800 }, 1, 'dark');
    L.check('screenshots written', require('fs').readdirSync(L.SHOTS).filter((f) => f.endsWith('.png')).length >= 30);
  } catch (e) {
    console.error(e); L.check('test ran without exception', false, String(e));
  } finally {
    await browser.close(); await server.close();
  }
  process.exit(L.summary() ? 0 : 1);
})();
