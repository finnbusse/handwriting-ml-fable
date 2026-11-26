// The page mode's layout (web/js/generate/document.js) on pieces written by the
// fixture model: rulings, margins, line and page breaks, size evening, determinism.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HandwritingModel, makeRandom, writePiece } from '../../web/js/engine/engine.js';
import {
  planDocument, pieceSeed, paperGeometry, preparePiece, layoutDocument, relayoutDocument, wordAt, pieceBoxes,
  sizeCorrection, typicalSize, sitLine, DOC_PAPERS, PAGE, MARGIN, SIZE_CLAMP,
} from '../../web/js/generate/document.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
if (!fs.existsSync(path.join(dir, 'model.json'))) { console.log('SKIP: no fixtures'); process.exit(0); }
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'));
const bin = fs.readFileSync(path.join(dir, 'model.bin'));
const model = new HandwritingModel(manifest, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const opts = { gapXh: model.gapXh, sizeByBias: manifest.size_by_bias };

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log('FAIL', msg); } };
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

// 1. text -> paragraphs -> pieces, seeds
const plan0 = planDocument('Erste Zeile hier\n\nnach einer Leerzeile\nund direkt darunter\n\n\n', (t) => model.normalize(t));
check(JSON.stringify(plan0.paragraphs.map((p) => p.length)) === '[1,0,1,1]', `paragraphs ${JSON.stringify(plan0.paragraphs)}: an empty line stays, trailing ones go`);
check(plan0.pieces.every((p, i) => p.index === i), 'pieces are numbered in text order');
const ends = planDocument('alt\rmac\r\nwin\nunix\r\rx', (t) => model.normalize(t));
check(JSON.stringify(ends.paragraphs.map((p) => p.map((i) => ends.pieces[i].text))) === '[["alt"],["mac"],["win"],["unix"],[],["x"]]', `line ends: \\r, \\r\\n and \\n each start a line (${JSON.stringify(ends.paragraphs)})`);
const quoted = planDocument('Er rief: „Süße Ähre“ – 3,50 €', (t) => model.normalize(t));
const typedAll = quoted.pieces.flatMap((p) => p.typed), normAll = quoted.pieces.flatMap((p) => p.text.split(' '));
check(typedAll.join(' ') === 'Er rief: „Süße Ähre“ – 3,50 €' && typedAll.length === normAll.length, `typed words kept beside the model's (${JSON.stringify(typedAll)} / ${JSON.stringify(normAll)})`);
const seeds = new Set(Array.from({ length: 500 }, (_, i) => pieceSeed(7, i)));
check(seeds.size === 500, 'piece seeds differ');
check(pieceSeed(7, 3) === pieceSeed(7, 3) && pieceSeed(7, 3) !== pieceSeed(7, 3, 1) && pieceSeed(7, 3) !== pieceSeed(8, 3), 'seed depends on document seed, index and version only');

// 2. rulings
const lin = paperGeometry('liniert'), kar = paperGeometry('kariert'), bla = paperGeometry('blanko');
check(lin.baselines.length === 33 && lin.baselines[0] === 24 && lin.baselines.every((y, i) => near(y, 24 + 8 * i, 1e-9)), 'liniert: a line every 8 mm from 24 mm');
check(PAGE.height - lin.baselines.at(-1) >= 12 && PAGE.height - lin.baselines.at(-1) - 8 < 12, 'liniert: last line at least 12 mm above the edge, no room for one more');
check(lin.ruling.ys.length === lin.baselines.length && lin.ruling.xs.length === 0, 'liniert: one rule per line');
check(kar.baselines.every((y, i) => i === 0 || near(y - kar.baselines[i - 1], 10, 1e-9)), 'kariert: 10 mm from line to line');
check(kar.baselines.every((y) => kar.ruling.ys.some((g) => near(g, y))), 'kariert: every baseline on a grid line');
check(kar.ruling.ys.every((y, i) => i === 0 || near(y - kar.ruling.ys[i - 1], 5, 1e-9)) && kar.ruling.xs.some((x) => near(x, MARGIN.left)), 'kariert: 5 mm grid, the left margin on a grid line');
check(kar.baselines[0] >= 24 && PAGE.height - kar.baselines.at(-1) >= 12, 'kariert: inside the same top and bottom room');
check(bla.ruling.ys.length === 0 && bla.ruling.xs.length === 0 && bla.baselines.length === 33, 'blanko: no ruling, the lines of liniert');
check(paperGeometry('liniert', 'klein').xh < lin.xh && lin.xh < paperGeometry('liniert', 'gross').xh, 'three letter sizes');

// 3. real pieces from the fixture model (one attempt each, as the worker's first try)
const text = 'Liebe Grüße aus dem Urlaub!\n\nDas Wetter ist herrlich, und wir waren heute schon schwimmen. Morgen geht es weiter.';
const plan = planDocument(text, (t) => model.normalize(t));
const t0 = performance.now();
const written = plan.pieces.map((p) => preparePiece(writePiece(model, p.text, { bias: 0.4, random: makeRandom(pieceSeed(5, p.index)) }), model.xhModel));
const writeMs = performance.now() - t0;
check(written.every((w) => w.words.length && Number.isFinite(w.estimate)), 'every piece prepared, with a size estimate');

function facts(doc, label) {
  const g = doc.geometry;
  for (const [pi, page] of doc.pages.entries()) {
    check(page.words.length > 0, `${label}: page ${pi + 1} is not empty`);
    check(page.words[0].line === 0, `${label}: page ${pi + 1} starts on its first line`);
    for (const w of page.words) {
      check(g.baselines.some((y) => near(y, w.baseline)), `${label}: ${w.text} on a baseline`);
      if (g.ruling.ys.length) check(g.ruling.ys.some((y) => near(y, w.baseline)), `${label}: ${w.text} on a ruling line`);
      check(w.line < g.baselines.length, `${label}: line ${w.line} exists`);
    }
    for (const q of page.strokes) {
      for (let i = 0; i < q.length; i += 3) {
        if (q[i] < g.left - 0.5 - 1e-6 || q[i] > g.right + 1e-6 || q[i + 1] < 0 || q[i + 1] > PAGE.height) { check(false, `${label}: ink at ${q[i].toFixed(2)}, ${q[i + 1].toFixed(2)} outside the margins`); return; }
      }
    }
  }
}

const settings = (paper, seed = 3) => ({ paper, size: 'mittel', bias: 0.4, seed });
for (const paper of DOC_PAPERS) {
  const doc = layoutDocument(plan, written, settings(paper), opts);
  facts(doc, `short ${paper}`);
  check(doc.complete && doc.placed === plan.pieces.length && doc.pages.length === 1, `short ${paper}: one complete page`);
  const lines = doc.pages[0].words.map((w) => w.line);
  const second = doc.pages[0].words.find((w) => w.piece === plan.paragraphs[2][0]);
  check(second && second.line === Math.max(...doc.pages[0].words.filter((w) => w.piece < second.piece).map((w) => w.line)) + 2, `short ${paper}: the empty line stays empty`);
  check(lines.every((l, i) => i === 0 || l >= lines[i - 1]), `short ${paper}: words flow downwards`);
}

// same seed, same document; another seed moves the gaps and line starts only
const a = layoutDocument(plan, written, settings('liniert', 3), opts), b = layoutDocument(plan, written, settings('liniert', 3), opts);
const json = (d) => JSON.stringify(d, (k, v) => (v instanceof Float32Array ? Array.from(v) : v));
check(json(a) === json(b), 'same seed gives the same document');
const c = layoutDocument(plan, written, settings('liniert', 4), opts);
check(json(a) !== json(c), 'another seed changes the layout');
const starts = a.pages[0].words.filter((w, i, ws) => i === 0 || ws[i - 1].line !== w.line).map((w) => w.x - MARGIN.left);
check(starts.every((d) => Math.abs(d) <= 0.5) && new Set(starts.map((d) => d.toFixed(3))).size > 1, `line starts vary by less than 0.5 mm: ${starts.map((d) => d.toFixed(2))}`);

// a text of one word; a word wider than a line
const one = planDocument('Hallo', (t) => model.normalize(t));
const oneDoc = layoutDocument(one, [preparePiece(writePiece(model, 'Hallo', { bias: 0.4, random: makeRandom(9) }), model.xhModel)], settings('kariert'), opts);
facts(oneDoc, 'one word');
check(oneDoc.pages.length === 1 && oneDoc.pages[0].words.length === 1 && oneDoc.pages[0].words[0].text === 'Hallo', 'one word: one word on one page');
const wide = (() => {      // a piece of one word 400 xh long, as a zigzag on the baseline
  const p = []; for (let i = 0; i <= 800; i++) p.push(i * 0.5, i % 2 ? -1 : 0, i === 800 ? 1 : 0);
  return { text: 'Riesenwort', ok: true, problems: [], estimate: NaN, words: [{ text: 'Riesenwort', points: new Float32Array(p), level: 0, x0: 0, x1: 400, size: 1 }] };
})();
const longPlan = planDocument('kurz davor Riesenwort danach', (t) => t);
const longWritten = [written[0], wide, written[1]];
const longDoc = layoutDocument({ paragraphs: [[0, 1, 2]], pieces: longPlan.pieces.slice(0, 3) }, longWritten, settings('liniert'), opts);
facts(longDoc, 'long word');
const big = longDoc.pages[0].words.find((w) => w.text === 'Riesenwort');
check(big && big.width <= longDoc.geometry.right - longDoc.geometry.left + 1e-6, 'a word longer than a line is made to fit');
check(big && longDoc.pages[0].words.filter((w) => w.line === big.line).length === 1, 'and stands on a line of its own');

// 4. three pages: the real pieces again and again
const many = [];
for (let k = 0; k < 24; k++) many.push(...text.split('\n').filter(Boolean));
const bigText = many.join('\n') + '\n\n' + many.slice(0, 4).join(' ');
const bigPlan = planDocument(bigText, (t) => model.normalize(t));
const pool = written.filter((w) => w.words.length > 1);
const bigWritten = bigPlan.pieces.map((p, i) => pool[i % pool.length]);
for (const paper of DOC_PAPERS) {
  const doc = layoutDocument(bigPlan, bigWritten, settings(paper), opts);
  facts(doc, `long ${paper}`);
  check(doc.pages.length >= 3, `long ${paper}: ${doc.pages.length} pages`);
  check(doc.pages.slice(0, -1).every((p) => Math.max(...p.words.map((w) => w.line)) >= doc.geometry.baselines.length - 2), `long ${paper}: pages are filled before the next one starts`);
  check(doc.pieces.every((p) => p && p.page < doc.pages.length), `long ${paper}: every piece knows its page`);
}

// 5. partly written, a piece rewritten, tapping a word
const k = Math.floor(bigPlan.pieces.length / 2);
const partial = bigWritten.slice(); partial[k] = undefined; partial[k + 3] = undefined;
const full = layoutDocument(bigPlan, bigWritten, settings('liniert'), opts);
const half = layoutDocument(bigPlan, partial, settings('liniert'), opts);
check(!half.complete && half.placed === k, `partial: stops at the first missing piece (${half.placed} of ${k})`);
const wordsOf = (d, upTo) => d.pages.flatMap((p, i) => p.words.filter((w) => w.piece < upTo).map((w) => [i, w.text, w.x.toFixed(4), w.baseline]));
check(JSON.stringify(wordsOf(half, k)) === JSON.stringify(wordsOf(full, k)), 'partial: what is shown already does not move when the rest arrives');
check(k > 12 && half.typical === full.typical, 'partial: the typical size is known from the first pieces');
const swapped = bigWritten.slice(); swapped[k] = pool[(k + 1) % pool.length];
const re = relayoutDocument(full, bigPlan, swapped, opts);
check(JSON.stringify(wordsOf(re, k)) === JSON.stringify(wordsOf(full, k)), 'rewrite: nothing before the piece moves');
check(re.typical === full.typical, 'rewrite: the typical size is kept');
const target = full.pages[0].words[5];
const cx = (target.box[0] + target.box[2]) / 2, cy = target.baseline - 0.5;
const hit = wordAt(full, 0, cx, cy);
check(hit && hit.word === target && hit.piece === target.piece, 'tap on a word finds it and its piece');
check(wordAt(full, 0, 5, 5) === null, 'tap on the empty margin finds nothing');
check(pieceBoxes(full, target.piece).length >= 1 && pieceBoxes(full, target.piece).every((b) => b.box[2] > b.box[0]), 'boxes of a piece for marking it');

// 5b. words the network put above the line are set on it, broken pieces are flagged
const lift = (w, dy) => { const p = new Float32Array(w.points); for (let i = 1; i < p.length; i += 3) p[i] -= dy; return p; };
const short = written.flatMap((pc) => pc.words).find((w) => [...w.text].length <= 2 && /^[a-zäöü]+$/u.test(w.text) && !/[gjpqyfz]/u.test(w.text));
if (short) {
  const sit0 = sitLine(short.points, 2), sit1 = sitLine(lift(short, 1), 2);
  check(Number.isFinite(sit0) && Math.abs(sit0 - short.level) < 0.4, `sitLine finds the line of a short word (${short.text}: ${sit0.toFixed(2)})`);
  check(Math.abs(sit1 - (sit0 - 1)) < 0.05, 'sitLine follows a short word lifted by 1 xh');
} else check(false, 'the test text has a short word');
{
  // every laid-out word with letters sits on its line by its own letter bottoms
  const g = full.geometry, off = [];
  full.pages.forEach((page) => page.words.forEach((w, i) => {
    if (!/[\p{L}\p{N}]/u.test(w.text)) return;
    const q = page.strokes[i], p = new Float32Array(q);
    for (let j = 0; j < p.length; j += 3) { p[j] /= g.xh; p[j + 1] = (p[j + 1] - w.baseline) / g.xh; }
    const sit = sitLine(p, 2.5);
    if (Number.isFinite(sit) && Math.abs(sit) > 0.6) off.push(`${w.text} ${sit.toFixed(2)} xh`);
  }));
  check(off.length === 0, `every word sits on its line within 0.6 xh (${off.join(', ')})`);
  // a word the network wrote 2.2 xh too high (beyond wordLevel's reach): set on the line all the same
  const k = written.findIndex((pc) => pc.words.length >= 4);
  if (k >= 0) {
    const raw = writePiece(model, plan.pieces[k].text, { bias: 0.4, random: makeRandom(pieceSeed(5, k)) });
    const wi = 2, from = written[k].words.slice(0, wi).reduce((n, w) => n + w.points.length, 0), to = from + written[k].words[wi].points.length;
    const pts = new Float32Array(raw.points);
    for (let j = from + 1; j < to; j += 3) pts[j] -= 2.2 * model.xhModel;
    const lifted = preparePiece({ ...raw, points: pts }, model.xhModel);
    const w0 = written[k].words[wi], w1 = lifted.words[wi];
    const off = w1 ? sitLine(w1.points, 2.5) - w1.level : NaN;
    check(w1 && w1.text === w0.text && w1.level < -1.5 && Math.abs(off) < 0.3, `'${w0.text}' lifted by 2.2 xh is moved back onto the line (level ${w0.level.toFixed(2)} -> ${w1 && w1.level.toFixed(2)}, off ${off.toFixed(2)})`);
  } else check(false, 'the test text has a piece of 4 words');
  check(written.every((pc) => Array.isArray(pc.flags)) && written.filter((pc) => pc.flags.length).length <= 2, `few test pieces flagged (${written.map((pc) => pc.flags.join('|')).filter(Boolean).join('; ')})`);
}

// 6. size evening
const est = written.map((w) => w.estimate);
const typ = typicalSize(written);
const after = est.map((e) => e + Math.log(sizeCorrection(e, typ)));
const sd = (v) => { const m = v.reduce((s, x) => s + x, 0) / v.length; return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length); };
check(sd(after) < sd(est), `size evening narrows the estimated size: sd ${sd(est).toFixed(3)} -> ${sd(after).toFixed(3)}`);
check(written.every((w) => { const f = sizeCorrection(w.estimate, typ); return f >= SIZE_CLAMP[0] && f <= SIZE_CLAMP[1]; }), 'corrections stay inside the clamp');
check(sizeCorrection(NaN, typ) === 1 && sizeCorrection(typ + 5, typ) === SIZE_CLAMP[0] && sizeCorrection(typ - 5, typ) === SIZE_CLAMP[1], 'no estimate: no correction; far off: clamped');

console.log(JSON.stringify({ pieces: plan.pieces.length, write_ms: Math.round(writeMs), pages_long: full.pages.length, sd_before: +sd(est).toFixed(3), sd_after: +sd(after).toFixed(3), failures }));
process.exit(failures ? 1 : 0);
