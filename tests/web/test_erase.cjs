// Radieren ("back to here"), Rückgängig / Wiederholen over writes, erases and Löschen:
// removed strokes never reach the record, what stays is untouched and in writing order.
const L = require('./lib.cjs');
const R = require('./replay.cjs');

const LOOK = { pen: 'bleistift', width: 2, paper: 'kariert', scheme: 'light_on_dark' };
const nStrokes = (page) => page.evaluate(() => window.__hw.capture.recorder.strokes.length);
const mode = (page) => page.getAttribute('#cap', 'data-mode');
const strokesJson = (page) => page.evaluate(() => JSON.stringify(window.__hw.capture.recorder.strokes.map((s) => [s.x, s.y, s.t, s.p, s.tiltX, s.tiltY, s.end, s.up])));
const recState = (page) => page.evaluate(() => { const r = window.__hw.capture.recorder; return JSON.stringify({ a: r.anomalies, tb: r.timeBase, n: r.strokes.length, raw: r.rawSamples }); });
const toastText = (page) => page.evaluate(() => { const t = document.getElementById('toast'); return t && !t.hidden ? t.textContent : ''; });
const toolbarBox = (page) => page.evaluate(() => { const b = document.querySelector('.cap-tools').getBoundingClientRect(); return `${b.top},${b.height}`; });
const quiet = (page) => page.waitForTimeout(400);

/** Pen contact at canvas coordinates (a tap, or a slide through several points). */
async function penOnSheet(page, cdp, pts, extra = {}) {
  const r = await L.canvasRect(page);
  const P = L.pen(cdp);
  const abs = pts.map(([x, y]) => [r.left + x, r.top + y]);
  if (abs.length === 1) abs.push(abs[0]);
  await P.stroke(abs.concat([abs[abs.length - 1]]), extra);
}

/** Count reddish pixels of the erase colour inside / outside boxes (device px of #cap-canvas). */
function redPixels(page, boxes) {
  return page.evaluate((bb) => {
    const c = document.getElementById('cap-canvas'); const d = devicePixelRatio;
    const img = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let inside = 0, outside = 0;
    const inBox = (x, y) => bb.some((b) => x >= (b[0] - 4) * d && x <= (b[2] + 4) * d && y >= (b[1] - 4) * d && y <= (b[3] + 4) * d);
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const o = (y * c.width + x) * 4, rr = img[o], g = img[o + 1], b = img[o + 2];
      if (rr > 150 && rr - g > 60 && rr - b > 60) { if (inBox(x, y)) inside++; else outside++; }
    }
    return { inside, outside };
  }, boxes);
}

const bboxes = (strokes, idx) => idx.map((i) => { const s = strokes[i]; return [Math.min(...s.x), Math.min(...s.y), Math.max(...s.x), Math.max(...s.y)]; });

(async () => {
  const server = await L.start();
  const browser = await L.launch();
  const line = R.longLine(40);
  try {
    const { page, cdp, errors } = await L.newApp(browser, server, { viewport: { width: 1280, height: 680 }, dsf: 2.25, colorScheme: 'dark', writer: 'finn', init: R.instrumentCanvas });
    await page.evaluate((o) => window.__hw.saveDisplay(o), LOOK);
    await page.waitForTimeout(200);

    // ---------- buttons ----------
    const sizes = await page.evaluate(() => ['cap-undo', 'cap-again', 'cap-erase'].map((id) => { const b = document.getElementById(id).getBoundingClientRect(); return [id, b.width, b.height]; }));
    L.check('Rückgängig, Wiederholen and Radieren are at least 48x48', sizes.every(([, w, h]) => w >= 48 && h >= 48), JSON.stringify(sizes));
    L.check('nothing written: Rückgängig, Wiederholen and Radieren are off', await page.evaluate(() => ['cap-undo', 'cap-again', 'cap-erase'].every((id) => document.getElementById(id).disabled)));
    L.check('Wiederholen has a German label for screen readers', (await page.getAttribute('#cap-again', 'aria-label')) === 'Wiederholen');

    // ---------- a real-sized line ----------
    const place = await R.placeLine(page, line);
    // Only the part that fits on this sheet.
    const fit = line.strokes.findIndex((s) => Math.max(...s.x) + place.dx > place.canvasW - 30);
    const sub = { strokes: line.strokes.slice(0, fit < 0 ? line.strokes.length : fit), baseline: line.baseline };
    const n0 = await R.replay(page, sub, place);
    L.check(`replayed ${line.source}: ${n0} strokes`, n0 === sub.strokes.length && n0 >= 20, String(n0));
    await quiet(page);
    const orig = await strokesJson(page);
    const origStrokes = await page.evaluate(() => window.__hw.capture.recorder.strokes.map((s) => ({ x: s.x, y: s.y, t: s.t })));
    const stateBefore = await recState(page);
    const tb0 = await toolbarBox(page);
    const cr0 = JSON.stringify(await L.canvasRect(page));

    // ---------- eraser mode ----------
    await R.penTap(page, cdp, '#cap-erase');
    L.check('Radieren opens the eraser bar', (await mode(page)) === 'erase' && await page.isVisible('#erase-cancel') && await page.isVisible('#erase-ok') && !(await page.isVisible('#cap-done')) && !(await page.isVisible('#cap-undo')));
    L.check('eraser bar: Entfernen is off until something is chosen', await page.isDisabled('#erase-ok'));
    L.check('eraser bar: start text', (await page.textContent('#erase-status')) === 'Tippe auf die Stelle, ab der alles weg soll.');
    L.check('the first time a note says new writing goes only at the end', (await toastText(page)).includes('Neu schreiben geht nur am Ende'));
    const tb1 = await toolbarBox(page), cr1 = JSON.stringify(await L.canvasRect(page));
    L.check('the bar swap keeps toolbar row and sheet in place (no pause)', tb1 === tb0 && cr1 === cr0 && (await page.getAttribute('#cap', 'data-state')) === 'write', `${tb0} -> ${tb1}; ${cr0} -> ${cr1}`);
    const eb = await page.evaluate(() => ['erase-cancel', 'erase-ok'].map((id) => { const b = document.getElementById(id).getBoundingClientRect(); return [b.width, b.height]; }));
    L.check('Abbrechen and Entfernen are at least 48x48', eb.every(([w, h]) => w >= 48 && h >= 48), JSON.stringify(eb));

    // Nothing there: a tap on blank paper.
    await penOnSheet(page, cdp, [[place.canvasW - 15, 20]]);
    L.check('a tap on blank paper says so, says how to write, and chooses nothing', (await page.textContent('#erase-status')) === 'Hier ist nichts. Tippe auf die Schrift. Zum Schreiben: Abbrechen.'
      && await page.isDisabled('#erase-ok') && (await nStrokes(page)) === n0 && (await mode(page)) === 'erase');

    // Choose stroke k.
    let k = Math.floor(n0 / 2), pt = null;
    for (; k < n0 - 2 && !(pt = R.lonelyPoint(origStrokes, k)); k++);
    await page.evaluate(() => window.__resetOps());
    await penOnSheet(page, cdp, [pt]);
    const er = await page.evaluate(() => window.__hw.capture.eraser);
    L.check('a tap on a stroke chooses it and everything after it', er && er.k === k && er.set.length === n0 - k && er.set[0] === k, JSON.stringify(er));
    L.check('the bar says how many strokes go', (await page.textContent('#erase-status')) === `Ab hier wird alles entfernt (${n0 - k} Striche).`);
    const ops = await page.evaluate(() => Object.assign({}, window.__ops));
    L.check('the preview is put on the sheet in one step', ops.drawImage >= 1 && ops.fillRect === 0 && ops.stroke === 0, JSON.stringify(ops));
    const red = await redPixels(page, bboxes(origStrokes, er.set));
    L.check('red only on the strokes that go', red.inside > 50 && red.outside === 0, JSON.stringify(red));
    L.check('an eraser contact records nothing (no stroke, no anomaly, same time base)', (await recState(page)) === stateBefore && (await strokesJson(page)) === orig);

    // Sliding moves the cut: down on stroke k, slide onto stroke k2 (nothing else in between).
    let k2 = k + 1, pt2 = null;
    for (; k2 < n0 - 1 && !(pt2 = R.lonelyPoint(origStrokes, k2)); k2++);
    const via = [];
    for (let i = 1; i <= 6; i++) via.push([pt[0] + ((pt2[0] - pt[0]) * i) / 6, pt[1] + ((pt2[1] - pt[1]) * i) / 6]);
    await penOnSheet(page, cdp, [pt, ...via]);
    const er2 = await page.evaluate(() => window.__hw.capture.eraser);
    L.check('sliding the pen onto a later stroke moves the cut there', er2.k === k2 && er2.set.length === n0 - k2, JSON.stringify([k, k2, er2.k]));
    // A slide that ends on blank paper keeps the last stroke it touched.
    await penOnSheet(page, cdp, [pt, [pt[0], 4], [pt[0] + 3, 3]]);
    L.check('a slide off the writing keeps the cut where it was last', (await page.evaluate(() => window.__hw.capture.eraser.k)) === k);
    await penOnSheet(page, cdp, [pt]);
    L.check('back on the first stroke', (await page.evaluate(() => window.__hw.capture.eraser.k)) === k);

    // A finger on the sheet does nothing in eraser mode either.
    const pfinger = L.pen(cdp);
    const cr = await L.canvasRect(page);
    await pfinger.touchTap(cr.left + origStrokes[n0 - 1].x[0], cr.top + origStrokes[n0 - 1].y[0]);
    L.check('a finger touch does not move the cut', (await page.evaluate(() => window.__hw.capture.eraser.k)) === k);

    // Entfernen right after the eraser lift is ignored (a resting pen or palm).
    await penOnSheet(page, cdp, [pt]);
    await page.click('#erase-ok', { delay: 0 });
    L.check('Entfernen within 300 ms after the eraser lifted is ignored', (await nStrokes(page)) === n0 && (await mode(page)) === 'erase');

    // Abbrechen changes nothing.
    await quiet(page);
    await R.penTap(page, cdp, '#erase-cancel');
    L.check('Abbrechen: back to writing, nothing changed', (await mode(page)) === null && (await strokesJson(page)) === orig);
    const cmp0 = await page.evaluate(() => { const a = window.__pixels(); window.__hw.capture.redraw(); const b = window.__pixels(); let n = 0; for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) n++; return n; });
    L.check('… and the sheet shows the line without any red', cmp0 === 0, String(cmp0));

    // Erase for real.
    await quiet(page);
    await R.penTap(page, cdp, '#cap-erase');
    await penOnSheet(page, cdp, [pt]);
    await quiet(page);
    await page.evaluate(() => window.__resetOps());
    await R.penTap(page, cdp, '#erase-ok');
    const opsE = await page.evaluate(() => Object.assign({}, window.__ops));
    const prefix = JSON.stringify(JSON.parse(orig).slice(0, k));
    L.check('Entfernen removes the chosen stroke and everything after it', (await nStrokes(page)) === k && (await strokesJson(page)) === prefix);
    L.check('… shows it in one step', opsE.drawImage === 1 && opsE.fillRect === 0 && opsE.stroke === 0, JSON.stringify(opsE));
    L.check('… and says how to get it back', (await toastText(page)) === 'Entfernt. „Rückgängig“ holt es zurück.');
    const cmp1 = await page.evaluate(() => { const a = window.__pixels(); window.__hw.capture.redraw(); const b = window.__pixels(); let n = 0; for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) n++; return n; });
    L.check('the sheet after Entfernen equals a full redraw of what stays', cmp1 === 0, String(cmp1));

    // Write on: new strokes go at the end.
    await quiet(page);
    const lastKept = origStrokes[k - 1];
    const xr = Math.max(...lastKept.x) + 14, yb = await page.evaluate(() => window.__hw.capture.guides.baseline_y);
    await penOnSheet(page, cdp, [[xr, yb - 3], [xr + 3, yb - 8], [xr + 6, yb - 2], [xr + 8, yb]]);
    await penOnSheet(page, cdp, [[xr + 12, yb - 3], [xr + 15, yb - 9], [xr + 18, yb - 1], [xr + 19, yb]]);
    await quiet(page);
    L.check('writing after an erase adds at the end', (await nStrokes(page)) === k + 2 && (await page.evaluate(() => {
      const ss = window.__hw.capture.recorder.strokes; const ts = ss.flatMap((s) => s.t); return ts.every((t, i) => i === 0 || t > ts[i - 1]);
    })));
    const afterWrite = await strokesJson(page);

    // Rückgängig x3: the two new strokes, then the erase comes back.
    for (let i = 0; i < 3; i++) { await R.penTap(page, cdp, '#cap-undo'); await page.waitForTimeout(90); }
    L.check('Rückgängig takes an erase back: the whole line is there again, unchanged', (await strokesJson(page)) === orig);
    const cmp2 = await page.evaluate(() => { const a = window.__pixels(); window.__hw.capture.redraw(); const b = window.__pixels(); let n = 0; for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) n++; return n; });
    L.check('… and the sheet equals a full redraw', cmp2 === 0, String(cmp2));
    L.check('Wiederholen is on after Rückgängig', !(await page.isDisabled('#cap-again')));
    for (let i = 0; i < 3; i++) { await R.penTap(page, cdp, '#cap-again'); await page.waitForTimeout(90); }
    L.check('Wiederholen x3 does the erase and the two strokes again', (await strokesJson(page)) === afterWrite);
    // Undoing an erase reuses the picture from before it: one drawImage plus a few strokes.
    for (let i = 0; i < 2; i++) { await R.penTap(page, cdp, '#cap-undo'); await page.waitForTimeout(90); }
    await page.evaluate(() => window.__resetOps());
    await R.penTap(page, cdp, '#cap-undo');
    const undoErase = await page.evaluate(() => window.__opsOff.stroke);
    const okUndo = (await strokesJson(page)) === orig;
    await page.evaluate(() => { window.__resetOps(); window.__hw.capture.redraw(); });
    const fullOps = await page.evaluate(() => window.__opsOff.stroke);
    L.check('undoing an erase does not draw the whole line again', okUndo && undoErase * 3 < fullOps, `${undoErase} vs full ${fullOps}`);
    for (let i = 0; i < 3; i++) { await R.penTap(page, cdp, '#cap-again'); await page.waitForTimeout(90); }
    L.check('nothing left to redo', await page.isDisabled('#cap-again'));
    await R.penTap(page, cdp, '#cap-undo');
    await quiet(page);
    await penOnSheet(page, cdp, [[xr + 12, yb - 3], [xr + 15, yb - 9], [xr + 18, yb - 1], [xr + 19, yb]]);
    await quiet(page);
    L.check('writing empties Wiederholen', await page.isDisabled('#cap-again') && (await page.evaluate(() => window.__hw.capture.history.redo.length)) === 0);

    // ---------- the record ----------
    const removedT = new Set(JSON.parse(orig).slice(k).flatMap((s) => s[2]));
    await R.penTap(page, cdp, '#cap-done');
    await page.waitForSelector('#cap[data-state="confirm"]');
    await quiet(page);
    await R.penTap(page, cdp, '#confirm-ok');
    await L.until(async () => (await L.lines(page)).length === 1);
    const rec = (await L.lines(page))[0].record;
    const se = L.schemaErrors(rec);
    L.check('record satisfies the schema', se.length === 0, se.join('; '));
    const ve = await page.evaluate(async (r) => (await import('./js/capture/hwline.js')).validate(r), rec);
    L.check('app validator agrees', ve.length === 0, ve.join('; '));
    const origArr = JSON.parse(orig);
    const same = rec.strokes.slice(0, k).every((s, i) => JSON.stringify([s.x, s.y, s.t, s.p, s.tiltX, s.tiltY]) === JSON.stringify(origArr[i].slice(0, 6)));
    L.check('the kept strokes are byte for byte the original prefix', rec.strokes.length === k + 2 && same, String(rec.strokes.length));
    const ts = rec.strokes.flatMap((s) => s.t);
    L.check('t strictly increasing over the whole line', ts.every((t, i) => i === 0 || t > ts[i - 1]));
    L.check('no removed stroke reaches the record', !rec.strokes.some((s) => s.t.some((t) => removedT.has(t))) && rec.strokes.length === k + 2);
    const ed = rec.edits;
    L.check('edits count it: erase 1, erased strokes, undo 7, redo 6', ed.erase === 1 && ed.erased_strokes === n0 - k && ed.undo === 7 && ed.redo === 6 && ed.spot === 0 && ed.clear === 0, JSON.stringify(ed));
    const firstRemoved = origArr[k][2][0];
    L.check('edits.removed_t marks the time of the removed writing', Array.isArray(ed.removed_t) && ed.removed_t.length >= 1
      && ed.removed_t.some(([a, b]) => a === firstRemoved && b > a)
      && ed.removed_t.every(([a, b]) => !rec.strokes.some((s) => s.t[0] >= a && s.t[0] <= b)), JSON.stringify(ed.removed_t));

    // ---------- a stray mark can go on its own ----------
    await page.waitForSelector('#cap[data-state="write"]');
    await quiet(page);
    const P = L.pen(cdp);
    const r2 = await L.canvasRect(page);
    const base = r2.top + Math.round(r2.height * 0.64) + 0.5;
    for (let i = 0; i < 4; i++) await P.stroke(L.glyph(r2.left + 80 + i * 26, base, 8));
    await P.stroke([[r2.left + 700, r2.top + 30, 0.3], [r2.left + 700.6, r2.top + 30.4, 0.3], [r2.left + 701, r2.top + 30.6]]);   // stray dot
    for (let i = 4; i < 7; i++) await P.stroke(L.glyph(r2.left + 80 + i * 26, base, 8));
    await quiet(page);
    const strayIdx = await page.evaluate(async () => (await import('./js/capture/qa.js')).strayStrokes(window.__hw.capture.recorder.strokes));
    L.check('qa finds the stray dot (stroke 4)', JSON.stringify(strayIdx) === '[4]', JSON.stringify(strayIdx));
    const before7 = await strokesJson(page);
    await R.penTap(page, cdp, '#cap-erase');
    await penOnSheet(page, cdp, [[700.4, 30.3]].map(([x, y]) => [x, y]));
    L.check('a tap on a stray mark chooses only it', (await page.textContent('#erase-status')) === 'Nur dieser Fleck wird entfernt.' && JSON.stringify((await page.evaluate(() => window.__hw.capture.eraser)).set) === '[4]');
    await quiet(page);
    await R.penTap(page, cdp, '#erase-ok');
    const arr7 = JSON.parse(before7);
    L.check('only the stray mark is gone; every other stroke is byte-identical', (await strokesJson(page)) === JSON.stringify(arr7.filter((_, i) => i !== 4)));
    const fl = await page.evaluate(async () => (await import('./js/capture/qa.js')).check({ text: 'abcdefg', strokes: window.__hw.capture.recorder.strokes, canvas: [2000, 2000] }));
    L.check('… and the stray flag is gone', !fl.includes('stray_stroke'), JSON.stringify(fl));
    await R.penTap(page, cdp, '#cap-undo');
    L.check('Rückgängig puts the mark back at its place', (await strokesJson(page)) === before7);

    // ---------- Löschen and the time base ----------
    const tb = await page.evaluate(() => window.__hw.capture.recorder.timeBase);
    await page.waitForTimeout(120);
    await R.penTap(page, cdp, '#cap-clear');
    L.check('Löschen empties the line and the time base', (await nStrokes(page)) === 0 && (await page.evaluate(() => window.__hw.capture.recorder.timeBase)) === null);
    L.check('Radieren is off on an empty line', await page.isDisabled('#cap-erase'));
    await page.waitForTimeout(120);
    await R.penTap(page, cdp, '#cap-undo');
    L.check('Rückgängig after Löschen: strokes and time base are back', (await strokesJson(page)) === before7 && (await page.evaluate(() => window.__hw.capture.recorder.timeBase)) === tb);
    await page.waitForTimeout(120);
    await R.penTap(page, cdp, '#cap-again');
    L.check('Wiederholen deletes it again', (await nStrokes(page)) === 0);
    await page.waitForTimeout(120);
    await R.penTap(page, cdp, '#cap-undo');
    // Undo everything stroke by stroke, then redo everything.
    for (let i = 0; i < 8; i++) { await R.penTap(page, cdp, '#cap-undo'); await page.waitForTimeout(40); }
    L.check('Rückgängig stroke by stroke down to an empty line', (await nStrokes(page)) === 0 && (await page.evaluate(() => window.__hw.capture.recorder.timeBase)) === null);
    for (let i = 0; i < 8; i++) { await R.penTap(page, cdp, '#cap-again'); await page.waitForTimeout(40); }
    L.check('Wiederholen brings every stroke back, with its time base', (await strokesJson(page)) === before7 && (await page.evaluate(() => window.__hw.capture.recorder.timeBase)) === tb);

    // ---------- the pen button erases (temporary eraser) ----------
    await quiet(page);
    const st0 = await recState(page);
    const s0 = JSON.parse(before7)[5];
    await penOnSheet(page, cdp, [[s0[0][3], s0[1][3]]], { button: 'right', buttons: 2 });
    L.check('pen-down with the side button held opens the eraser on that stroke, records nothing',
      (await mode(page)) === 'erase' && (await page.evaluate(() => window.__hw.capture.eraser.k)) === 5 && (await recState(page)) === st0);
    await quiet(page);
    // Button let go, the pen writes on: the temporary eraser closes and the stroke is recorded.
    const rq = await L.canvasRect(page);
    const xEnd = Math.max(...JSON.parse(before7).flatMap((s) => s[0])) + 30;
    const n8 = JSON.parse(before7).length;
    await P.stroke(L.glyph(rq.left + xEnd, base, 8));
    await quiet(page);
    L.check('after a side-button erase choice, a plain stroke closes the eraser and is written', (await mode(page)) === null
      && (await nStrokes(page)) === n8 + 1 && (await strokesJson(page)).startsWith(before7.slice(0, -1)), JSON.stringify([await mode(page), await nStrokes(page)]));
    L.check('… and the sheet shows no red', await page.evaluate(() => { const a = window.__pixels(); window.__hw.capture.redraw(); const b = window.__pixels(); for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false; return true; }));
    await R.penTap(page, cdp, '#cap-undo');
    await quiet(page);
    // The side button held by accident on empty paper: a normal (flagged) stroke, no eraser.
    await P.stroke(L.glyph(rq.left + xEnd, base, 8), { button: 'right', buttons: 2 });
    await quiet(page);
    const sb = await page.evaluate(() => { const ss = window.__hw.capture.recorder.strokes; return { n: ss.length, button: ss[ss.length - 1].button }; });
    L.check('side button held on empty paper: no eraser, the stroke is recorded with the button flag', (await mode(page)) === null && sb.n === n8 + 1 && sb.button === true, JSON.stringify(sb));
    await P.stroke(L.glyph(rq.left + xEnd + 26, base, 8));
    await quiet(page);
    L.check('… and the next stroke is written too', (await nStrokes(page)) === n8 + 2 && (await mode(page)) === null);
    await R.penTap(page, cdp, '#cap-undo'); await page.waitForTimeout(120);
    await R.penTap(page, cdp, '#cap-undo');
    await quiet(page);
    L.check('Rückgängig takes both back', (await strokesJson(page)) === before7);

    // ---------- look options keep working ----------
    for (const d of [{ pen: 'fueller', width: 3, paper: 'liniert', scheme: 'dark_on_light' }, { pen: 'fineliner', width: 1, paper: 'linie', scheme: 'light_on_dark' }]) {
      await page.evaluate((o) => window.__hw.saveDisplay(o), d);
      await page.waitForTimeout(80);
      await quiet(page);
      await R.penTap(page, cdp, '#cap-erase');
      await penOnSheet(page, cdp, [[s0[0][3], s0[1][3]]]);
      const rp = await redPixels(page, bboxes(JSON.parse(before7).map((s) => ({ x: s[0], y: s[1] })), [5, 6, 7]));
      await quiet(page);
      await R.penTap(page, cdp, '#erase-cancel');
      const cmp = await page.evaluate(() => { const a = window.__pixels(); window.__hw.capture.redraw(); const b = window.__pixels(); let n = 0; for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) n++; return n; });
      L.check(`${d.pen} ${d.paper} ${d.scheme}: red preview on the right strokes, clean sheet after Abbrechen`, rp.inside > 20 && rp.outside === 0 && cmp === 0, JSON.stringify([rp, cmp]));
    }
    const contrast = await page.evaluate(async () => {
      const { contrast: cr } = await import('./js/capture/ink.js');
      const cs = getComputedStyle(document.documentElement);
      const g = (n) => cs.getPropertyValue(n).trim();
      return [cr(g('--paper-light-erase'), g('--paper-light-bg')), cr(g('--paper-dark-erase'), g('--paper-dark-bg'))];
    });
    L.check('the erase colour has at least 3:1 contrast on both papers', contrast.every((c) => c >= 3), JSON.stringify(contrast));

    // ---------- late strokes are flagged ----------
    const late = await page.evaluate(async () => {
      const qa = await import('./js/capture/qa.js');
      const st = (x0, x1) => ({ x: [x0, (x0 + x1) / 2, x1], y: [100, 94, 100], t: [0, 1, 2], p: [0.5, 0.5, 0.5] });
      const strokes = []; for (let i = 0; i < 12; i++) strokes.push(st(40 + i * 14, 50 + i * 14));
      const ok = qa.lateStrokes(strokes).length;
      strokes.push({ x: [90, 90.5], y: [80, 80.5], t: [0, 1], p: [0.5, 0.5] });   // a dot 120 px back
      return { ok, late: qa.lateStrokes(strokes), flags: qa.check({ text: 'abcdefghijkl', strokes }) };
    });
    L.check('late_stroke: a dot added 120 px back is flagged, normal writing is not', late.ok === 0 && JSON.stringify(late.late) === '[12]' && late.flags.includes('late_stroke'), JSON.stringify(late));
    const realLate = await page.evaluate(async (lines) => { const qa = await import('./js/capture/qa.js'); return lines.filter((s) => qa.lateStrokes(s).length).length; }, R.realLines().map((r) => r.strokes.map((s) => ({ x: s.x, y: s.y }))));
    L.check('late_stroke: none of the writer\'s real lines is flagged', realLate === 0, String(realLate));

    // ---------- palm on a button, then a real tap ----------
    await quiet(page);
    const ub = await page.evaluate(() => { const r = document.getElementById('cap-undo').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const nP = await nStrokes(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cr.left + 600, y: cr.top + 100, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cr.left + 600, y: cr.top + 100, id: 1 }, { x: ub.x, y: ub.y, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: cr.left + 600, y: cr.top + 100, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(100);
    L.check('a button pressed while a palm rests on the sheet does nothing', (await nStrokes(page)) === nP);
    await R.penTap(page, cdp, '#cap-undo');
    L.check('… and the next real tap right after it works', (await nStrokes(page)) === nP - 1);

    L.check('no page errors', errors.length === 0, errors.join(' | '));

    // ---------- the toolbar row never changes height (phone portrait, small landscape) ----------
    for (const [vw, vh] of [[412, 915], [1138, 640]]) {
      const app = await L.newApp(browser, server, { viewport: { width: vw, height: vh }, dsf: 2.25, writer: 'finn' });
      const pg = app.page;
      const rr = await L.canvasRect(pg);
      const bl = rr.top + rr.height * 0.64;
      const PP = L.pen(app.cdp);
      for (let i = 0; i < 5; i++) await PP.stroke(L.glyph(rr.left + 30 + i * 22, bl, 8));
      await quiet(pg);
      const oneRow = await pg.evaluate(() => [...document.querySelectorAll('.cap-tools > .btn')].filter((b) => b.offsetParent).every((b) => b.getBoundingClientRect().height === 52 && b.getBoundingClientRect().top === document.querySelector('#cap-undo').getBoundingClientRect().top));
      const t0 = await toolbarBox(pg), c0 = JSON.stringify(await L.canvasRect(pg));
      await R.penTap(pg, app.cdp, '#cap-erase');
      const pts = await pg.evaluate(() => { const s = window.__hw.capture.recorder.strokes[1]; return [s.x[3], s.y[3]]; });
      await penOnSheet(pg, app.cdp, [pts]);
      await pg.waitForTimeout(100);
      L.check(`${vw}x${vh}: every toolbar button sits in one row`, oneRow);
      L.check(`${vw}x${vh}: the eraser bar with its status keeps row and sheet in place, the line goes on`,
        (await toolbarBox(pg)) === t0 && JSON.stringify(await L.canvasRect(pg)) === c0 && (await pg.getAttribute('#cap', 'data-state')) === 'write'
        && (await pg.evaluate(() => window.__hw.capture.eraser.set.length)) === 4, `${t0} -> ${await toolbarBox(pg)}`);
      L.check(`${vw}x${vh}: no page errors`, app.errors.length === 0, app.errors.join(' | '));
      await app.ctx.close();
    }
  } catch (e) {
    console.error(e); L.check('test ran without exception', false, String(e));
  } finally {
    await browser.close(); await server.close();
  }
  process.exit(L.summary() ? 0 : 1);
})();
