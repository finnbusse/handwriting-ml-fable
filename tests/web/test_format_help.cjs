// Schreiben, page mode: the "Formatierung" panel (format-help.js).  Opening and closing
// (pointer, touch, keyboard), the reference from CHEAT_SHEET, the choice of format, the
// example with its second step and its way back.  The panel runs on the app's own page
// and styles with the module given stand-ins for page-view's settings, so no model is needed.
const fs = require('fs');
const path = require('path');
const L = require('./lib.cjs');

const INDEX = fs.readFileSync(path.join(require('./server.cjs').ROOT, 'index.html'), 'utf8');
const HARNESS = `<script type="module">
import { createFormatHelp, EXAMPLE_TEXT } from './js/generate/format-help.js';
import { CHEAT_SHEET } from './js/generate/markup.js';
document.body.dataset.route = 'schreiben';
for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== 'v-schreiben';
document.getElementById('gen').dataset.mode = 'seite';
document.getElementById('pg-stage').hidden = false;
document.getElementById('gen-work').hidden = false;
const fh = window.__fh = { format: 'auto', set: [], onText: 0, EXAMPLE_TEXT, CHEAT_SHEET };
fh.help = createFormatHelp({
  text: document.getElementById('pg-text'),
  getFormat: () => fh.format,
  setFormat: (f) => { fh.format = f; fh.set.push(f); },
  onText: () => { fh.onText++; },
});
window.__hwReady = true;
</script>`;
const PAGE = INDEX.replace(/<script type="module" src="js\/main\.js"><\/script>/, HARNESS);

async function open(browser, server, opts = {}) {
  return L.newApp(browser, server, {
    ...opts,
    url: server.url.replace('index.html', 'format-help.html'),
    routes: (ctx) => ctx.route('**/format-help.html', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE })),
  });
}
const fh = (page) => page.evaluate(() => { const { help, EXAMPLE_TEXT, CHEAT_SHEET, ...rest } = window.__fh; return rest; });
const shown = (page) => page.isVisible('#pg-format-panel');
const focusIn = (page) => page.evaluate(() => document.getElementById('pg-format-panel').contains(document.activeElement));
const focused = (page) => page.evaluate(() => document.activeElement && document.activeElement.id);

async function desktop(browser, server) {
  const { page, ctx, errors } = await open(browser, server);
  L.check('the page mode shows the "Formatierung" button, the panel is closed', PAGE !== INDEX && await page.isVisible('#pg-format') && !(await shown(page)) && (await page.getAttribute('#pg-format', 'aria-expanded')) === 'false');

  // ---- pointer ----
  await page.click('#pg-format');
  L.check('a click opens the panel, the button says so', await shown(page) && (await page.getAttribute('#pg-format', 'aria-expanded')) === 'true');
  L.check('opening moves the focus into the panel, to the format in use', await focusIn(page) && (await page.evaluate(() => document.activeElement.dataset.v)) === 'auto');
  await page.click('#pg-format');
  L.check('a second click closes it, the focus is back on the button', !(await shown(page)) && (await focused(page)) === 'pg-format');
  await page.click('#pg-format');
  await page.mouse.click(400, 120);   // the pages
  L.check('a click outside closes it', !(await shown(page)));
  await page.click('#pg-format');
  await page.click('#pg-text');
  L.check('a click into the text field closes it and leaves the focus there', !(await shown(page)) && (await focused(page)) === 'pg-text');

  // ---- keyboard ----
  await page.focus('#pg-format');
  await page.keyboard.press('Enter');
  L.check('Enter on the button opens the panel', await shown(page) && await focusIn(page));
  await page.keyboard.press('Tab');
  L.check('Tab moves on inside the panel', await focusIn(page));
  await page.keyboard.press('Escape');
  L.check('Escape closes it, the focus is back on the button', !(await shown(page)) && (await focused(page)) === 'pg-format');
  await page.keyboard.press('Space');
  L.check('Space opens it again', await shown(page));
  await page.keyboard.press('Escape');

  // ---- the reference ----
  await page.click('#pg-format');
  const ref = await page.evaluate(() => [...document.querySelectorAll('#pg-format-panel .pg-ref dt')].map((dt) => [dt.textContent, dt.nextElementSibling && dt.nextElementSibling.textContent]));
  const sheet = await page.evaluate(() => window.__fh.CHEAT_SHEET.map((r) => [r.schreiben, r.ergebnis]));
  L.check('the reference lists every row of CHEAT_SHEET, in order, typed and result', JSON.stringify(ref) === JSON.stringify(sheet) && sheet.length >= 10, `${ref.length} of ${sheet.length}`);
  const scroll = await page.evaluate(() => { const p = document.getElementById('pg-format-panel'); return { inner: p.scrollHeight > p.clientHeight, style: getComputedStyle(p).overflowY, page: document.scrollingElement.scrollHeight <= innerHeight + 1 }; });
  L.check('a long reference scrolls inside the panel; the page behind does not scroll', scroll.style === 'auto' && scroll.page, JSON.stringify(scroll));

  // ---- the format ----
  const checked = () => page.evaluate(() => [...document.querySelectorAll('#pg-format-panel [role=radio]')].map((b) => `${b.dataset.v}:${b.getAttribute('aria-checked')}`).join(' '));
  L.check('four formats, Automatisch chosen at first', (await page.evaluate(() => [...document.querySelectorAll('#pg-format-panel [role=radio]')].map((b) => b.textContent).join('|'))) === 'Automatisch|Markdown|LaTeX|Nur Text' && (await checked()).startsWith('auto:true'));
  await page.click('#pg-format-panel [data-v="latex"]');
  L.check('a choice calls setFormat and is shown as chosen', JSON.stringify((await fh(page)).set) === '["latex"]' && (await checked()).includes('latex:true') && (await checked()).includes('auto:false'));
  await page.evaluate(() => { window.__fh.format = 'text'; window.__fh.help.refresh(); });
  L.check('refresh() shows the stored choice', (await checked()).includes('text:true') && !(await checked()).includes('latex:true'));
  await page.keyboard.press('Escape');
  await page.click('#pg-format');
  L.check('the choice survives closing and opening', (await checked()).includes('text:true'));

  // ---- the example: into an empty field at once ----
  await page.click('#pg-example');
  const ex = await page.evaluate(() => window.__fh.EXAMPLE_TEXT);
  L.check('empty field: "Beispiel einsetzen" puts the example in at once and calls onText', (await page.inputValue('#pg-text')) === ex && (await fh(page)).onText === 1);
  L.check('under "Nur Text" the example sets the choice back to Automatisch', (await fh(page)).format === 'auto' && (await checked()).includes('auto:true'));
  L.check('nothing was replaced, so there is nothing to bring back', await page.isHidden('#pg-example-undo') && await page.isHidden('#pg-example-keep'));

  // ---- into a filled field only after the second step ----
  const mine = 'Mein eigener Text\nmit zwei Zeilen';
  await page.fill('#pg-text', mine);
  await page.click('#pg-format');
  if (!(await shown(page))) await page.click('#pg-format');
  await page.click('#pg-example');
  L.check('filled field: the first tap only asks ("Text ersetzen", "Behalten")', (await page.inputValue('#pg-text')) === mine && (await page.textContent('#pg-example')) === 'Text ersetzen' && await page.isVisible('#pg-example-keep') && (await fh(page)).onText === 1);
  await page.click('#pg-example-keep');
  L.check('"Behalten" keeps the text and takes the question back', (await page.inputValue('#pg-text')) === mine && (await page.textContent('#pg-example')) === 'Beispiel einsetzen' && await page.isHidden('#pg-example-keep'));
  await page.click('#pg-example');
  await page.click('#pg-example');
  L.check('the second step replaces the text and calls onText', (await page.inputValue('#pg-text')) === ex && (await fh(page)).onText === 2);
  L.check('"Rückgängig" is offered and has the focus', await page.isVisible('#pg-example-undo') && (await focused(page)) === 'pg-example-undo');
  await page.click('#pg-example-undo');
  L.check('"Rückgängig" brings the replaced text back and calls onText', (await page.inputValue('#pg-text')) === mine && (await fh(page)).onText === 3 && await page.isHidden('#pg-example-undo'));
  await page.click('#pg-example'); await page.click('#pg-example');
  await page.keyboard.press('Escape');
  await page.click('#pg-format');
  L.check('the way back survives closing the panel', await page.isVisible('#pg-example-undo'));
  await page.click('#pg-text');
  await page.keyboard.press('End');
  await page.keyboard.type(' und mehr');
  await page.click('#pg-format');
  L.check('once the example is edited, "Rückgängig" is gone (it would lose the edit)', await page.isHidden('#pg-example-undo'));
  await page.keyboard.press('Escape');

  // ---- Stil and Formatierung, one at a time ----
  await page.click('#gen-style-btn');
  await page.click('#pg-format');
  L.check('opening Formatierung closes Stil', await shown(page) && await page.isHidden('#gen-style'));
  await page.click('#gen-style-btn');
  L.check('a tap on Stil closes Formatierung', !(await shown(page)));

  L.check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

async function touch(browser, server) {
  for (const [tag, viewport, colorScheme] of [['tablet', { width: 800, height: 1280 }, 'dark'], ['tablet-landscape', { width: 1280, height: 800 }, 'light'], ['phone', { width: 360, height: 740 }, 'light']]) {
    const { page, ctx, cdp, errors } = await open(browser, server, { viewport, colorScheme });
    const tap = async (sel) => { const b = await page.locator(sel).boundingBox(); await L.pen(cdp).touchTap(b.x + b.width / 2, b.y + b.height / 2); await page.waitForTimeout(120); };
    await tap('#pg-format');
    L.check(`${tag}: a finger tap opens the panel`, await shown(page));
    const fit = await page.evaluate(() => {
      const p = document.getElementById('pg-format-panel').getBoundingClientRect();
      const small = [...document.querySelectorAll('#pg-format-panel button, #pg-format')].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect()).filter((r) => r.height < 47.5 || r.width < 47.5).length;
      return { inside: p.left >= 0 && p.right <= innerWidth + 0.5 && p.top >= 0 && p.bottom <= innerHeight + 0.5, wide: [...document.querySelectorAll('#pg-format-panel *, .pg-fmt-row *')].every((e) => e.getBoundingClientRect().right <= innerWidth + 0.5), small };
    });
    L.check(`${tag}: the panel and all in it fit the screen, every target 48 px`, fit.inside && fit.wide && fit.small === 0, JSON.stringify(fit));
    await tap('#pg-format-panel [data-v="markdown"]');
    L.check(`${tag}: a tap chooses the format`, (await fh(page)).format === 'markdown');
    const pages = await page.locator('#pg-stage').boundingBox();
    await L.pen(cdp).touchTap(pages.x + pages.width / 2, pages.y + 20);
    await page.waitForTimeout(120);
    L.check(`${tag}: a tap outside closes it`, !(await shown(page)));
    L.check(`${tag}: no page errors`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
}

(async () => {
  const server = await L.start();
  const browser = await L.launch();
  try {
    await desktop(browser, server);
    await touch(browser, server);
  } catch (e) {
    console.error(e); L.check('test ran without exception', false, String(e));
  } finally {
    await browser.close(); await server.close();
  }
  process.exit(L.summary() ? 0 : 1);
})();
