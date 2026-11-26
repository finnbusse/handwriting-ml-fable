// Documents with structure (document.js: planRich / layoutRich, decor.js, pdf.js) on
// pieces written by the fixture model: plain documents unchanged, blocks inside the
// margins and on the ruling, hanging indents, centring, boxes, decorations where
// their words are, piece borders, determinism, pagination, the PDF.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { HandwritingModel, makeRandom, writePiece } from '../../web/js/engine/engine.js';
import { planDocument, pieceSeed, preparePiece, layoutDocument, relayoutDocument, wordAt, pieceBoxes, TITLE_FIT } from '../../web/js/generate/document.js';
import { pdfBytes } from '../../web/js/generate/pdf.js';
import * as decor from '../../web/js/generate/decor.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
if (!fs.existsSync(path.join(dir, 'model.json'))) { console.log('SKIP: no fixtures'); process.exit(0); }
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'));
const bin = fs.readFileSync(path.join(dir, 'model.bin'));
const model = new HandwritingModel(manifest, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const opts = { gapXh: model.gapXh, sizeByBias: manifest.size_by_bias };
const norm = (t) => model.normalize(t);

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log('FAIL', msg); } };
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

// Every distinct piece text is written once (one attempt, as the worker's first try).
const cache = new Map();
let writeMs = 0;
const write = (plan) => plan.pieces.map((p) => {
  if (!cache.has(p.text)) {
    const t0 = performance.now();
    cache.set(p.text, preparePiece(writePiece(model, p.text, { bias: 0.4, random: makeRandom(pieceSeed(4, cache.size)) }), model.xhModel));
    writeMs += performance.now() - t0;
  }
  return cache.get(p.text);
});

const sp = (text, o = {}) => ({ text, ...o });
const P = (...xs) => ({ type: 'paragraph', lines: [xs.map((x) => (typeof x === 'string' ? sp(x) : x))] });
const H = (level, text) => ({ type: 'heading', level, lines: [[sp(text)]] });
const I = (level, marker, ...xs) => ({ ...P(...xs), type: 'item', level, marker });
const doc = (...blocks) => ({ format: 'markdown', blocks, notes: [] });
const BLANK = { type: 'blank', lines: [] }, RULE = { type: 'rule', lines: [] }, BREAK = { type: 'pagebreak', lines: [] };

// 1. a plain document gives what its text gives (the plain path itself is guarded by
//    document.test.mjs and pdf.test.mjs, which call it exactly as before)
const letter = 'Liebe Grüße aus dem Urlaub!\n\nDas Wetter ist herrlich, und wir waren heute schon schwimmen.';
const plainDoc = doc(P('Liebe Grüße aus dem Urlaub!'), BLANK, P('Das Wetter ist herrlich, und wir waren heute schon schwimmen.'), BLANK);
const pt = planDocument(letter, norm), pd = planDocument(plainDoc, norm);
check(JSON.stringify(pt.pieces.map((p) => [p.text, p.typed, p.para])) === JSON.stringify(pd.pieces.map((p) => [p.text, p.typed, p.para])) && JSON.stringify(pt.paragraphs) === JSON.stringify(pd.paragraphs), 'plain document: the same pieces as its text');
const wl = write(pt);
const pick = (d) => JSON.stringify([d.typical, d.pieces, d.pages.map((pg) => [pg.words.map((w) => [w.text, w.typed, w.piece, w.word, w.line, w.x, w.width, w.baseline, w.box, w.ok]), pg.strokes.map((q) => Array.from(q))])]);
for (const paper of ['liniert', 'kariert', 'blanko']) {
  const a = layoutDocument(pt, wl, { paper, seed: 3 }, opts), b = layoutDocument(pd, wl, { paper, seed: 3 }, opts);
  check(pick(a) === pick(b), `plain document on ${paper}: the same layout numbers as its text`);
  for (const pen of ['fineliner', 'fueller', 'bleistift']) {
    const look = { pen, width: 0.25, scheme: paper === 'kariert' ? 'light_on_dark' : 'dark_on_light', ink: 'blueblack' };
    const o = { look, title: 'T', date: new Date(2026, 10, 26), compress: false };
    check(Buffer.from(await pdfBytes(a, o)).equals(Buffer.from(await pdfBytes(b, o))), `plain document on ${paper} with ${pen}: the same PDF bytes`);
  }
}

// 2. a document with every block type
const rich = doc(
  { ...H(1, 'Wochenplan'), align: 'center' },
  { ...P('26. November'), align: 'right' },
  H(2, 'Erster Teil'),
  P('Vorher kommt Text ', sp('kräftig geschrieben', { bold: true }), ' und danach noch Text'),
  P('Die Farbe ist ', sp('rot', { color: 'rot' }), ' und ', sp('wichtig', { underline: true }), ' hier.'),
  P(sp('Ein markierter Satz über zwei Zeilen hinweg, damit er sicher umbricht', { mark: 'gelb' })),
  I(1, 'bullet', 'Ein langer Punkt, der sicher über das Ende der Zeile hinaus geht und umbricht'),
  I(2, 'bullet', 'eingerückt'),
  I(1, 'number', '1. Erster Schritt, der auch recht lang ist und deshalb umbrechen muss'),
  I(1, 'check', 'offen'),
  I(1, 'checked', sp('erledigt', { strike: true })),
  { ...P(sp('Merke:', { bold: true }), ' Kasten mit Text'), box: 1 },
  P('Ursache ', { text: '', arrow: 'right' }, ' Wirkung ', { text: '', arrow: 'double' }, ' Folge'),
  RULE,
  { ...P('Mitte'), align: 'center' },
);
const plan = planDocument(rich, norm);
const written = write(plan);
check(plan.rich && plan.pieces.every((p) => Number.isInteger(p.block)), 'a document plan is rich, every piece knows its block');
// pieces never cross a block or a line; a long styled run is a piece of its own; a short one stays inside one
check(plan.lines.every((l) => l.items.filter((it) => it.piece !== undefined).every((it) => plan.pieces[it.piece].block === l.block)), 'pieces stay inside their block');
check(plan.pieces.some((p) => p.text === 'kräftig geschrieben'), `a long bold run is a piece of its own (${plan.pieces.map((p) => p.text).join(' | ')})`);
const redPiece = plan.pieces.find((p) => p.text.split(' ').includes('rot'));
check(redPiece && redPiece.text !== 'rot', 'a short coloured run stays inside a piece');
const alone = (pl) => pl.pieces.every((p) => [...p.text].length > 3 || pl.paragraphs[p.para].length === 1);
check(alone(plan), 'no piece of 3 characters or fewer next to other text');
// an arrow is a piece border only where both sides are long enough to be written on their own
{
  const A = (kind) => ({ text: '', arrow: kind });
  const ap = planDocument(doc(P('A ', A('right'), ' B'), P('Ja ', A('double'), ' gut'), P('CO2 ', A('right'), ' O2 und Wasser'), P('x ', A('right'), ' y ', A('left'), ' z'), P('Ursache ', A('right'), ' Wirkung')), norm);
  check(alone(ap) && JSON.stringify(ap.pieces.map((p) => p.text)) === JSON.stringify(['A B', 'Ja gut', 'CO2 O2 und Wasser', 'x y z', 'Ursache', 'Wirkung']), `arrows: short neighbours are written together (${ap.pieces.map((p) => p.text).join(' | ')})`);
  check(JSON.stringify(ap.lines[3].items.map((it) => (it.arrow ? it.arrow : `${it.from}-${it.to}`))) === '["0-1","right","1-2","left","2-3"]', 'arrows: the layout cuts a piece written together where its arrows go');
}
check(!plan.pieces.some((p) => /→/.test(p.text)) && plan.lines.some((l) => l.items.some((it) => it.arrow === 'double')), 'arrows are not text');

const settings = (paper, seed = 3) => ({ paper, size: 'mittel', bias: 0.4, seed });
const t0 = performance.now();
const d = layoutDocument(plan, written, settings('liniert'), opts);
const layoutMs = performance.now() - t0;
const g = d.geometry, page = d.pages[0];
const xh = g.xh;
check(d.complete && d.pages.length === 1, `rich: one complete page (${d.pages.length})`);
check(page.styles.length === page.strokes.length, 'one style per stroke');

// inside the margins, on the ruling
for (const paper of ['liniert', 'kariert', 'blanko']) {
  const dd = layoutDocument(plan, written, settings(paper), opts), gg = dd.geometry;
  for (const pg of dd.pages) {
    for (const w of pg.words) {
      check(gg.baselines.some((y) => near(y, w.baseline)), `${paper}: ${w.text} on a baseline`);
      if (gg.ruling.ys.length) check(gg.ruling.ys.some((y) => near(y, w.baseline)), `${paper}: ${w.text} on a ruling line`);
      check(w.box[0] >= gg.left - 0.5 - 1e-6 && w.box[2] <= gg.right + 1e-6, `${paper}: ${w.text} inside the margins`);
    }
    // drawn lines may overshoot their end by a hand's slip, at most 1.5 mm
    pg.strokes.forEach((q, i) => {
      for (let j = 0; j < q.length; j += 3) if (q[j] < gg.left - 1.5 || q[j] > gg.right + 1.5) { check(false, `${paper}: ${pg.styles[i].kind} ink at x ${q[j].toFixed(2)}`); break; }
    });
    // a highlighter pass starts a little before its first letter, as a marker does: at most 2.5 mm
    for (const b of pg.bands) for (let j = 0; j < b.points.length; j += 2) if (b.points[j] < gg.left - 2.5 || b.points[j] > gg.right + 2.5) { check(false, `${paper}: band at x ${b.points[j].toFixed(2)}`); break; }
  }
}

const wordsOf = (bi) => page.words.filter((w) => w.block === bi);
const rowsOf = (bi) => { const m = new Map(); for (const w of wordsOf(bi)) { if (!m.has(w.line)) m.set(w.line, []); m.get(w.line).push(w); } return [...m.values()]; };
const kinds = (k) => page.strokes.map((q, i) => [q, page.styles[i]]).filter(([, s]) => s.kind === k).map(([q]) => q);
const xs = (q) => { let lo = Infinity, hi = -Infinity, ylo = Infinity, yhi = -Infinity; for (let i = 0; i < q.length; i += 3) { lo = Math.min(lo, q[i]); hi = Math.max(hi, q[i]); ylo = Math.min(ylo, q[i + 1]); yhi = Math.max(yhi, q[i + 1]); } return { lo, hi, ylo, yhi }; };

// headings: the title larger, firmer, with space before the next block
const title = wordsOf(0), body = wordsOf(3);
check(title.length && title.every((w) => w.size > 1.4), 'the title is written larger');
check(page.styles.slice(title[0].strokes[0], title[title.length - 1].strokes[1]).every((s) => s.bold), 'the title has a firmer stroke');
check(kinds('underline').length >= 3, 'title (two lines), section heading and a word underlined');
check(wordsOf(1)[0].line >= title[0].line + 2, 'an empty line after the title');
check(wordsOf(2)[0].line >= wordsOf(1)[0].line + 2, 'an empty line before a section heading');

// centred and right-aligned
for (const bi of [0, 14]) for (const row of rowsOf(bi)) {
  const lo = Math.min(...row.map((w) => w.box[0])), hi = Math.max(...row.map((w) => w.box[2]));
  check(Math.abs((lo + hi) / 2 - (g.left + g.right) / 2) <= 0.5, `block ${bi}: centred within 0.5 mm (${((lo + hi) / 2 - (g.left + g.right) / 2).toFixed(2)})`);
}
{ const row = rowsOf(1)[0]; check(Math.abs(Math.max(...row.map((w) => w.box[2])) - g.right) <= 0.5, 'right-aligned line ends at the right margin'); }

// hanging indents
{
  const bullets = kinds('bullet').map(xs), rows = rowsOf(6);
  check(rows.length >= 2, `the long item wraps (${rows.length} rows)`);
  const starts = rows.map((r) => r[0].x);
  check(bullets.length === 2 && bullets[0].hi < starts[0] - 0.5 * xh, 'the bullet sits before the text');
  check(starts.slice(1).every((x) => Math.abs(x - starts[0]) <= 1.0), `the item's later rows start under its text (${starts.map((x) => x.toFixed(1))})`);
  const sub = wordsOf(7)[0];
  check(sub.x > starts[0] + 2 * xh && bullets[1].lo > bullets[0].lo + 2 * xh, 'a nested item is indented further');
  const num = rowsOf(8);
  check(num.length >= 2 && num[0][0].text === '1.' && Math.abs(num[1][0].x - num[0][1].x) <= 1.0, `a numbered item hangs after its label (${num.map((r) => r[0].x.toFixed(1))} vs ${num[0][1] && num[0][1].x.toFixed(1)})`);
  check(kinds('check').length === 4 && kinds('tick').length === 1, 'two check boxes of two strokes, one tick');
}

// decorations where their words are
{
  const w = page.words.find((x) => x.text === 'wichtig');
  const u = kinds('underline').map(xs).find((b) => b.lo < w.x + w.width && b.hi > w.x && b.ylo > w.baseline - 0.1 && b.ylo < w.baseline + 1.5 * xh);
  check(u && u.lo >= w.x - 0.6 * xh && u.hi <= w.x + w.width + 0.6 * xh && u.ylo > w.baseline && u.yhi < w.baseline + xh, `underline under its word, below the baseline (${u && [u.lo, u.hi, u.ylo].map((v) => v.toFixed(2))} / ${w.x.toFixed(2)}..${(w.x + w.width).toFixed(2)} @ ${w.baseline})`);
  const marked = wordsOf(5);
  check(page.bands.length === rowsOf(5).length, `one highlighter pass per row (${page.bands.length})`);
  for (const mw of marked) {
    const b = page.bands.find((x) => x.line === mw.line), p = b && b.points;
    let lo = Infinity, hi = -Infinity, ylo = Infinity, yhi = -Infinity;
    for (let j = 0; p && j < p.length; j += 2) { lo = Math.min(lo, p[j]); hi = Math.max(hi, p[j]); ylo = Math.min(ylo, p[j + 1]); yhi = Math.max(yhi, p[j + 1]); }
    check(b && lo <= mw.x && hi >= mw.x + mw.width && ylo < mw.baseline - xh && yhi > mw.baseline, `band behind '${mw.text}'`);
  }
  const red = page.words.find((x) => x.text === 'rot');
  const redStrokes = page.styles.slice(red.strokes[0], red.strokes[1]);
  check(redStrokes.every((s) => s.color === 'rot') && page.styles.filter((s) => s.color === 'rot').length === redStrokes.length, 'the red word and only it is red');
  const st = kinds('strike').map(xs), done = wordsOf(10)[0];
  check(st.length === 1 && st[0].lo < done.x + 0.5 * xh && st[0].hi > done.x + done.width - 0.5 * xh && st[0].ylo > done.baseline - 1.5 * xh && st[0].yhi < done.baseline, 'the strike runs through its word above the baseline');
  const arrows = kinds('arrow'), aw = page.arrows;
  check(aw.length === 2 && arrows.length === 3 + 4, `two arrows: shaft and two heads, a double shaft and two heads (${arrows.length})`);
  const [ursache, wirkung] = ['Ursache', 'Wirkung'].map((t) => page.words.find((x) => x.text === t));
  check(aw[0].x > ursache.x + ursache.width && aw[0].x + aw[0].width < wirkung.x, 'the arrow sits between its words');
  check(arrows.map(xs).every((b) => b.ylo > ursache.baseline - 1.6 * xh && b.yhi < ursache.baseline), 'arrows at mid-height');
  check(kinds('rule').length === 1, 'one rule');
}

// the box encloses its text and nothing else
{
  const f = page.frames.find((x) => x.box === 1), [x0, y0, x1, y1] = f.rect;
  const inside = (w) => w.box[0] >= x0 && w.box[2] <= x1 && w.box[1] >= y0 && w.box[3] <= y1;
  const touches = (w) => w.box[0] < x1 && w.box[2] > x0 && w.box[1] < y1 && w.box[3] > y0;
  check(page.words.filter((w) => w.frame === 1).every(inside), 'the frame encloses its words');
  check(page.words.filter((w) => w.frame !== 1).every((w) => !touches(w)), 'no other word reaches into the frame');
  check(kinds('frame').length === 4, 'a frame of four lines');
}

// determinism: same seed, same document; another seed moves the hand
const json = (x) => JSON.stringify(x, (k, v) => (v instanceof Float32Array ? Array.from(v) : v));
check(json(d) === json(layoutDocument(plan, written, settings('liniert'), opts)), 'same seed gives the same document');
const d2 = layoutDocument(plan, written, settings('liniert', 4), opts);
check(json(kinds('frame')) !== json(d2.pages[0].strokes.filter((_, i) => d2.pages[0].styles[i].kind === 'frame')), 'another seed draws the frame differently');
check(json(relayoutDocument(d, plan, written, opts)) === json(d), 'a relayout with nothing changed changes nothing');
// partly written: what is shown does not move
{
  const part = written.slice(); part[6] = undefined;
  const h = layoutDocument(plan, part, settings('liniert'), { ...opts, typical: d.typical });
  const pos = (x) => x.pages.flatMap((p) => p.words.filter((w) => w.piece < 6).map((w) => [w.text, w.x, w.baseline]));
  check(!h.complete && h.placed === 6 && json(pos(h)) === json(pos(d)), 'partly written: stops at the first missing piece, nothing before it moves');
}

// 2b. a piece that could not be cut into words: a short styled run inside it is placed
//     at the clearest gap in the ink near where its letters should be
{
  const sd = doc(P('Ein Hut ', sp('mit', { color: 'blau', underline: true }), ' Feder'));
  const sp0 = planDocument(sd, norm), sw = write(sp0);
  check(sp0.pieces.length === 1 && sw[0].words.length === 4, `the test piece is one piece cut into 4 words (${sw[0].words.length})`);
  const cut = layoutDocument(sp0, sw, settings('liniert'), opts);
  const ws = sw[0].words, pts = [];
  for (const w of ws) pts.push(...w.points);
  const whole = { ...sw[0], words: [{ text: sp0.pieces[0].text, points: new Float32Array(pts), level: 0, x0: Math.min(...ws.map((w) => w.x0)), x1: Math.max(...ws.map((w) => w.x1)), size: 1 }] };
  const unc = layoutDocument(sp0, [whole], settings('liniert'), opts);
  const blueX = (dd) => { const pg = dd.pages[0]; return pg.strokes.filter((_, i) => pg.styles[i].color === 'blau').map(xs); };
  const got = blueX(unc), ul = unc.pages[0].strokes.filter((_, i) => unc.pages[0].styles[i].kind === 'underline').map(xs);
  check(unc.stats.guessed > 0 && unc.pages[0].words.length === 1, `uncut piece: borders guessed (${unc.stats.guessed})`);
  // where the ink of 'mit' lands in the uncut piece
  const uw = unc.pages[0].words[0], f = uw.width / (whole.words[0].x1 - whole.words[0].x0), mit = ws[2];
  const want = [(mit.x0 - whole.words[0].x0) * f + uw.x, (mit.x1 - whole.words[0].x0) * f + uw.x];
  const lo = Math.min(...got.map((b) => b.lo)), hi = Math.max(...got.map((b) => b.hi));
  check(got.length && Math.abs(lo - want[0]) < 0.3 && Math.abs(hi - want[1]) < 0.3, `uncut piece: the blue strokes are those of 'mit' (${lo.toFixed(2)}..${hi.toFixed(2)} vs ${want.map((v) => v.toFixed(2))})`);
  check(ul.length === 1 && Math.abs(ul[0].lo - want[0]) < 1.2 && Math.abs(ul[0].hi - want[1]) < 1.2, `uncut piece: the underline under that word (${ul[0] && [ul[0].lo, ul[0].hi].map((v) => v.toFixed(2))})`);
  check(cut.stats.guessed === 0, 'cut piece: nothing guessed');
}

// 2c. an arrow between short words: the piece written together is placed in two parts,
//     cut at the network's word gap or, written as one, at the clearest gap in its ink
{
  const sd = doc(P('Ja ', { text: '', arrow: 'double' }, ' gut'));
  const sp0 = planDocument(sd, norm), sw = write(sp0);
  const between = (dd) => {
    const pg = dd.pages[0], a = pg.arrows[0], [ja, gut] = pg.words;
    return pg.words.length === 2 && ja.text === 'Ja' && gut.text === 'gut' && ja.x + ja.width <= a.x && a.x + a.width <= gut.x && ja.line === gut.line;
  };
  check(sw[0].words.length === 2 && between(layoutDocument(sp0, sw, settings('liniert'), opts)), 'arrow between the words of a piece cut into words');
  const ws = sw[0].words, pts = [];
  for (const w of ws) pts.push(...w.points);
  const whole = { ...sw[0], words: [{ text: 'Ja gut', points: new Float32Array(pts), level: 0, x0: Math.min(...ws.map((w) => w.x0)), x1: Math.max(...ws.map((w) => w.x1)), size: 1 }] };
  const unc = layoutDocument(sp0, [whole], settings('liniert'), opts);
  check(unc.stats.cut === 1 && between(unc), `arrow between the parts of a piece written as one (cut ${unc.stats.cut})`);
  const n = (dd) => dd.pages[0].strokes.slice(0, 2).reduce((s, q) => s + q.length, 0);
  check(n(unc) === pts.length, 'the cut keeps every point of the piece');
}

// 2d. a long title wraps onto rows two ruled lines apart, so its rows never run into
//     each other; the double underline goes under the last row only
{
  const hd = doc(H(1, 'Zusammenfassung der wichtigsten Ergebnisse der Französischen Revolution'), P('Ein Satz danach'));
  const hp = planDocument(hd, norm), dd = layoutDocument(hp, write(hp), settings('liniert'), opts), pg = dd.pages[0];
  const rows = new Map();
  for (const w of pg.words.filter((x) => x.block === 0)) { if (!rows.has(w.line)) rows.set(w.line, []); rows.get(w.line).push(w); }
  const lines = [...rows.keys()].sort((a, b) => a - b);
  check(lines.length >= 2 && lines.every((l, i) => !i || l - lines[i - 1] === 2), `a wrapped title: rows two lines apart (${lines})`);
  const ink = lines.map((l) => [Math.min(...rows.get(l).map((w) => w.box[1])), Math.max(...rows.get(l).map((w) => w.box[3]))]);
  check(ink.every(([, lo], i) => i === ink.length - 1 || lo < ink[i + 1][0]), 'a wrapped title: no row reaches into the next');
  const ul = pg.strokes.map((q, i) => [xs(q), pg.styles[i]]).filter(([, s]) => s.kind === 'underline').map(([b]) => b);
  const under = (l) => ul.filter((b) => b.ylo > dd.geometry.baselines[l] && b.yhi < dd.geometry.baselines[l] + 2 * dd.geometry.xh).length;
  check(lines.every((l, i) => under(l) === (i === lines.length - 1 ? 2 : 1)), `a wrapped title: one underline a row, two under the last (${lines.map(under)})`);
}

// 2e. a numbered list writes its text in one column after the widest label, and
//     every label on the line
{
  const nd = doc(I(1, 'number', '1. Wasser kochen'), I(1, 'number', '2. Nudeln hineingeben'), I(1, 'number', '3. Zehn Minuten warten'));
  const np = planDocument(nd, norm), dd = layoutDocument(np, write(np), settings('liniert'), opts), pg = dd.pages[0];
  check(np.pieces.every((p) => p.cuts && p.cuts[0] === 1) && np.lines.every((l) => l.items[0].label), 'numbered items: the label is cut off its piece');
  const first = [0, 1, 2].map((bi) => pg.words.filter((w) => w.block === bi));
  check(first.every((ws) => /^\d\.$/.test(ws[0].text)), `numbered items: each label placed on its own (${first.map((ws) => ws[0].text)})`);
  const starts = first.map((ws) => ws[1].x);
  check(Math.max(...starts) - Math.min(...starts) < 1e-6, `numbered items: the text in one column (${starts.map((x) => x.toFixed(2))})`);
  check(first.every((ws) => ws[0].x + ws[0].width < ws[1].x), 'numbered items: the label before its text');
}

// 2f. an underline stays under its letters at any length (the hand's drift is held by
//     distance, not by angle)
{
  let high = -Infinity, strike = [Infinity, -Infinity];
  for (let s = 0; s < 1000; s++) for (const L of [20, 60, 150]) {
    for (const q of decor.underline(decor.decorRandom(s, 1, L), 20, 20 + L, 100, 1.44)) for (let i = 1; i < q.length; i += 3) high = Math.max(high, 100 - q[i]);
    for (const q of decor.strike(decor.decorRandom(s, 2, L), 20, 20 + L, 100, 1.44)) for (let i = 1; i < q.length; i += 3) { strike[0] = Math.min(strike[0], q[i] - 100); strike[1] = Math.max(strike[1], q[i] - 100); }
  }
  check(high < -0.2 * 1.44, `1000 underlines up to 150 mm never come closer than 0.2 x-heights to the baseline (${(high / 1.44).toFixed(3)})`);
  check(strike[0] > -1.3 * 1.44 && strike[1] < -0.1 * 1.44, `1000 strikes up to 150 mm stay in the letters (${strike.map((v) => (v / 1.44).toFixed(2))})`);
}

// 2g. a line in parts: date left and title centred on one row, name left and date
//     right, three parts; a part of 3 characters or fewer written with its neighbour;
//     a title too long for the row: the parts on rows of their own
{
  const L = (text, o = {}) => sp(text, o), C = (text, o = {}) => sp(text, { part: 'center', ...o }), R = (text, o = {}) => sp(text, { part: 'right', ...o });
  const row = (...xs) => [xs];
  const pd = doc(
    { type: 'heading', level: 1, lines: row(L('26.11.2026', { body: true }), C('Die Römer')) },
    { type: 'paragraph', lines: row(L('Anna Schmidt'), R('26.11.2026')) },
    { type: 'paragraph', lines: row(L('Deutsch'), C('Erörterung'), R('7b')) },
    { type: 'heading', level: 1, lines: row(L('26.11.2026', { body: true }), C('Die Ursachen und Folgen des Ersten Weltkriegs')) },
    { type: 'heading', level: 2, lines: row(L('Mittwoch, der 26.11.2026', { body: true }), C('Die Römer')) },
    { type: 'heading', level: 1, lines: row(L('26.11.2026', { body: true }), C('Die Weimarer Zeit')) },
  );
  const pp = planDocument(pd, norm), pw = write(pp), pl = layoutDocument(pp, pw, settings('liniert'), opts), pg = pl.pages[0], gg = pl.geometry;
  const mid = (gg.left + gg.right) / 2;
  check(pp.pieces.every((p) => p.text !== '7b') && pp.pieces.some((p) => p.text === 'Erörterung 7b' && p.cuts && p.cuts[0] === 1), `parts: "7b" is written with its neighbour and cut off again (${pp.pieces.map((p) => p.text).join(' | ')})`);
  check(alone(pp), 'parts: no piece of 3 characters or fewer next to other text');
  check(pp.pieces.some((p) => p.text === 'Anna Schmidt') && pp.pieces.filter((p) => p.text === '26.11.2026').length >= 3 && pp.pieces.some((p) => p.text === 'Die Römer'), 'parts: a part border is a piece border');
  const ws = (bi) => pg.words.filter((w) => w.block === bi), ext = (list) => [Math.min(...list.map((w) => w.x)), Math.max(...list.map((w) => w.x + w.width))];
  const gapOk = (a, b) => ext(a)[1] < ext(b)[0];
  // date and title on one row
  const [date0, ...title0] = ws(0);
  check(title0.length === 2 && ws(0).every((w) => w.line === date0.line && w.baseline === date0.baseline), `title row: date and title on one baseline (${ws(0).map((w) => `${w.text}@${w.line}`)})`);
  check(Math.abs((ext(title0)[0] + ext(title0)[1]) / 2 - mid) <= 0.5, `title row: the title centred within 0.5 mm (${((ext(title0)[0] + ext(title0)[1]) / 2 - mid).toFixed(2)})`);
  check(Math.abs(date0.x - gg.left) <= 0.5 && gapOk([date0], title0), 'title row: the date at the left edge, clear of the title');
  check(date0.size === 1 && title0.every((w) => w.size > 1.4), 'title row: the date at body size, the title large');
  check(pg.styles.slice(...date0.strokes).every((st) => !st.bold) && pg.styles.slice(title0[0].strokes[0], title0[1].strokes[1]).every((st) => st.bold), 'title row: only the title has the firmer stroke');
  const under = (line) => pg.strokes.map((q, i) => [xs(q), pg.styles[i]]).filter(([b, st]) => st.kind === 'underline' && b.ylo > gg.baselines[line] && b.yhi < gg.baselines[line] + 2 * gg.xh).map(([b]) => b);
  const ul0 = under(date0.line), [t0, t1] = ext(title0);
  // (the second line of a double underline is drawn a little shorter)
  check(ul0.length === 2 && ul0.every((b) => b.lo > ext([date0])[1] + gg.xh && b.lo > t0 - 1.5 * gg.xh && b.hi < t1 + 1.5 * gg.xh) && Math.abs(ul0[0].lo - t0) < 1.5 * gg.xh && Math.abs(ul0[0].hi - t1) < 1.5 * gg.xh, `title row: the double underline spans the title only (${ul0.map((b) => `${b.lo.toFixed(1)}-${b.hi.toFixed(1)}`)} vs ${t0.toFixed(1)}-${t1.toFixed(1)})`);
  // name left, date right
  const nd = ws(1);
  check(nd.length === 3 && nd.every((w) => w.line === nd[0].line), 'letter head: name and date on one row');
  check(Math.abs(ext(nd.slice(2))[1] - gg.right) <= 0.5 && gapOk(nd.slice(0, 2), nd.slice(2)), `letter head: the date ends at the right edge within 0.5 mm (${(ext(nd.slice(2))[1] - gg.right).toFixed(2)})`);
  check(under(nd[0].line).length === 0, 'letter head: no underline');
  // three parts
  const tp = ws(2);
  check(tp.map((w) => w.text).join(' ') === 'Deutsch Erörterung 7b' && tp.every((w) => w.line === tp[0].line), `three parts on one row (${tp.map((w) => `${w.text}@${w.line}`)})`);
  check(Math.abs((tp[1].x + tp[1].x + tp[1].width) / 2 - mid) <= 0.5 && Math.abs(tp[2].x + tp[2].width - gg.right) <= 0.5 && gapOk([tp[0]], [tp[1]]) && gapOk([tp[1]], [tp[2]]), 'three parts: centred, at the right edge, apart');
  // too long: the date on its row, the title centred on rows of its own
  const [date3, ...title3] = ws(3), lines3 = [...new Set(title3.map((w) => w.line))];
  check(date3.text === '26.11.2026' && title3.every((w) => w.line > date3.line + 1), `too long: the date on a row of its own, an empty line before the title (${ws(3).map((w) => `${w.text}@${w.line}`)})`);
  check(lines3.length >= 2 && lines3.every((l) => { const r = title3.filter((w) => w.line === l), [a, b] = ext(r); return Math.abs((a + b) / 2 - mid) <= 0.5; }), 'too long: every title row centred');
  check(under(date3.line).length === 0 && lines3.every((l, i) => under(l).length === (i === lines3.length - 1 ? 2 : 1)), 'too long: no underline under the date, the title underlined');
  // a centred part too close to its left neighbour is not moved off the middle: the
  // parts take rows of their own
  {
    const w4 = ws(4), left = w4.filter((w) => !/^(Die|Römer)$/.test(w.text)), ti = w4.filter((w) => !left.includes(w));
    const [c0, c1] = ext(ti);
    check(ti.length === 2 && ti.every((w) => w.line > left[left.length - 1].line) && Math.abs((c0 + c1) / 2 - mid) <= 0.5, `too close: the title centred on a row below the date (${((c0 + c1) / 2 - mid).toFixed(2)} mm; ${w4.map((w) => `${w.text}@${w.line}`)})`);
    check(Math.abs(left[0].x - gg.left) <= 0.5, 'too close: the date row at the left edge');
  }
  // a title that fits beside the date only when written smaller: one row, centred,
  // at one of the sizes of TITLE_FIT, still the firmer stroke and the double underline
  {
    const [d5, ...t5] = ws(5), [a5, b5] = ext(t5);
    console.log(`    (shrunk title: sizes ${t5.map((w) => w.size)}, ${a5.toFixed(1)}-${b5.toFixed(1)} mm, date ends ${ext([d5])[1].toFixed(1)})`);
    check(t5.length === 3 && t5.every((w) => w.line === d5.line && w.baseline === d5.baseline), `shrunk title: date and title on one row (${ws(5).map((w) => `${w.text}@${w.line}`)})`);
    check(t5.every((w) => w.size === t5[0].size) && TITLE_FIT.includes(t5[0].size) && d5.size === 1, `shrunk title: written at a size of TITLE_FIT (${t5[0].size})`);
    check(Math.abs((a5 + b5) / 2 - mid) <= 0.5 && Math.abs(d5.x - gg.left) <= 0.5 && gapOk([d5], t5), `shrunk title: centred within 0.5 mm, clear of the date (${((a5 + b5) / 2 - mid).toFixed(2)})`);
    check(under(d5.line).length === 2 && pg.styles.slice(t5[0].strokes[0], t5[2].strokes[1]).every((st) => st.bold), 'shrunk title: double underline and the firmer stroke');
  }
  // the text layer: the parts of a row on one line, in reading order
  const c = Buffer.from(await pdfBytes(pl, { look: { pen: 'fineliner', scheme: 'dark_on_light' }, compress: false })).toString('latin1');
  const tms = [...c.matchAll(/ ([\d.]+) Tm [\d.-]+ Tw \(([^)]*)\) Tj/g)].map((m) => [m[1], m[2].trim()]);
  const lineText = (t) => { const y = tms.find(([, s]) => s === t)[0]; return tms.filter(([yy]) => yy === y).map(([, s]) => s).join(' '); };
  check(lineText('Anna') === 'Anna Schmidt 26.11.2026' && lineText('Deutsch') === 'Deutsch Er\\366rterung 7b', `text layer: parts in reading order on one line (${lineText('Anna')} / ${lineText('Deutsch')})`);
  // partly written: a line in parts appears only once all of it is written
  const part = pw.slice(); part[1] = undefined;
  const h = layoutDocument(pp, part, settings('liniert'), { ...opts, typical: pl.typical });
  check(h.pages.length === 0 || h.pages[0].words.length === 0, 'partly written: the date waits for its title');
  check(json(pl) === json(layoutDocument(pp, pw, settings('liniert'), opts)), 'parts: same seed, same document');
}

const filler = (n) => Array.from({ length: n }, () => P('Das Wetter ist heute schön'));
const lay = (dc) => { const p = planDocument(dc, norm); return layoutDocument(p, write(p), settings('liniert'), opts); };
const lines = d.geometry.baselines.length;

// 2h. tables: short cells written with a neighbour and cut apart again; columns as
//     wide as their writing; every word in its cell and on a ruling; the grid clear
//     of the ink; a row never split by a page break
{
  const cell = (text, o = {}) => (text ? [sp(text, o)] : []);
  const TB = (columns, rows) => ({ type: 'table', columns, rows: rows.map((cells, r) => ({ ...(r ? {} : { head: true }), cells: cells.map((c) => (Array.isArray(c) ? c : cell(c))) })), lines: [] });
  const timetable = TB(['center', 'left', 'left', 'left', 'left', 'left'], [['Std', 'Mo', 'Di', 'Mi', 'Do', 'Fr'], ['1', 'De', 'Ma', 'En', 'Bio', 'Ma'], ['2', 'De', 'Ma', '', 'Bio', 'Ku'], ['3', 'Mu', '', 'Ma', 'De', 'ja'], ['4', 'En', 'Ge', 'Sp', '', '']]);
  const compare = TB(['left', 'left', 'left'], [['Verfahren', 'Vorteile', 'Nachteile'],
    ['Photovoltaik', [sp('Erzeugt Strom direkt aus Sonnenlicht und braucht '), sp('kaum Wartung', { mark: 'gelb' })], 'Liefert nachts keinen Strom und braucht viel Fläche'],
    ['Windkraft', [sp('Sehr '), sp('günstig', { bold: true }), sp(' pro Kilowattstunde')], 'Hängt stark vom Wetter ab und ist manchmal laut']]);
  const numbers = TB(['left', 'right', 'right'], [['Posten', 'Menge', 'Preis'], ['Hefte', '4', '3,96 €'], ['Füller', '1', '12,50 €'], ['Lineal', '1', '1,20 €'], [[sp('Summe', { bold: true })], [], [sp('17,66 €', { bold: true })]]]);
  const td = doc(P('Vorher ein Satz'), timetable, P('Dazwischen'), compare, numbers, P('Danach ein Satz'));
  const tp = planDocument(td, norm), tw = write(tp);
  const tLines = tp.lines.filter((l) => tp.blocks[l.block].type === 'table');
  // planning: every cell a piece border; a short cell never a piece of its own
  check(alone(tp), `tables: no piece of 3 characters or fewer next to other text (${tp.pieces.filter((p) => [...p.text].length <= 3).map((p) => p.text)})`);
  check(tLines.every((l) => l.items.every((it) => Number.isInteger(it.cell) && it.sub === 0)), 'tables: every item knows its cell');
  check(tLines.every((l) => l.items.every((it, i) => !i || it.cell >= l.items[i - 1].cell)) && tLines.every((l) => l.items.every((it, i) => !i || it.piece !== l.items[i - 1].piece || it.cell !== l.items[i - 1].cell || it.sub !== l.items[i - 1].sub ? true : false)), 'tables: a cell border is an item border');
  const shortCells = tp.pieces.filter((p) => tp.blocks[p.block].type === 'table' && p.cuts);
  check(shortCells.length >= 8 && shortCells.every((p) => p.cuts.every((c) => c > 0 && c < p.text.split(' ').length)), `tables: short cells written with a neighbour and cut apart (${shortCells.map((p) => `${p.text}/${p.cuts}`).join(' | ')})`);
  check(tLines[0].head && !tLines[1].head && tp.pieces.filter((p) => tp.lines[p.para] === tLines[0]).every((p) => p.text.length), 'tables: the header row is marked');
  const headStyle = tp.styles[tLines[0].sty[0]];
  check(headStyle && headStyle.bold, 'tables: the header is written with the firmer stroke');
  for (const paper of ['liniert', 'kariert', 'blanko']) {
    const dd = layoutDocument(tp, tw, settings(paper), opts), gg = dd.geometry;
    // (on kariert the comparison and the numbers go on on a second page)
    const tabs = dd.pages.flatMap((p) => (p.tables || []).map((t) => ({ ...t, pg: p })));
    check(dd.complete && tabs.length === 3, `${paper}: three tables (${tabs.length} parts on ${dd.pages.length} pages)`);
    for (const t of tabs) {
      const pg = t.pg;
      const ws = pg.words.filter((w) => w.block === t.block), n = t.xs.length - 1;
      check(t.xs.every((x, i) => !i || x > t.xs[i - 1] + 1) && Math.abs(t.xs[0] - gg.left) < 1e-9 && t.xs[n] <= gg.right + 1e-9, `${paper} table ${t.block}: columns side by side, from the left edge, inside the text width (${t.xs.map((x) => x.toFixed(1))})`);
      check(t.ys.every((y, i) => !i || y > t.ys[i - 1]), `${paper} table ${t.block}: grid lines top to bottom`);
      // every word inside its cell: between two column lines, between the grid lines of its row, on a ruling
      const bad = ws.filter((w) => {
        const c = t.xs.findIndex((x, j) => j < n && w.box[0] >= x && w.box[2] <= t.xs[j + 1]);
        const r = t.rows.findIndex((ls) => ls.includes(w.line));
        return c < 0 || r < 0 || !(w.baseline > t.ys[r] && w.baseline < t.ys[r + 1]) || !gg.baselines.some((y) => near(y, w.baseline));
      });
      check(!bad.length, `${paper} table ${t.block}: every word inside its cell and on a ruling (${bad.map((w) => w.text)})`);
      if (gg.ruling.ys.length) check(ws.every((w) => gg.ruling.ys.some((y) => near(y, w.baseline))), `${paper} table ${t.block}: on the ruled lines`);
      // the grid clear of the ink: no point of the cells near a column line, hardly any near a row line
      let nearV = 0, nearH = 0, all = 0;
      for (const w of ws) for (let k = w.strokes[0]; k < w.strokes[1]; k++) {
        const q = pg.strokes[k];
        for (let i = 0; i < q.length; i += 3) { all++; if (t.xs.some((x) => Math.abs(q[i] - x) < 0.3)) nearV++; if (t.ys.some((y) => Math.abs(q[i + 1] - y) < 0.1)) nearH++; }
      }
      check(nearV === 0 && nearH <= 0.002 * all, `${paper} table ${t.block}: the grid clear of the ink (${nearV} points at column lines, ${nearH} of ${all} at row lines)`);
    }
    // the drawn grid: one ruler line per row border and column line, the header line twice
    const grid = dd.pages.flatMap((pg) => pg.strokes.map((q, i) => [xs(q), pg.styles[i], pg]).filter(([, st]) => st.kind === 'grid'));
    check(grid.length === tabs.reduce((a, t) => a + t.ys.length + 1 + t.xs.length, 0) && grid.every(([, st]) => !st.color && !st.bold), `${paper}: the grid drawn in ink, one stroke a line (${grid.length})`);
    for (const t of tabs) for (const y of t.ys) {
      const h = grid.filter(([b, , pg]) => pg === t.pg && b.yhi - b.ylo < 1 && Math.abs((b.ylo + b.yhi) / 2 - y) < 0.6);
      check(h.length >= 1 && h.every(([b]) => b.lo < t.xs[0] + 0.5 && b.lo > t.xs[0] - 1.2 && b.hi > t.xs[t.xs.length - 1] - 0.5 && b.hi < t.xs[t.xs.length - 1] + 1.2 && b.yhi - b.ylo < 0.5), `${paper}: the row line at ${y.toFixed(1)} runs straight from the first to the last column line, a little past or short of them`);
    }
    const [, cmpT, numT] = tabs;
    // the comparison wraps its long cells; its short first column keeps its width
    const cmpWords = cmpT.pg.words.filter((w) => w.block === cmpT.block), rowsOf2 = new Set(cmpWords.filter((w) => w.x > cmpT.xs[1] && w.x < cmpT.xs[2]).map((w) => w.line));
    check(cmpT.rows[1].length >= 2 && rowsOf2.size >= 3, `${paper}: long cells wrap onto several rows (${cmpT.rows.map((r) => r.length)})`);
    check(Math.abs(cmpT.xs[cmpT.xs.length - 1] - gg.right) < 1e-6, `${paper}: a table too wide for the text is as wide as the text`);
    const v = cmpWords.find((w) => w.text === 'Photovoltaik');
    check(v && cmpT.xs[1] - cmpT.xs[0] < v.width + 4 * gg.xh, `${paper}: a column of short cells keeps its natural width (${(cmpT.xs[1] - cmpT.xs[0]).toFixed(1)} mm for ${v && v.width.toFixed(1)})`);
    // right-aligned numbers end at the same x within a hair
    const nums = numT.pg.words.filter((w) => w.block === numT.block && w.x > numT.xs[2] && /€/.test(w.text));
    const ends = nums.map((w) => w.x + w.width);
    check(nums.length === 4 && Math.max(...ends) - Math.min(...ends) <= 0.15, `${paper}: right-aligned prices end within 0.15 mm (${ends.map((x) => x.toFixed(2))})`);
    // an empty line above and below a table
    const before = dd.pages[0].words.find((w) => w.text === 'Vorher'), endLine = numT.rows.at(-1).at(-1);
    const after = dd.pages.flatMap((p, pi) => p.words.filter((w) => w.text === 'Danach').map((w) => ({ pi, line: w.line })))[0];
    const sameP = dd.pages.indexOf(numT.pg) === after.pi;
    check(tabs[0].rows[0][0] === before.line + 2 && (sameP ? after.line === endLine + 2 : after.line === 0 && endLine >= gg.baselines.length - 2), `${paper}: an empty line above and below a table (${tabs[0].rows[0][0]} after ${before.line}; ${after.line} after ${endLine})`);
    // a word wider than its column is written smaller
    if (paper === 'liniert') {
      const wide = doc(TB(['left', 'left', 'left', 'left'], [['Donaudampfschifffahrt', 'Gesellschaftskapitän', 'Bundesverfassungsgericht', 'Rechtsschutzversicherung'], ['Eisenbahnverkehr', 'Wissenschaftsministerium', 'Arbeitsunfähigkeit', 'Landwirtschaftsbetrieb']]));
      const wpl = planDocument(wide, norm), wd = layoutDocument(wpl, write(wpl), settings('liniert'), opts), wt = wd.pages[0].tables[0];
      const fits = wd.pages[0].words.every((w) => wt.xs.some((x, j) => j < wt.xs.length - 1 && w.box[0] >= x && w.box[2] <= wt.xs[j + 1]));
      check(fits && Math.abs(wt.xs[4] - wd.geometry.right) < 1e-6, 'a word wider than its column is written smaller, inside its cell');
    }
    // a tap on a word in a cell finds its piece; the piece's boxes are where its words are
    const ma = dd.pages[0].words.find((w) => w.text === 'Bio');
    const hit = wordAt(dd, 0, ma.x + ma.width / 2, ma.baseline - 0.5);
    check(hit && hit.piece === ma.piece && pieceBoxes(dd, ma.piece).some((b) => b.box[0] <= ma.x + 1e-6 && b.box[2] >= ma.x + ma.width - 1e-6), `${paper}: a tap on a cell word finds its piece`);
  }
  // the text layer: the cells row by row in reading order
  const dl = layoutDocument(tp, tw, settings('liniert'), opts);
  const c = Buffer.from(await pdfBytes(dl, { look: { pen: 'fineliner', scheme: 'dark_on_light' }, compress: false })).toString('latin1');
  const tms = [...c.matchAll(/ ([\d.]+) Tm [\d.-]+ Tw \(([^)]*)\) Tj/g)].map((m) => [m[1], m[2].trim()]);
  const rowText = (t) => { const y = tms.find(([, s]) => s === t)[0]; return tms.filter(([yy]) => yy === y).map(([, s]) => s).join(' '); };
  check(rowText('Std') === 'Std Mo Di Mi Do Fr' && rowText('Posten') === 'Posten Menge Preis' && rowText('Hefte') === 'Hefte 4 3,96 \\200', `text layer: a table row in reading order (${rowText('Std')} / ${rowText('Hefte')})`);
  check(json(dl) === json(layoutDocument(tp, tw, settings('liniert'), opts)), 'tables: same seed, same document');
  const dl2 = layoutDocument(tp, tw, settings('liniert', 9), opts), gridOf = (dd) => dd.pages[0].strokes.filter((_, i) => dd.pages[0].styles[i].kind === 'grid');
  check(json(gridOf(dl)) !== json(gridOf(dl2)) && new Set(gridOf(dl).map((q) => json(Array.from(q).map((v, i) => (i % 3 === 2 ? v : 0))))).size > 1, 'tables: another seed draws the grid differently; no two lines alike');
  // partly written: a table appears only once all of it is written
  const part = tw.slice(), first = tp.pieces.find((p) => tp.blocks[p.block].type === 'table');
  part[first.index + 3] = undefined;
  const ph = layoutDocument(tp, part, settings('liniert'), { ...opts, typical: dl.typical });
  check(!ph.complete && ph.pages[0].words.every((w) => tp.blocks[w.block].type !== 'table') && !ph.pages[0].tables, 'partly written: the table waits for all of its cells');
  // a table that crosses a page break: no row split, the grid closed on both pages, the header not repeated
  const many = TB(['right', 'left', 'left'], [['Nr.', 'Stadt', 'Land'], ...Array.from({ length: 14 }, (_, i) => [String(i + 1), ['Berlin', 'Paris', 'Wien'][i % 3], ['Deutschland', 'Frankreich', 'Österreich'][i % 3]])]);
  many.rows[5].cells[2] = [sp('Frankreich mit einer langen Erklärung, die in ihrer Zelle umbricht und mehrere Zeilen braucht')];
  const bd = lay(doc(...filler(lines - 12), many, P('Danach ein Satz')));
  const parts = bd.pages.map((p) => (p.tables || [])[0]).filter(Boolean);
  check(bd.pages.length === 2 && parts.length === 2, `page break: the table goes on on the next page (${bd.pages.length} pages)`);
  if (parts.length === 2) {
    const [a, b] = parts;
    check(a.rows.flat().every((l) => l < lines) && b.rows[0][0] === 0, 'page break: the second part starts at the top of the next page');
    check(a.ys.length === a.rows.length + 1 && b.ys.length === b.rows.length + 1 && a.ys[a.ys.length - 1] > bd.geometry.baselines[a.rows.at(-1).at(-1)] && b.ys[0] < bd.geometry.baselines[0], 'page break: the grid closed at the bottom of the first part and the top of the second');
    const words0 = bd.pages[1].words.filter((w) => w.block === bd.pages[1].words[0].block);
    check(!words0.some((w) => w.text === 'Stadt'), 'page break: the header row is not repeated');
    // every table row on one page, the wrapped one too: 15 rows in all, none counted on both pages
    check(a.rows.length + b.rows.length === 15 && [...a.rows, ...b.rows].some((r) => r.length >= 2), `page break: no table row is split (${a.rows.map((r) => r.length)} / ${b.rows.map((r) => r.length)})`);
  }
  // a header row is not left alone at the bottom of a page
  const hb = lay(doc(...filler(lines - 3), many));
  const hp = hb.pages.map((p) => (p.tables || [])[0]).filter(Boolean);
  check(hp.length >= 1 && hb.pages[0].words.every((w) => w.text !== 'Stadt') || hp[0].rows.length >= 2, 'the header row stays with the row after it');
}

// 3. pagination (lines of one text again and again)
{
  const hd = lay(doc(...filler(lines - 2), H(2, 'Abschnitt'), P('Text danach hier')));
  const hw = hd.pages.flatMap((p, i) => p.words.filter((w) => w.text === 'Abschnitt').map((w) => [i, w.line]))[0];
  const nx = hd.pages.flatMap((p, i) => p.words.filter((w) => w.text === 'danach').map((w) => [i, w.line]))[0];
  check(hw && nx && hw[0] === nx[0] && hw[0] === 1 && hw[1] === 0, `a heading is not left alone at the bottom of a page (heading ${hw}, next ${nx})`);
  const bd = lay(doc(...filler(lines - 3), { ...P('Erste Zeile im Kasten'), box: 1 }, { ...P('Zweite Zeile im Kasten'), box: 1 }, { ...P('Dritte Zeile im Kasten'), box: 1 }));
  const boxed = bd.pages.map((p) => p.words.filter((w) => w.frame === 1).length);
  check(boxed[0] === 0 && boxed[1] > 0 && bd.pages[1].frames.length === 1 && bd.pages[1].words[0].line === 0, `a box that fits on a page moves to the next one whole (${boxed})`);
  const pb = lay(doc(P('Das Wetter ist heute schön'), BREAK, BREAK, P('Das Wetter ist heute schön'), BREAK, BLANK));
  check(pb.pages.length === 2 && pb.pages[1].words[0].line === 0, `an explicit page break; a second one and a trailing one open no page (${pb.pages.length})`);
  const bl = lay(doc(...filler(lines), BLANK, BLANK, P('Das Wetter ist heute schön')));
  check(bl.pages.length === 2 && bl.pages[1].words[0].line === 0, 'empty lines never open a page');
}

// 4. the PDF: parses, draws bands with transparency and colours only when used
const latin1 = (u8) => Buffer.from(u8).toString('latin1');
function contents(bytes, label) {
  const s = latin1(bytes);
  const sx = /startxref\n(\d+)\n%%EOF\n$/.exec(s);
  check(s.startsWith('%PDF-1.4\n') && sx && s.slice(Number(sx[1]), Number(sx[1]) + 5) === 'xref\n', `${label}: header, xref`);
  const head = /^xref\n0 (\d+)\n/.exec(s.slice(Number(sx[1])));
  const n = Number(head[1]), table = s.slice(Number(sx[1]) + head[0].length);
  const out = [];
  for (let k = 1; k < n; k++) {
    const off = Number(table.slice(20 * k, 20 * k + 10));
    check(s.startsWith(`${k} 0 obj\n`, off), `${label}: object ${k} at its offset`);
    const body = s.slice(off, s.indexOf('\nendobj\n', off));
    const len = /\/Length (\d+)/.exec(body);
    if (!len) continue;
    const start = s.indexOf('stream\n', off) + 7, data = bytes.subarray(start, start + Number(len[1]));
    check(s.slice(start + Number(len[1]), start + Number(len[1]) + 10) === '\nendstream', `${label}: stream length`);
    out.push(/FlateDecode/.test(body) ? zlib.inflateSync(data).toString('latin1') : latin1(data));
  }
  return { s, out };
}
for (const pen of ['fineliner', 'fueller', 'bleistift']) for (const scheme of ['dark_on_light', 'light_on_dark']) {
  const look = { pen, width: 0.25, scheme, ink: 'blueblack' };
  const { s, out } = contents(await pdfBytes(d, { look, compress: pen !== 'fueller' }), `rich ${pen} ${scheme}`);
  const c = out[0];
  check(/\/M0 gs [\d. ]+ rg\n[\s\S]*?\nh f/.test(c) && new RegExp(`/M0 << /ca 0\\.\\d+ /BM /${scheme === 'light_on_dark' ? 'Screen' : 'Multiply'} >>`).test(s), `rich ${pen} ${scheme}: highlighter as translucent fill`);
  check(c.indexOf('\nh f') < c.indexOf('1 J 1 j'), `rich ${pen} ${scheme}: bands under the ink`);
  check(new Set([...c.matchAll(/([\d.]+ [\d.]+ [\d.]+) RG/g)].map((m) => m[1])).size >= 3, `rich ${pen} ${scheme}: ink, red ink, ruling colours`);
  check(!/NaN|Infinity|undefined/.test(c), `rich ${pen} ${scheme}: no NaN`);
  const tj = [...c.matchAll(/\) Tj/g)].length;
  check(tj === page.words.length + page.arrows.length + page.markers.length - page.words.filter((w) => w.label).length, `rich ${pen} ${scheme}: words, arrows and list markers in the text layer, a label with its first word (${tj})`);
}
{
  const { s, out } = contents(await pdfBytes(layoutDocument(pd, wl, settings('liniert'), opts), { look: { pen: 'fineliner', scheme: 'dark_on_light' } }), 'plain');
  check(!/ rg|\nh f|\/M0|\/GB/.test(out[0] + s), 'plain: no fills, no highlighter states');
  check(new Set([...out[0].matchAll(/([\d.]+ [\d.]+ [\d.]+) RG/g)].map((m) => m[1])).size === 2, 'plain: ruling and ink colour only');
  const c = contents(await pdfBytes(d, { look: { pen: 'fineliner', scheme: 'dark_on_light' }, compress: false }), 'rich text').out[0];
  const lineOf = (t) => { const i = c.indexOf(`(${t}`); return c.slice(c.lastIndexOf('\n', i) + 1, i).match(/ ([\d.]+) Tm/)[1]; };
  check(lineOf('Wochenplan') !== lineOf('26.') && lineOf('Ursache') === lineOf('->'), 'text layer: the title on its own line, arrows as -> on theirs');
  check(lineOf('[ ]') === lineOf('offen') && lineOf('[x]') === lineOf('erledigt') && [...c.matchAll(/\(- \) Tj/g)].length === 2, 'text layer: list markers as - [ ] [x] before their items');
}

console.log(JSON.stringify({ written: cache.size, write_ms: Math.round(writeMs), layout_ms: +layoutMs.toFixed(1), stats: d.stats, failures }));
process.exit(failures ? 1 : 0);
