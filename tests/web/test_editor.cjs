// Schreiben, page mode: the editor (editor-tools.js).  The text operations in Node; then
// in the browser the two layouts (text beside the pages, pages above the text), hiding
// the text, the large and small field, the on-screen keyboard (a shortened visual
// viewport), every mark tool, the list keys, undo, and "Nur Text".  Like
// test_format_help.cjs it runs on the app's own page and styles with stand-ins for
// page-view's settings, so no model is needed; with the test model in
// tests/engine/fixtures the real app is checked too.
const fs = require('fs');
const path = require('path');
const L = require('./lib.cjs');

const ROOT = require('./server.cjs').ROOT;
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
// three A4 pages, so that the document has something to scroll
const HARNESS = `<script type="module">
import { createEditor } from './js/generate/editor-tools.js';
import { createFormatHelp } from './js/generate/format-help.js';
document.body.dataset.route = 'schreiben';
for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== 'v-schreiben';
document.getElementById('gen').dataset.mode = 'seite';
document.getElementById('gen-stage').hidden = true;
document.getElementById('pg-stage').hidden = false;
document.getElementById('gen-work').hidden = false;
const pages = document.getElementById('pg-pages');
for (let i = 0; i < 3; i++) { const p = document.createElement('div'); p.className = 'pg-page'; pages.insertBefore(p, document.getElementById('pg-pick')); }
const ed = window.__ed = { format: 'markdown', inputs: 0 };
document.getElementById('pg-text').addEventListener('input', () => { ed.inputs++; });
ed.editor = createEditor({ text: document.getElementById('pg-text'), root: document.getElementById('gen'), format: () => ed.format });
createFormatHelp({ text: document.getElementById('pg-text'), getFormat: () => 'auto', setFormat: () => {}, onText: () => {} });
// Stil as view.js opens it
const style = document.getElementById('gen-style'), styleBtn = document.getElementById('gen-style-btn');
styleBtn.addEventListener('click', () => { style.hidden = !style.hidden; styleBtn.setAttribute('aria-expanded', String(!style.hidden)); });
window.__hwReady = true;
</script>`;
const PAGE = INDEX.replace(/<script type="module" src="js\/main\.js"><\/script>/, HARNESS);
// The on-screen keyboard shortens the visual viewport and leaves the layout: a stand-in
// whose height the test sets (Chromium here has no keyboard to open).
const FAKE_VV = `(() => {
  const real = window.visualViewport; if (!real) return;
  const f = new EventTarget();
  for (const k of ['width', 'offsetLeft', 'pageLeft', 'pageTop', 'scale']) Object.defineProperty(f, k, { get: () => real[k] });
  Object.defineProperty(f, 'height', { get: () => f.h ?? real.height });
  Object.defineProperty(f, 'offsetTop', { get: () => f.top ?? real.offsetTop });
  real.addEventListener('resize', () => f.dispatchEvent(new Event('resize')));
  Object.defineProperty(window, 'visualViewport', { get: () => f, configurable: true });
  window.__vv = f;
})();`;

async function open(browser, server, opts = {}) {
  return L.newApp(browser, server, {
    init: FAKE_VV, ...opts,
    url: server.url.replace('index.html', 'editor.html'),
    routes: (ctx) => ctx.route('**/editor.html', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE })),
  });
}

// ---------- the text operations, in Node ----------

async function pure() {
  const { applyTool, listKey, TOOLS } = await import('../../web/js/generate/editor-tools.js');
  // «» mark the selection
  const parse = (s) => { const a = s.indexOf('«'), b = s.indexOf('»') - 1; return [s.replace('«', '').replace('»', ''), a, b]; };
  const show = (r) => r && r.text.slice(0, r.start) + '«' + r.text.slice(r.start, r.end) + '»' + r.text.slice(r.end);
  const tool = (t, s, f) => { const [x, a, b] = parse(s); return show(applyTool(t, x, a, b, f)); };
  const key = (k, s, f) => { const [x, a, b] = parse(s); return show(listKey(k, x, a, b, f)); };
  const cases = [
    // [tool, before, after, format]
    ['bold', 'ein «Wort» hier', 'ein **«Wort»** hier'], ['bold', 'ein **«Wort»** hier', 'ein «Wort» hier'],
    ['bold', 'ein Wo«»rt', 'ein **Wo«»rt**'], ['bold', 'ein **Wo«»rt**', 'ein Wo«»rt'], ['bold', 'x «»', 'x **«»**'], ['bold', 'x **«»**', 'x «»'],
    ['bold', '«eins\nzwei»', '**«eins**\n**zwei»**'], ['bold', '«**eins**\n**zwei**»', '«eins\nzwei»'],
    ['underline', 'a «b c »d', 'a *«b c»* d'], ['underline', 'a *«b c»* d', 'a «b c» d'],
    ['mark', '- [ ] «Aufgabe»', '- [ ] ==«Aufgabe»=='], ['mark', '==«gelb»=={grün}', '«gelb»'],
    ['color', '«Wort»', '[«Wort»]{rot}'], ['color', '[«Wort»]{rot}', '[«Wort»]{blau}'], ['color', '[«Wort»]{blau}', '[«Wort»]{grün}'], ['color', '[«Wort»]{grün}', '«Wort»'],
    ['heading', 'Ti«»tel', '# Ti«»tel'], ['heading', '## Ti«»tel', 'Ti«»tel'], ['heading', '- Ti«»tel', '# Ti«»tel'], ['heading', '«a\nb»', '# «a\n# b»'],
    ['list', '«a\nb\nc»', '- «a\n- b\n- c»'], ['list', '«- a\n- b»', '«a\nb»'], ['list', '«»', '- «»'], ['list', '- [ ] x«»', '- x«»'], ['list', '  1. x«»', '  - x«»'],
    ['check', 'x«»', '- [ ] x«»'], ['check', '- [ ] x«»', '- [x] x«»'], ['check', '- [x] x«»', 'x«»'], ['check', '- x«»', '- [ ] x«»'],
    ['box', '«a\n\nb»', '> «a\n>\n> b»'], ['box', '«> a\n>\n> b»', '«a\n\nb»'], ['box', '«»', '> «»'],
    ['center', 'Ti«»tel', '{mitte} Ti«»tel'], ['center', '{mitte} Ti«»tel', 'Ti«»tel'], ['center', '# Ti«»tel', '# {mitte} Ti«»tel'], ['center', '- a«»', '{mitte} a«»'],
    ['arrow', 'A«»', 'A -> «»'], ['arrow', 'A «» B', 'A -> «»B'], ['date', 'Heute: «»', 'Heute: {datum} «»'],
    ['bold', '«Wort»', '\\textbf{«Wort»}', 'latex'], ['bold', '\\textbf{«Wort»}', '«Wort»', 'latex'], ['underline', '\\underline{W«»ort}', 'W«»ort', 'latex'],
    ['mark', 'ein «Wort»', 'ein \\hl{«Wort»}', 'latex'], ['color', '«Wort»', '\\textcolor{red}{«Wort»}', 'latex'], ['color', '\\textcolor{red}{«Wort»}', '\\textcolor{blue}{«Wort»}', 'latex'],
    ['color', '\\textcolor{green}{«Wort»}', '«Wort»', 'latex'], ['heading', 'Ti«»tel', '\\section{Ti«»tel}', 'latex'], ['heading', '\\section{Ti«»tel}', 'Ti«»tel', 'latex'],
    ['heading', '\\item a«»', '\\section{a«»}', 'latex'], ['list', '«a\nb»', '\\item «a\n\\item b»', 'latex'], ['list', '\\item «a»', '«a»', 'latex'],
    ['check', 'x«»', '\\item[$\\square$] x«»', 'latex'], ['check', '\\item[$\\square$] x«»', '\\item[$\\checkmark$] x«»', 'latex'], ['check', '\\item[$\\checkmark$] x«»', 'x«»', 'latex'],
    ['box', '«a\nb»', '\\begin{framed}\n«a\nb»\n\\end{framed}', 'latex'], ['box', '\\begin{framed}\n«a\nb»\n\\end{framed}', '«a\nb»', 'latex'],
    ['center', 'x«»', '\\begin{center}\nx«»\n\\end{center}', 'latex'], ['arrow', 'A«»', 'A $\\rightarrow$ «»', 'latex'], ['date', 'am «»', 'am \\today{} «»', 'latex'],
  ];
  const bad = cases.filter(([t, a, b, f]) => tool(t, a, f) !== b).map(([t, a, b, f]) => `${t}${f ? `/${f}` : ''}: ${JSON.stringify(a)} -> ${JSON.stringify(tool(t, a, f))}, wanted ${JSON.stringify(b)}`);
  L.check(`node: ${cases.length} tool cases (on a selection, a caret, several lines, off again, Markdown and LaTeX)`, !bad.length, bad.join(' | '));
  L.check('node: every tool is covered', TOOLS.every((t) => cases.some((c) => c[0] === t && !c[3]) && cases.some((c) => c[0] === t && c[3] === 'latex')));
  const keys = [
    ['Enter', '- a«»', '- a\n- «»'], ['Enter', '- «»', '«»'], ['Enter', '  - [ ] a«»', '  - [ ] a\n  - [ ] «»'], ['Enter', '- [x] a«»', '- [x] a\n- [ ] «»'],
    ['Enter', '1. a«»', '1. a\n2. «»'], ['Enter', 'a) a«»', 'a) a\nb) «»'], ['Enter', '- a«»b', '- a\n- «»b'], ['Enter', '> a«»', '> a\n> «»'], ['Enter', '> «»', '«»'],
    ['Enter', 'Text«»', null], ['Enter', '«»- a', null], ['Enter', '# Titel«»', null], ['Enter', '- «a»', null],
    ['Tab', '- a«»', '  - a«»'], ['Tab', '    - a«»', '    - a«»'], ['Tab', '«- a\n- b»', '«  - a\n  - b»'], ['Tab', 'Text«»', null],
    ['ShiftTab', '  - a«»', '- a«»'], ['ShiftTab', '«- a\n  - b»', '«- a\n- b»'], ['ShiftTab', 'Text«»', null],
    ['Enter', '\\item a«»', '\\item a\n\\item «»', 'latex'], ['Enter', '\\item «»', '«»', 'latex'], ['Enter', '\\item[$\\checkmark$] a«»', '\\item[$\\checkmark$] a\n\\item[$\\square$] «»', 'latex'],
    ['Tab', '\\item a«»', null, 'latex'], ['Enter', '- a«»', null, 'text'],
  ];
  const badKeys = keys.filter(([k, a, b, f]) => key(k, a, f) !== b).map(([k, a, b, f]) => `${k}: ${JSON.stringify(a)} -> ${JSON.stringify(key(k, a, f))}, wanted ${JSON.stringify(b)}`);
  L.check(`node: ${keys.length} list key cases (Enter goes on and ends a list, Tab and Shift+Tab move a level)`, !badKeys.length, badKeys.join(' | '));
}

// ---------- the browser ----------

const box = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e || !e.offsetParent) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; }, sel);
const val = (page) => page.inputValue('#pg-text');
const sel = (page) => page.evaluate(() => { const t = document.getElementById('pg-text'); return [t.selectionStart, t.selectionEnd]; });
/** Value and selection, written with «» as in the Node cases. */
const state = (page) => page.evaluate(() => { const t = document.getElementById('pg-text'), v = t.value; return v.slice(0, t.selectionStart) + '«' + v.slice(t.selectionStart, t.selectionEnd) + '»' + v.slice(t.selectionEnd); });
async function put(page, s) {
  const a = s.indexOf('«'), b = s.indexOf('»') - 1;
  await page.evaluate(([v, x, y]) => { const t = document.getElementById('pg-text'); t.value = v; t.focus(); t.setSelectionRange(x, y); }, [s.replace('«', '').replace('»', ''), a, b]);
}
const overflow = (page) => page.evaluate(() => {
  const out = [...document.querySelectorAll('#v-schreiben *')].filter((e) => e.offsetParent && !e.closest('.pg-marks') && !e.closest('.sr-only') && e.getBoundingClientRect().right > innerWidth + 0.5).map((e) => e.id || e.className);
  // (the top bar is not part of the page mode: at 360 px it is 19 px too wide, as it was before)
  const v = document.getElementById('v-schreiben');
  return { page: v.scrollWidth > v.clientWidth + 1, out };
});
const small = (page) => page.evaluate(() => [...document.querySelectorAll('#pg-marks button, #pg-editor-btn, #pg-size-btn, #pg-write')]
  .filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect()).filter((r) => r.height < 47.5 || r.width < 47.5).length);

async function wide(browser, server) {
  const { page, ctx, errors } = await open(browser, server, { viewport: { width: 1280, height: 800 } });
  const t = await box(page, '#pg-text'), st = await box(page, '#pg-stage'), w = await box(page, '#pg-write'), bar = await box(page, '#gen-work .gen-row');
  const m = await box(page, '#pg-marks');
  L.check('1280x800: text on the left, pages on the right, beside each other', t && st && t.right < st.left && t.width >= 320 && t.width <= 560 && Math.abs(t.width / (st.right - t.left) - 0.4) < 0.06, JSON.stringify([t, st]));
  L.check('1280x800: the text field fills its column from the top of the pages down to the tools', Math.abs(t.top - st.top) < 8 && m && Math.abs(m.top - t.bottom) < 8 && m.bottom <= st.bottom + 1 && t.height > 500, JSON.stringify([t, m, st]));
  L.check('1280x800: one bar below both: Schreiben at the right end of the text\'s half, the pages\' tools under the pages', w && bar && w.top >= st.bottom - 1 && Math.abs(w.right - t.right) < 2 && bar.left >= st.left - 14 && Math.abs((w.top + w.bottom) / 2 - (bar.top + bar.bottom) / 2) < 3, JSON.stringify([w, bar]));
  const scroll = await page.evaluate(() => { const s = document.getElementById('pg-stage'); s.scrollTop = 400; return { inner: s.scrollHeight > s.clientHeight + 100 && s.scrollTop > 0, page: document.scrollingElement.scrollHeight <= innerHeight + 1 }; });
  L.check('1280x800: the pages scroll inside their column, the page itself does not', scroll.inner && scroll.page, JSON.stringify(scroll));
  const o = await overflow(page);
  L.check('1280x800: nothing reaches past the right edge', !o.page && !o.out.length, JSON.stringify(o));
  L.check('1280x800: the new controls are 48 px targets', (await small(page)) === 0);

  // Formatierung and Stil open over their own half without moving anything
  await page.click('#pg-format');
  const fp = await box(page, '#pg-format-panel'), t2 = await box(page, '#pg-text'), st2 = await box(page, '#pg-stage');
  L.check('1280x800: Formatierung opens over the text\'s half, above the bar, nothing moves', fp && fp.left >= t.left - 1 && fp.right <= t.right + 1 && fp.bottom <= w.top && fp.top >= st.top - 1 && t2.height === t.height && st2.height === st.height, JSON.stringify([fp, t]));
  const fs2 = await page.evaluate(() => { const p = document.getElementById('pg-format-panel'); return p.scrollHeight > p.clientHeight ? getComputedStyle(p).overflowY : 'fits'; });
  L.check('1280x800: Formatierung scrolls inside itself', fs2 === 'auto' || fs2 === 'fits', fs2);
  await page.click('#gen-style-btn');
  const sp = await box(page, '#gen-style'), st3 = await box(page, '#pg-stage');
  L.check('1280x800: Stil opens over the pages\' half, above the bar, nothing moves', sp && sp.left >= st.left - 14 && sp.right <= st.right + 14 && sp.bottom <= w.top && st3.height === st.height && !(await page.isVisible('#pg-format-panel')), JSON.stringify(sp));
  await page.click('#gen-style-btn');

  // hide and show
  await page.click('#pg-editor-btn');
  const hid = { text: await page.isHidden('#pg-text'), marks: await page.isHidden('#pg-marks'), fmt: await page.isHidden('#pg-format'), write: await box(page, '#pg-write'), stage: await box(page, '#pg-stage') };
  L.check('hidden: the pages take the width, Schreiben stays in the bar', hid.text && hid.marks && hid.fmt && hid.write && hid.write.bottom <= 800 && hid.stage.width > st.width + 250 && (await page.getAttribute('#pg-editor-btn', 'aria-expanded')) === 'false', JSON.stringify(hid));
  await page.reload();
  await page.waitForFunction(() => window.__hwReady);
  L.check('hidden: still hidden after a reload', await page.isHidden('#pg-text') && (await page.getAttribute('#gen', 'data-editor')) === 'hidden');
  await page.click('#pg-editor-btn');
  const back = await box(page, '#pg-text');
  L.check('shown again: the text where it was, and so after a reload', back && Math.abs(back.width - t.width) < 1 && (await page.reload(), await page.waitForFunction(() => window.__hwReady), await page.isVisible('#pg-text')));

  // the keyboard: a visual viewport of 420 px
  await page.fill('#pg-text', Array.from({ length: 60 }, (_, i) => `Zeile ${i + 1}`).join('\n'));
  await page.evaluate(() => { const x = document.getElementById('pg-text'); x.focus(); x.setSelectionRange(x.value.length, x.value.length); x.scrollTop = 0; window.__vv.h = 420; window.__vv.dispatchEvent(new Event('resize')); });
  await page.waitForTimeout(250);
  const kb = await page.evaluate(() => { const x = document.getElementById('pg-text'), r = x.getBoundingClientRect(); return { write: document.getElementById('pg-write').getBoundingClientRect().bottom, text: r.bottom, caret: x.scrollTop + x.clientHeight >= x.scrollHeight - 30, page: document.scrollingElement.scrollTop }; });
  L.check('keyboard (1280x800, 420 px visible): Schreiben and the field end above it, the caret is in view', kb.write <= 420 && kb.text <= 420 && kb.caret, JSON.stringify(kb));
  await page.evaluate(() => { window.__vv.h = null; window.__vv.dispatchEvent(new Event('resize')); });
  await page.waitForTimeout(150);
  L.check('keyboard closed: the layout as before', Math.abs((await box(page, '#pg-text')).height - t.height) < 1);
  L.check('wide: no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

async function narrow(browser, server) {
  for (const [tag, viewport, colorScheme] of [['800x1280', { width: 800, height: 1280 }, 'light'], ['360x740', { width: 360, height: 740 }, 'dark']]) {
    const { page, ctx, errors } = await open(browser, server, { viewport, colorScheme });
    const st = await box(page, '#pg-stage'), c = await box(page, '.pg-composer');
    L.check(`${tag}: pages above, the text below, as before`, st && c && st.bottom <= c.top && (await page.isHidden('#pg-marks')) && (await page.isHidden('#pg-editor-btn')) && (await page.isVisible('#pg-size-btn')));
    await page.click('#pg-text');
    const row = await box(page, '#gen-work .gen-row'), mk = await box(page, '#pg-marks'), c2 = await box(page, '.pg-composer');
    L.check(`${tag}: typing, the mark tools take the status row's place, the field keeps its room`, !row && mk && mk.bottom <= c2.top && Math.abs(c2.height - c.height) < 1 || (!row && mk && c2.height >= c.height), JSON.stringify([row, mk, c, c2]));
    const scroll = await page.evaluate(() => { const s = document.getElementById('pg-stage'); return s.scrollHeight > s.clientHeight && document.scrollingElement.scrollHeight <= innerHeight + 1; });
    L.check(`${tag}: the pages scroll inside their column, the page itself does not`, scroll);
    const o = await overflow(page);
    L.check(`${tag}: nothing reaches past the right edge (the tool row scrolls sideways)`, !o.page && !o.out.length, JSON.stringify(o));
    L.check(`${tag}: the new controls are 48 px targets`, (await small(page)) === 0);
    // large and small
    const h0 = (await box(page, '#pg-text')).height;
    await page.click('#pg-size-btn');
    const big = await box(page, '#pg-text');
    L.check(`${tag}: large: the field takes about half of the height, the focus stays in it`, Math.abs(big.height - viewport.height / 2) < 30 && (await page.evaluate(() => document.activeElement.id)) === 'pg-text', `${h0} -> ${big.height}`);
    await page.evaluate(() => document.activeElement.blur());
    L.check(`${tag}: large stays large away from the keyboard`, Math.abs((await box(page, '#pg-text')).height - big.height) < 1);
    await page.click('#pg-size-btn');
    L.check(`${tag}: small again`, (await box(page, '#pg-text')).height < 100 && (await page.getAttribute('#pg-size-btn', 'aria-label')) === 'Textfeld vergrößern');
    // a long paste while the field has the focus
    await page.click('#pg-text');
    await page.evaluate(() => { const x = document.getElementById('pg-text'); x.value = Array.from({ length: 40 }, (_, i) => `Zeile ${i + 1}`).join('\n'); x.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' })); });
    L.check(`${tag}: a long paste makes the field large by itself`, (await page.getAttribute('#gen', 'data-field')) === 'big');
    // the keyboard: 320 px of the height go to it
    const vh = viewport.height - 320;
    await page.evaluate((h) => { const x = document.getElementById('pg-text'); x.focus(); x.setSelectionRange(x.value.length, x.value.length); x.scrollTop = 0; window.__vv.h = h; window.__vv.dispatchEvent(new Event('resize')); }, vh);
    await page.waitForTimeout(250);
    const kb = await page.evaluate(() => { const x = document.getElementById('pg-text'), r = x.getBoundingClientRect(), w = document.getElementById('pg-write').getBoundingClientRect(); return { write: w.bottom, wtop: w.top, top: r.top, text: r.bottom, h: r.height, caret: x.scrollTop + x.clientHeight >= x.scrollHeight - 30 }; });
    L.check(`${tag}: keyboard (${vh} px visible): the large field is half of that, Schreiben above the keyboard, the caret in view`, kb.write <= vh && kb.text <= vh && kb.top >= 0 && Math.abs(kb.h - vh / 2) < 30 && kb.caret, JSON.stringify(kb));
    await page.evaluate(() => { window.__vv.h = null; window.__vv.dispatchEvent(new Event('resize')); });
    await page.click('#pg-size-btn');
    L.check(`${tag}: no page errors`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
}

async function tools(browser, server) {
  const { page, ctx, errors } = await open(browser, server, { viewport: { width: 1280, height: 800 } });
  const tap = async (t) => { await page.click(`#pg-marks [data-tool="${t}"]`); };
  const steps = [
    // [tool, before, after]: on a selection, on a caret, on several lines, and off again
    ['bold', 'ein «Wort» hier', 'ein **«Wort»** hier'], ['bold', null, 'ein «Wort» hier'],
    ['underline', 'ein Wo«»rt', 'ein *Wo«»rt*'], ['underline', null, 'ein Wo«»rt'],
    ['mark', '«eins\nzwei»', '==«eins==\n==zwei»=='], ['mark', null, '«eins\nzwei»'],
    ['color', '«Wort»', '[«Wort»]{rot}'], ['color', null, '[«Wort»]{blau}'], ['color', null, '[«Wort»]{grün}'], ['color', null, '«Wort»'],
    ['heading', 'Ti«»tel', '# Ti«»tel'], ['heading', null, 'Ti«»tel'],
    ['list', '«a\nb»', '- «a\n- b»'], ['list', null, '«a\nb»'],
    ['check', 'x«»', '- [ ] x«»'], ['check', null, '- [x] x«»'], ['check', null, 'x«»'],
    ['box', '«a\nb»', '> «a\n> b»'], ['box', null, '«a\nb»'],
    ['center', 'Ti«»tel', '{mitte} Ti«»tel'], ['center', null, 'Ti«»tel'],
    ['arrow', 'A«»', 'A -> «»'], ['date', 'am «»', 'am {datum} «»'],
  ];
  const bad = [];
  let inputs = 0;
  for (const [t, before, after] of steps) {
    if (before !== null) await put(page, before);
    const n0 = await page.evaluate(() => window.__ed.inputs);
    await tap(t);
    const got = await state(page), n1 = await page.evaluate(() => window.__ed.inputs);
    if (got !== after) bad.push(`${t}: ${JSON.stringify(got)} wanted ${JSON.stringify(after)}`);
    if (n1 > n0) inputs++;
  }
  L.check(`every tool in the page: ${steps.length} taps on a selection, a caret, several lines, and off again`, !bad.length, bad.join(' | '));
  L.check('every tap fires the input event typing fires', inputs === steps.length, `${inputs} of ${steps.length}`);
  L.check('after a tap the focus is still in the text', (await page.evaluate(() => document.activeElement.id)) === 'pg-text');

  // undo
  await page.fill('#pg-text', 'ein Wort');
  await page.evaluate(() => document.getElementById('pg-text').setSelectionRange(4, 8));
  await tap('bold');
  await page.keyboard.press('Control+z');
  L.check('undo after a tool brings the text back (the browser\'s own undo)', (await val(page)) === 'ein Wort', await val(page));
  await page.keyboard.press('Control+Shift+z');
  L.check('and redo puts the mark back', (await val(page)) === 'ein **Wort**', await val(page));

  // LaTeX
  await page.evaluate(() => { window.__ed.format = 'latex'; window.__ed.editor.refresh(); });
  await put(page, 'ein «Wort»');
  await tap('bold');
  await tap('heading');
  L.check('LaTeX: the tools write what markup.js reads as LaTeX', (await state(page)) === '\\section{ein \\textbf{«Wort»}}', await state(page));

  // the list keys
  await page.evaluate(() => { window.__ed.format = 'markdown'; window.__ed.editor.refresh(); });
  await page.fill('#pg-text', '');
  await page.focus('#pg-text');
  await page.keyboard.type('- eins');
  await page.keyboard.press('Enter'); await page.keyboard.type('zwei');
  await page.keyboard.press('Tab'); await page.keyboard.press('Enter'); await page.keyboard.type('drei');
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.type('Ende');
  L.check('Enter goes on with the list, Tab and Shift+Tab move a level, Enter on an empty item ends it', (await val(page)) === '- eins\n  - zwei\n- drei\nEnde', JSON.stringify(await val(page)));
  await page.fill('#pg-text', '- [x] erledigt');
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  L.check('Enter after a ticked box opens an empty one', (await val(page)) === '- [x] erledigt\n- [ ] ');
  await page.keyboard.press('Shift+Enter');
  L.check('Shift+Enter is a plain line break', (await val(page)) === '- [x] erledigt\n- [ ] \n');
  await page.fill('#pg-text', 'Text');
  await page.keyboard.press('End'); await page.keyboard.press('Tab');
  L.check('Tab outside a list keeps its meaning (the focus moves on)', (await val(page)) === 'Text' && (await page.evaluate(() => document.activeElement.id)) !== 'pg-text');

  // Nur Text
  await page.evaluate(() => { window.__ed.format = 'text'; window.__ed.editor.refresh(); });
  L.check('"Nur Text": no tools', await page.isHidden('#pg-marks'));
  await page.fill('#pg-text', '- eins');
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  L.check('"Nur Text": Enter is a plain line break', (await val(page)) === '- eins\n');
  L.check('tools: no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ---------- the real app (needs the test model) ----------

async function app(browser, server) {
  const FIX = path.resolve(__dirname, '..', 'engine', 'fixtures');
  if (!fs.existsSync(path.join(FIX, 'model.json'))) { console.log('SKIP app part: tests/engine/fixtures has no model'); return; }
  const http = require('http');
  const BIN = fs.readFileSync(path.join(FIX, 'model.bin')), MAN = fs.readFileSync(path.join(FIX, 'model.json'), 'utf8');
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*', 'content-length': BIN.length }); res.end(BIN); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const REPO = `/${L.FAKE_USER}/handwriting-fable-model/resolve/main/`;
  const hf = async (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/api/whoami-v2') return { status: 200, body: { name: L.FAKE_USER } };
    if (!u.pathname.startsWith(REPO)) return null;
    const file = u.pathname.slice(REPO.length);
    if (file === 'model.json') return { status: 200, body: MAN };
    if (file === 'trained_on.json') return { status: 200, body: { date: '2026-11-20', lines: 100 } };
    if (file === 'model.bin') return { status: 302, headers: { location: `http://127.0.0.1:${srv.address().port}/m/model.bin` }, body: '' };
    return { status: 404 };
  };
  const { page, ctx, errors } = await L.newApp(browser, server, { hash: '#/schreiben', signedIn: true, hf });
  await page.waitForSelector('#gen-work:not([hidden])', { timeout: 30000 });
  L.check('app, Zettel: no editor, the composer as before', await page.isHidden('#pg-marks') && await page.isVisible('#gen-text') && (await page.evaluate(() => getComputedStyle(document.getElementById('gen')).display)) === 'flex');
  await page.click('.gen-modes [data-mode="seite"]');
  L.check('app, Seite at 1280x800: the text beside the pages, the tools shown', (await page.evaluate(() => getComputedStyle(document.getElementById('gen')).display)) === 'grid' && await page.isVisible('#pg-marks'));
  await page.fill('#pg-text', '\\section{Titel}');
  await page.waitForTimeout(100);
  await put(page, '\\section{Titel}\n«x»');
  await page.click('#pg-marks [data-tool="bold"]');
  L.check('app: a LaTeX text gets LaTeX marks', (await val(page)) === '\\section{Titel}\n\\textbf{x}', await val(page));
  await page.click('#pg-format');
  await page.click('#pg-format-panel [data-v="text"]');
  L.check('app: "Nur Text" hides the tools', await page.isHidden('#pg-marks'));
  await page.click('#pg-format-panel [data-v="auto"]');
  L.check('app: "Automatisch" brings them back', await page.isVisible('#pg-marks'));
  L.check('app: no page errors', errors.filter((e) => !/Failed to load resource|ERR_/.test(e)).length === 0, errors.join(' | '));
  await ctx.close();
  await new Promise((r) => { srv.closeAllConnections(); srv.close(r); });
}

(async () => {
  const server = await L.start();
  const browser = await L.launch();
  try {
    await pure();
    await wide(browser, server);
    await narrow(browser, server);
    await tools(browser, server);
    await app(browser, server);
  } catch (e) {
    console.error(e); L.check('test ran without exception', false, String(e));
  } finally {
    await browser.close(); await server.close();
  }
  process.exit(L.summary() ? 0 : 1);
})();
