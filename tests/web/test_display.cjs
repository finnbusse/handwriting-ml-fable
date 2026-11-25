// "Stift & Papier" and Vollbild on the capture screen: the look changes, the recording never does.
const L = require('./lib.cjs');

const COMBOS = [
  { pen: 'fineliner', width: 1, paper: 'linie', scheme: 'dark_on_light' },
  { pen: 'fueller', width: 3, paper: 'liniert', scheme: 'light_on_dark' },
  { pen: 'bleistift', width: 0.75, paper: 'kariert', scheme: 'dark_on_light' },
  { pen: 'fineliner', width: 2, paper: 'kariert', scheme: 'light_on_dark' },
  { pen: 'fueller', width: 1.5, paper: 'linie', scheme: 'dark_on_light' },
  { pen: 'bleistift', width: 3, paper: 'liniert', scheme: 'light_on_dark' },
];

/** Small joined-up writing: tall letters ~20 CSS px, x-height ~9 px, pressure that varies. */
async function writeSmall(page, cdp, text, opts = {}) {
  const rect = opts.rect || await L.canvasRect(page);
  const base = rect.top + Math.round(rect.height * 0.64) + 0.5;
  const p = L.pen(cdp);
  const unit = opts.unit || 11;
  let x = rect.left + (opts.x0 || 48);
  let wi = 0;
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const n = w.length;
    if (x + n * unit > rect.left + rect.width - 40) break;
    const pts = [];
    const steps = n * 12;
    for (let i = 0; i <= steps; i++) {
      const u = i / 12;
      const a = u * Math.PI * 2;
      const ch = w[Math.min(n - 1, Math.floor(u))];
      const tall = /[A-ZÄÖÜbdfhklt0-9]/.test(ch) ? 2.15 : /[gjpqy]/.test(ch) ? -1.2 : 1;
      const dy = tall > 0 ? (1 - Math.cos(a)) * unit * 0.42 * tall : -(1 - Math.cos(a)) * unit * 0.42 * -tall * 0.6;
      const ramp = Math.min(1, (i + 1) / 7);
      const pr = (0.22 + 0.34 * (0.5 + 0.5 * Math.sin(a * 0.5 + wi))) * ramp + 0.02;
      pts.push([x + u * unit + Math.sin(a) * unit * 0.3, base - dy, Math.round(pr * 1000) / 1000]);
    }
    await p.stroke(pts);
    if (/[iäöüj]/.test(w)) {
      const k = w.search(/[iäöüj]/);
      const dx = x + (k + 0.5) * unit, dyy = base - unit * 1.45;
      await p.stroke([[dx, dyy, 0.3], [dx + 0.6, dyy + 0.3, 0.4], [dx + 0.9, dyy + 0.5]]);
    }
    x += (n + 0.9) * unit;
    wi++;
  }
}

/** Same path the panel and the settings use: show it and remember it for the current writer. */
async function setLook(page, d) {
  await page.evaluate((o) => window.__hw.saveDisplay(o), d);
}

/** Whole screen, plus a close-up of the written part of the band (device pixels, to judge the ink). */
async function shots(page, name) {
  await L.shot(page, name);
  const r = await L.canvasRect(page);
  const base = r.top + Math.round(r.height * 0.64);
  await page.screenshot({ path: require('path').join(L.SHOTS, `${name}-zoom.png`), clip: { x: r.left + 20, y: base - 70, width: 460, height: 110 } });
}

const state = (page) => page.getAttribute('#cap', 'data-state');
const strokeCount = (page) => page.evaluate(() => window.__hw.capture.recorder.strokes.length);

/** Pixels of the live canvas, then a forced full redraw, compared inside the page. */
function pixelCompare(page) {
  return page.evaluate(() => {
    const c = document.getElementById('cap-canvas');
    const x = c.getContext('2d');
    const a = x.getImageData(0, 0, c.width, c.height).data.slice();
    window.__hw.capture.redraw();
    const b = x.getImageData(0, 0, c.width, c.height).data;
    let maxd = 0, nd = 0, inked = 0;
    const bg = [a[4], a[5], a[6]];
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
      if (d > maxd) maxd = d;
      if (d > 2) nd++;
      if (Math.abs(a[i] - bg[0]) + Math.abs(a[i + 1] - bg[1]) + Math.abs(a[i + 2] - bg[2]) > 90) inked++;
    }
    return { maxd, nd, inked, total: a.length / 4 };
  });
}

async function acceptLine(page) {
  await L.settle(page);
  await page.click('#cap-done');
  await page.waitForSelector('#cap[data-state="confirm"]');
  await page.waitForTimeout(120);
  await L.settle(page);
  const n = (await L.lines(page)).length;
  await page.click('#confirm-ok');
  await L.until(async () => (await L.lines(page)).length === n + 1);
  await page.waitForSelector('#cap[data-state="write"]');
  const all = await L.lines(page);
  return all.map((e) => e.record).sort((p, q) => (p.created_at < q.created_at ? -1 : 1))[all.length - 1];
}

async function fits(page) {
  return page.evaluate(() => {
    const vis = (el) => el && el.getClientRects().length > 0;
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    const tools = [...document.querySelectorAll('.cap-tools button')].filter(vis).map((b) => b.getBoundingClientRect());
    const sheet = r('#cap-sheet'), prompt = r('#cap-prompt');
    return {
      inner: [innerWidth, innerHeight], sheetH: Math.round(sheet.height), sheetBottom: sheet.bottom, promptTop: prompt.top,
      toolsInside: tools.every((t) => t.top >= 0 && t.bottom <= innerHeight && t.left >= 0 && t.right <= innerWidth),
      oneRow: tools.every((t) => Math.abs(t.top - tools[0].top) < 2),
      minTarget: Math.min(...tools.map((t) => Math.min(t.width, t.height))),
      scroll: document.documentElement.scrollHeight - innerHeight,
    };
  });
}

(async () => {
  const server = await L.start();
  const browser = await L.launch();
  try {
    const { page, cdp, errors, hfLog } = await L.newApp(browser, server, { writer: 'Finn' });
    const p = L.pen(cdp);

    // ---------- defaults, no automatic fullscreen ----------
    L.check('no automatic fullscreen on entering capture', await page.evaluate(() => !document.fullscreenElement));
    const d0 = await page.evaluate(() => window.__hw.capture.display);
    L.check('default look: Fineliner, 1 px, one line, dark on light', d0.pen === 'fineliner' && d0.width === 1 && d0.paper === 'linie' && d0.scheme === 'dark_on_light', JSON.stringify(d0));
    L.check('"Stift & Papier" and "Vollbild" buttons sit in the toolbar outside the canvas',
      (await page.isVisible('.cap-tools #cap-look')) && (await page.isVisible('.cap-tools #cap-fs'))
      && (await page.textContent('#cap-fs-label')) === 'Vollbild' && (await page.textContent('#cap-look')).includes('Stift & Papier'));

    // ---------- fits without fullscreen ----------
    const f800 = await fits(page);
    L.check('1280x800 without fullscreen: prompt, toolbar and band fit, no scrolling', f800.toolsInside && f800.oneRow && f800.sheetBottom <= f800.inner[1] && f800.scroll <= 0 && f800.minTarget >= 48, JSON.stringify(f800));
    await page.setViewportSize({ width: 1280, height: 680 });     // address bar + status bar visible
    await page.waitForTimeout(250);
    const f680 = await fits(page);
    L.check('1280x800 tablet with the address bar (1280x680 window): everything fits, band >= 300 px', f680.toolsInside && f680.oneRow && f680.sheetBottom <= 680 && f680.scroll <= 0 && f680.sheetH >= 300, JSON.stringify(f680));
    await L.shot(page, 'display-00-browser-1280x680');
    // Writing a line there never pauses: fullscreen being off is not a layout change.
    await writeSmall(page, cdp, 'ohne Vollbild');
    await page.waitForTimeout(300);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(200);
    L.check('writing without fullscreen does not pause', (await state(page)) === 'write' && (await strokeCount(page)) >= 2);
    await L.settle(page);
    await page.click('#cap-clear');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(250);

    // ---------- fullscreen button ----------
    await L.settle(page);
    await page.click('#cap-fs');
    await page.waitForTimeout(300);
    L.check('"Vollbild" enters fullscreen and then reads "Vollbild beenden"', (await page.evaluate(() => !!document.fullscreenElement))
      && (await page.textContent('#cap-fs-label')) === 'Vollbild beenden' && (await page.getAttribute('#cap-fs', 'aria-pressed')) === 'true');
    await L.settle(page);
    await page.click('#cap-fs');
    await page.waitForTimeout(300);
    L.check('"Vollbild beenden" leaves fullscreen', (await page.evaluate(() => !document.fullscreenElement)) && (await page.textContent('#cap-fs-label')) === 'Vollbild');
    let rect = await L.canvasRect(page);
    await p.stroke(L.glyph(rect.left + 100, rect.top + rect.height * 0.64, 8));
    await L.settle(page);
    await page.click('#cap-fs');
    await page.waitForTimeout(250);
    L.check('"Vollbild" during a line keeps the line and asks to finish it first', (await state(page)) === 'write' && (await strokeCount(page)) === 1
      && (await page.evaluate(() => !document.fullscreenElement)) && (await page.textContent('#cap-hint')).includes('fertig schreiben oder löschen'));
    await cdp.send('Runtime.evaluate', { expression: 'document.documentElement.requestFullscreen()', userGesture: true, awaitPromise: true });
    await page.waitForTimeout(300);
    L.check('entering fullscreen mid-line still pauses', (await state(page)) === 'pause');
    await L.settle(page);
    await page.click('#pause-ok');
    await page.waitForTimeout(150);
    rect = await L.canvasRect(page);
    await p.stroke(L.glyph(rect.left + 100, rect.top + rect.height * 0.64, 8));
    await page.evaluate(() => document.exitFullscreen());
    await page.waitForTimeout(300);
    L.check('leaving fullscreen mid-line still pauses', (await state(page)) === 'pause');
    await L.settle(page);
    await page.click('#pause-ok');
    await page.waitForTimeout(150);

    // ---------- the panel ----------
    await L.settle(page);
    await page.click('#cap-look');
    await page.waitForSelector('#dlg-look[open]');
    await page.waitForTimeout(100);
    L.check('panel offers every option as buttons (3 pens, 5 widths, 3 papers, 2 schemes), no text input',
      (await page.$$('#look-controls .seg[data-k="pen"]')).length === 3 && (await page.$$('#look-controls .seg[data-k="width"]')).length === 5
      && (await page.$$('#look-controls .seg[data-k="paper"]')).length === 3 && (await page.$$('#look-controls .seg[data-k="scheme"]')).length === 2
      && (await page.$$('#v-erfassen input, #v-erfassen textarea, #v-erfassen [contenteditable]')).length === 0);
    const segMin = await page.evaluate(() => Math.min(...[...document.querySelectorAll('#look-controls .seg')].map((b) => Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height))));
    L.check('panel targets are at least 48 px', segMin >= 48, String(segMin));
    L.check('panel shows a live sample', await page.evaluate(() => { const c = document.querySelector('#look-controls canvas'); return c.width > 200 && c.height > 100; }));
    L.check('the current choice is marked', (await page.getAttribute('#look-controls .seg[data-k="pen"][data-v="fineliner"]', 'aria-checked')) === 'true');
    await L.shot(page, 'display-10-panel');
    await page.waitForTimeout(320);     // the opening tap's double-activation guard
    for (const [k, v] of [['pen', 'fueller'], ['width', '1.5'], ['paper', 'liniert']]) {
      await page.click(`#look-controls .seg[data-k="${k}"][data-v="${v}"]`);
      await page.waitForTimeout(320);
    }
    const dUi = await page.evaluate(() => window.__hw.capture.display);
    L.check('panel choices apply at once', dUi.pen === 'fueller' && dUi.width === 1.5 && dUi.paper === 'liniert', JSON.stringify(dUi));
    L.check('panel marks the new choice', (await page.getAttribute('#look-controls .seg[data-k="pen"][data-v="fueller"]', 'aria-checked')) === 'true'
      && (await page.getAttribute('#look-controls .seg[data-k="pen"][data-v="fineliner"]', 'aria-checked')) === 'false');
    await L.shot(page, 'display-11-panel-fueller-liniert');
    await page.click('#look-close');
    await page.waitForTimeout(100);
    L.check('"Schließen" closes the panel', !(await page.isVisible('#dlg-look')));

    // ---------- the key property: samples are bit-identical whatever the look ----------
    rect = await L.canvasRect(page);
    // An independent log of what the browser delivered (timestamps), next to the recorder.
    await page.evaluate(() => {
      const cv = document.getElementById('cap-canvas');
      window.__evlog = [];
      cv.addEventListener('pointerdown', (e) => window.__evlog.push(e.timeStamp), true);
      cv.addEventListener('pointerrawupdate', (e) => { for (const c of e.getCoalescedEvents()) window.__evlog.push(c.timeStamp); }, true);
    });
    const recs = [], logs = [];
    for (const d of COMBOS) {
      await setLook(page, d);
      const r = await L.canvasRect(page);
      if (JSON.stringify(r) !== JSON.stringify(rect)) L.check(`layout unchanged for ${JSON.stringify(d)}`, false, JSON.stringify([r, rect]));
      await page.evaluate(() => { window.__evlog = []; });
      await writeSmall(page, cdp, 'Kaffee mit Milch um 9', { rect });
      logs.push(await page.evaluate(() => window.__evlog.slice()));
      recs.push(await acceptLine(page));
    }
    // t is the browser's event.timeStamp, which Chrome clamps to 0.1 ms with a per-interval
    // jitter: two lines written at different moments can differ there by 0.1 ms whatever the
    // look. Every other field must be bit-identical, and t must be exactly what was delivered.
    const strip = (rec) => JSON.stringify(rec.strokes.map((s) => ({ x: s.x, y: s.y, p: s.p, tiltX: s.tiltX, tiltY: s.tiltY, n: s.t.length, buttons: s.buttons, end: s.end, ux: s.up && s.up.x, uy: s.up && s.up.y })));
    const r2 = (v) => Math.round(v * 1e2) / 1e2;
    const tOk = recs.map((x, i) => {
      const got = x.strokes.flatMap((s) => s.t), log = logs[i];
      const want = log.map((ts) => r2(ts - log[0]));
      return got.length === want.length && got.every((t, j) => t === want[j]);
    });
    L.check('recorded t is exactly the delivered event.timeStamp (minus the first pen-down) in every look', tOk.every(Boolean), tOk.join(' '));
    const tMax = Math.max(...recs.map((x) => Math.max(...x.strokes.flatMap((s, i) => s.t.map((t, j) => Math.abs(t - recs[0].strokes[i].t[j]))))));
    L.check('… and differs between the lines only by the browser clamp (two 0.1 ms steps at most)', tMax <= 0.2 + 1e-9, String(tMax));
    const ref = strip(recs[0]);
    const firstDiff = (a, b) => {
      for (let i = 0; i < Math.max(a.strokes.length, b.strokes.length); i++) {
        const s = a.strokes[i], q = b.strokes[i];
        if (!s || !q) return `stroke ${i} missing`;
        for (const k of ['x', 'y', 't', 'p', 'tiltX', 'tiltY']) {
          if (k === 't') continue;
          if (s[k].length !== q[k].length) return `s${i}.${k} length ${s[k].length} vs ${q[k].length}`;
          const j = s[k].findIndex((v, n) => v !== q[k][n]);
          if (j >= 0) return `s${i}.${k}[${j}] ${s[k][j]} vs ${q[k][j]}`;
        }
        if (JSON.stringify(s.up) !== JSON.stringify(q.up)) return `s${i}.up ${JSON.stringify(s.up)} vs ${JSON.stringify(q.up)}`;
      }
      return 'other fields';
    };
    L.check('recorded samples (x, y, pressure, tilt, count, order, pen-up) are bit-identical across pens, widths, papers and schemes', recs.every((x) => strip(x) === ref),
      recs.map((x, i) => (strip(x) === ref ? `${i}:same` : `${i}: ${firstDiff(recs[0], x)}`)).join('; '));
    L.check('… and the same canvas geometry and baseline', recs.every((x) => JSON.stringify(x.coord.canvas_css) === JSON.stringify(recs[0].coord.canvas_css) && x.guides.baseline_y === recs[0].guides.baseline_y));
    let metaOk = true, metaDetail = '';
    recs.forEach((x, i) => {
      const d = COMBOS[i], g = x.guides;
      const ys = g.extra_lines_y;
      const good = g.pen === d.pen && g.ink_width_css === d.width && g.paper === d.paper && g.scheme === d.scheme
        && g.pressure_width === (d.pen === 'fueller')
        && (d.paper === 'linie' ? ys.length === 0 && !('spacing_css' in g) : ys.length >= 4 && g.spacing_css === 28
            && ys.every((y) => Math.abs(((y - g.baseline_y) / 28) - Math.round((y - g.baseline_y) / 28)) < 1e-9) && !ys.includes(g.baseline_y))
        && (d.paper === 'kariert' ? Array.isArray(g.extra_lines_x) && g.extra_lines_x.length > 20 : !('extra_lines_x' in g))
        && !('display_changed' in g);
      if (!good) { metaOk = false; metaDetail += `${i}: ${JSON.stringify(g)}; `; }
    });
    L.check('guides report pen, width, paper, spacing, scheme and the extra lines drawn', metaOk, metaDetail);
    const serr = recs.flatMap((x) => L.schemaErrors(x));
    L.check('every record satisfies the schema', serr.length === 0, serr.join('; '));
    const vErr = await page.evaluate(async (rs) => { const m = await import('./js/capture/hwline.js'); return rs.flatMap((r) => m.validate(r)); }, recs);
    L.check('app validator agrees', vErr.length === 0, vErr.join('; '));
    const vBad = await page.evaluate(async (r) => {
      const m = await import('./js/capture/hwline.js');
      const bad = JSON.parse(JSON.stringify(r)); bad.guides.pen = 'kugelschreiber'; bad.guides.extra_lines_y = ['x'];
      return m.validate(bad);
    }, recs[0]);
    L.check('app validator refuses an unknown pen and non-numeric lines', vBad.length === 2, vBad.join('; '));

    // ---------- incremental drawing == full redraw, for each pen ----------
    const looks = {};
    for (const d of [
      { pen: 'fineliner', width: 1, paper: 'linie', scheme: 'dark_on_light' },
      { pen: 'fueller', width: 2, paper: 'liniert', scheme: 'dark_on_light' },
      { pen: 'bleistift', width: 1.5, paper: 'kariert', scheme: 'dark_on_light' },
      { pen: 'bleistift', width: 1, paper: 'linie', scheme: 'light_on_dark' },
      { pen: 'fueller', width: 0.75, paper: 'kariert', scheme: 'light_on_dark' },
    ]) {
      await setLook(page, d);
      await writeSmall(page, cdp, 'Brot, Eier und Äpfel holen');
      await page.waitForTimeout(100);
      const cmp = await pixelCompare(page);
      looks[`${d.pen}-${d.scheme}`] = cmp;
      L.check(`incremental drawing equals full redraw: ${d.pen} ${d.width} px ${d.paper} ${d.scheme}`,
        cmp.inked > 1500 && cmp.nd <= cmp.inked * 0.002 && cmp.maxd <= (cmp.nd ? 24 : 0), JSON.stringify(cmp));
      await L.settle(page);
      await page.click('#cap-clear');
    }

    // ---------- changing the look mid-line keeps the strokes ----------
    await setLook(page, { pen: 'fineliner', width: 1, paper: 'linie', scheme: 'dark_on_light' });
    await writeSmall(page, cdp, 'Termin am Montag');
    const nBefore = await strokeCount(page);
    await L.settle(page);
    await page.click('#cap-look');
    await page.waitForSelector('#dlg-look[open]');
    await page.waitForTimeout(320);     // the opening tap's double-activation guard
    for (const [k, v] of [['pen', 'bleistift'], ['paper', 'kariert'], ['scheme', 'light_on_dark']]) {
      await page.click(`#look-controls .seg[data-k="${k}"][data-v="${v}"]`);
      await page.waitForTimeout(320);
    }
    await page.click('#look-close');
    await page.waitForTimeout(150);
    const mid = await page.evaluate(() => {
      const c = document.getElementById('cap-canvas'); const d = c.getContext('2d').getImageData(4, 4, 1, 1).data;
      return { n: window.__hw.capture.recorder.strokes.length, px: [d[0], d[1], d[2]], scheme: document.getElementById('cap-sheet').dataset.scheme };
    });
    L.check('changing the look mid-line keeps every stroke and redraws them in the new look', mid.n === nBefore && nBefore > 0 && mid.px[0] < 60 && mid.scheme === 'light_on_dark', JSON.stringify(mid));
    const cmpMid = await pixelCompare(page);
    L.check('… and the redrawn line equals another full redraw', cmpMid.nd === 0 && cmpMid.inked > 500, JSON.stringify(cmpMid));
    await L.shot(page, 'display-12-changed-mid-line');
    await L.settle(page);
    await page.click('#cap-done');
    await page.waitForSelector('#cap[data-state="confirm"]');
    await page.waitForTimeout(150);
    const conf = await page.evaluate(() => {
      const c = document.getElementById('confirm-canvas'); const d = c.getContext('2d').getImageData(2, 2, 1, 1).data;
      return [d[0], d[1], d[2]];
    });
    L.check('the confirm screen shows the ink on the same dark sheet', conf[0] < 60 && conf[2] < 70, JSON.stringify(conf));
    await L.shot(page, 'display-13-confirm-dark');
    await L.settle(page);
    await page.click('#confirm-ok');
    await L.until(async () => (await L.lines(page)).length === COMBOS.length + 1);
    await page.waitForSelector('#cap[data-state="write"]');
    const rMid = (await L.lines(page)).map((e) => e.record).sort((a, b) => (a.created_at < b.created_at ? -1 : 1)).pop();
    L.check('a look changed mid-line is reported (final look + display_changed)', rMid.guides.pen === 'bleistift' && rMid.guides.paper === 'kariert'
      && rMid.guides.scheme === 'light_on_dark' && rMid.guides.display_changed === true && rMid.strokes.length === nBefore && L.schemaErrors(rMid).length === 0, JSON.stringify(rMid.guides));

    // ---------- contrast of the sheets ----------
    const con = await page.evaluate(async () => {
      const m = await import('./js/capture/ink.js');
      const out = {};
      for (const sc of m.SCHEMES) {
        const c = m.schemeColors(sc);
        out[sc] = { ink: m.contrast(c.ink, c.paper), pencilMid: m.contrast(m.pencilColor(c, 3), c.paper), pencilLight: m.contrast(m.pencilColor(c, 0), c.paper),
          rule: m.contrast(c.rule, c.paper), faint: m.contrast(c.faint, c.paper) };
      }
      const hint = getComputedStyle(document.getElementById('cap-hint')).color.match(/\d+/g).map(Number);
      const bg = getComputedStyle(document.getElementById('cap-sheet')).backgroundColor.match(/\d+/g).map(Number);
      const hex = (a) => '#' + a.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('');
      out.hint = m.contrast(hex(hint), hex(bg));
      out.sheetBg = hex(bg); out.darkPaper = m.schemeColors('light_on_dark').paper.toLowerCase();
      return out;
    });
    const dk = con.light_on_dark, lt = con.dark_on_light;
    L.check('dark sheet: ink contrast >= 7:1, pencil >= 4.5:1 (light pressure >= 3:1)', dk.ink >= 7 && dk.pencilMid >= 4.5 && dk.pencilLight >= 3, JSON.stringify(dk));
    L.check('light sheet: ink contrast >= 7:1, pencil >= 4.5:1 (light pressure >= 3:1)', lt.ink >= 7 && lt.pencilMid >= 4.5 && lt.pencilLight >= 3, JSON.stringify(lt));
    L.check('guide lines stay faint on both sheets (baseline < 3:1, extra lines fainter)', [dk, lt].every((s) => s.rule > 1.4 && s.rule < 3 && s.faint > 1.1 && s.faint < s.rule), JSON.stringify([dk, lt]));
    L.check('dark sheet: the DOM sheet matches the canvas paper and its hint is readable (>= 4.5:1)', con.sheetBg === con.darkPaper && con.hint >= 4.5, JSON.stringify(con));

    // ---------- screenshots: paper x scheme, and each pen ----------
    const text = 'Einkaufen: Milch, Brot und 3 Äpfel';
    for (const scheme of ['dark_on_light', 'light_on_dark']) {
      for (const paper of ['linie', 'liniert', 'kariert']) {
        await setLook(page, { pen: 'fineliner', width: 1, paper, scheme });
        await writeSmall(page, cdp, text);
        await page.waitForTimeout(80);
        await shots(page, `display-paper-${paper}-${scheme}`);
        await L.settle(page);
        await page.click('#cap-clear');
      }
    }
    for (const pen of ['fineliner', 'fueller', 'bleistift']) {
      for (const scheme of ['dark_on_light', 'light_on_dark']) {
        await setLook(page, { pen, width: pen === 'fineliner' ? 1 : 1.5, paper: 'liniert', scheme });
        await writeSmall(page, cdp, text);
        await page.waitForTimeout(80);
        await shots(page, `display-pen-${pen}-${scheme}`);
        await L.settle(page);
        await page.click('#cap-clear');
      }
    }
    for (const width of [0.75, 3]) {
      await setLook(page, { pen: 'fueller', width, paper: 'linie', scheme: 'dark_on_light' });
      await writeSmall(page, cdp, text);
      await page.waitForTimeout(80);
      await shots(page, `display-width-${String(width).replace('.', '_')}`);
      await L.settle(page);
      await page.click('#cap-clear');
    }

    // ---------- per writer, across reload, and in Einstellungen ----------
    const finnLook = { pen: 'bleistift', width: 2, paper: 'liniert', scheme: 'light_on_dark' };
    await setLook(page, finnLook);
    await L.switchWriter(page, 'Lena');
    const lenaStart = await page.evaluate(() => window.__hw.capture.display);
    L.check('another writer starts with the default look', lenaStart.pen === 'fineliner' && lenaStart.width === 1 && lenaStart.paper === 'linie' && lenaStart.scheme === 'dark_on_light', JSON.stringify(lenaStart));
    // Lena chooses hers in Einstellungen.
    await page.click('a[data-route="einstellungen"]');
    await page.waitForSelector('#v-einstellungen:not([hidden])');
    await page.waitForTimeout(150);
    L.check('Einstellungen show "Stift & Papier" for the current writer', (await page.isVisible('#look-settings .seg[data-k="pen"]')) && (await page.textContent('#look-for')).includes('Lena'));
    for (const [k, v] of [['pen', 'fueller'], ['width', '0.75'], ['paper', 'kariert']]) {
      await page.click(`#look-settings .seg[data-k="${k}"][data-v="${v}"]`);
      await page.waitForTimeout(100);
    }
    await page.evaluate(() => { const v = document.getElementById('v-einstellungen'); v.scrollTop = 0; });
    await L.shot(page, 'display-20-settings');
    L.check('Einstellungen mark the choice', (await page.getAttribute('#look-settings .seg[data-k="paper"][data-v="kariert"]', 'aria-checked')) === 'true');
    await page.click('a[data-route="erfassen"]');
    await page.waitForSelector('#cap[data-state="write"]');
    const lenaNow = await page.evaluate(() => window.__hw.capture.display);
    L.check('a choice in Einstellungen shows on the capture screen', lenaNow.pen === 'fueller' && lenaNow.width === 0.75 && lenaNow.paper === 'kariert', JSON.stringify(lenaNow));
    await page.reload();
    await page.waitForFunction(() => window.__hwReady);
    await page.evaluate(() => window.__hwReady);
    await page.waitForSelector('#cap[data-state="write"]');
    const afterReload = await page.evaluate(() => ({ d: window.__hw.capture.display, w: window.__hw.app.writer.id, scheme: document.getElementById('cap-sheet').dataset.scheme }));
    L.check('the look survives a reload', afterReload.w === 'lena' && afterReload.d.pen === 'fueller' && afterReload.d.width === 0.75 && afterReload.d.paper === 'kariert' && afterReload.scheme === 'dark_on_light', JSON.stringify(afterReload));
    await L.switchWriter(page, 'Finn');
    const finnBack = await page.evaluate(() => ({ d: window.__hw.capture.display, scheme: document.getElementById('cap-sheet').dataset.scheme }));
    L.check('each writer keeps their own look', JSON.stringify(finnBack.d) === JSON.stringify(finnLook) && finnBack.scheme === 'light_on_dark', JSON.stringify(finnBack));

    L.check('no request to Hugging Face while signed out', hfLog.length === 0, hfLog.map((h) => h.url).join(', '));
    L.check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (e) {
    console.error(e); L.check('test ran without exception', false, String(e));
  } finally {
    await browser.close(); await server.close();
  }
  process.exit(L.summary() ? 0 : 1);
})();
