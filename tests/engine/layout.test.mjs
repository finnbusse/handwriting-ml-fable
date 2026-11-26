// Checks web/js/generate/layout.js against the page laid out by hw/page.py.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HandwritingModel } from '../../web/js/engine/engine.js';
import { splitPieces, straighten, pieceWords, layoutPage, toXh, baseline, sizeScale, countDots, expectedDots, judgePiece, levelledWords, betterAttempt, anotherAttempt, TRIES, TRIES_FOR_DOTS, SHORT_PIECE_CHARS } from '../../web/js/generate/layout.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
if (!fs.existsSync(path.join(dir, 'fixture.json'))) { console.log('SKIP: no fixtures'); process.exit(0); }
const fixture = JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'));
const bin = fs.readFileSync(path.join(dir, 'model.bin'));
const model = new HandwritingModel(manifest, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const page = fixture.page;

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log('FAIL', msg); } };

// 1. splitting text into pieces
const norm = page.text.split('\n').map((l) => model.normalize(l)).join('\n');
const paragraphs = splitPieces(norm);
check(JSON.stringify(paragraphs) === JSON.stringify(page.paragraphs), `pieces ${JSON.stringify(paragraphs)} vs ${JSON.stringify(page.paragraphs)}`);
for (const c of fixture.split ?? []) {
  const got = splitPieces(c.in);
  check(JSON.stringify(got) === JSON.stringify(c.out), `splitPieces(${JSON.stringify(c.in)}) = ${JSON.stringify(got)} vs ${JSON.stringify(c.out)} (Python)`);
}
check((fixture.split ?? []).length >= 8, 'the fixture holds the split cases');
const tiny = (t) => splitPieces(t).flat().filter((p) => [...p].length <= SHORT_PIECE_CHARS);
check(tiny('Der Zug kommt pünktlich um acht Uhr an.').length === 0 && tiny('Morgen schreiben wir die Klausur im Hörsaal B.').length === 0, 'no piece of three characters or fewer');
check(JSON.stringify(splitPieces('Ja!')) === '[["Ja!"]]' && JSON.stringify(splitPieces('Abc Donaudampfschifffahrt')) === '[["Abc Donaudampfschifffahrt"]]', 'a short text stays whole, a short first piece joins the next');

// 2. write every piece with the reference's random draws, then straighten and cut into words
let k = 0, worstBase = 0, worstStraight = 0, dotsSeen = 0, worstLevel = 0, levelled = 0;
const rows = paragraphs.map((para) => para.map((text) => {
  const ref = page.pieces[k++];
  const run = model.begin(text, { bias: fixture.bias });
  for (let t = 0; t < ref.draws.length && !run.done; t++) run.step(...ref.draws[t]);
  const finished = run.finish();
  const ink = toXh(finished, model.xhModel);
  check(countDots(ink.points) === ref.dots, `${text}: ${countDots(ink.points)} dots vs ${ref.dots} (Python)`);
  const judged = judgePiece({ ...finished, problems: [...finished.problems] }, run.norm, model.xhModel);
  check(judged.missingDots === ref.judge.missing_dots, `${text}: ${judged.missingDots} missing dots vs ${ref.judge.missing_dots} (Python)`);
  check(Math.abs(judged.strayDepth - ref.judge.stray_depth) < 0.02, `${text}: stray depth ${judged.strayDepth} vs ${ref.judge.stray_depth} (Python)`);
  check(judged.ok === ref.judge.ok, `${text}: verdict after the judge`);
  dotsSeen += ref.dots;
  const base = baseline(ink.points);
  worstBase = Math.max(worstBase, Math.abs(base.a - ref.baseline.a) * 50, Math.abs(base.b - ref.baseline.b));
  const st = straighten(ink);
  const flat = ref.straight.flat();
  check(st.points.length === flat.length, `${text}: ${st.points.length / 3} points vs ${flat.length / 3}`);
  for (let i = 0; i < Math.min(flat.length, st.points.length); i++) worstStraight = Math.max(worstStraight, Math.abs(st.points[i] - flat[i]));
  const words = pieceWords(st);
  check(words.length === ref.words.length, `${text}: ${words.length} words vs ${ref.words.length}`);
  words.forEach((w, i) => { if (ref.words[i]) check(w.text === ref.words[i].text && w.points.length / 3 === ref.words[i].points, `${text}: word ${i}`); });
  levelledWords(st).forEach(({ level }, i) => {
    if (!ref.words[i]) return;
    worstLevel = Math.max(worstLevel, Math.abs(level - ref.words[i].level));
    if (ref.words[i].level !== 0) levelled++;
  });
  return st;
}));
check(worstBase < 0.02, `baseline differs by ${worstBase}`);
check(worstStraight < 0.03, `straightened points differ by ${worstStraight}`);
check(worstLevel < 0.02, `word levels differ by ${worstLevel}`);

// 3. the page
const draws = [...page.gap_draws];
const pg = layoutPage(rows, { width: page.width, lineHeight: page.line_height, gap: page.gap, margin: page.margin, top: page.top, normal: () => draws.shift() });
check(pg.lines === page.lines, `lines ${pg.lines} vs ${page.lines}`);
check(pg.words.length === page.words.length, `words ${pg.words.length} vs ${page.words.length}`);
let worstPos = 0;
pg.words.forEach((w, i) => {
  const r = page.words[i];
  if (!r) return;
  check(w.text === r.text, `word ${i}: ${w.text} vs ${r.text}`);
  worstPos = Math.max(worstPos, Math.abs(w.x - r.x), Math.abs(w.y - r.y), Math.abs(w.width - r.width));
});
check(worstPos < 0.05, `word positions differ by ${worstPos}`);
check(Math.abs(pg.height - page.height) < 1e-6, 'page height');
const total = pg.strokes.reduce((s, q) => s + q.length / 3, 0);
check(total === page.points.length, `page has ${total} points vs ${page.points.length}`);
let worstInkPos = 0, at = 0;
for (const q of pg.strokes) for (let j = 0; j < q.length; j += 3, at++) {
  const r = page.points[at];
  if (r) worstInkPos = Math.max(worstInkPos, Math.abs(q[j] - r[0]), Math.abs(q[j + 1] - r[1]));
}
check(worstInkPos < 0.01, `ink on the page differs by ${worstInkPos} (every word set on the line as in Python)`);

// 4. size correction per legibility setting (hw/page.py: size_scale, layout(scale=...))
const table = { bias: [0.0, 0.4, 0.8, 1.2], xh: [1.02, 0.86, 0.80, 0.76] };
const expected = [[-0.1, 0.980392], [0.0, 0.980392], [0.2, 1.06383], [0.4, 1.162791], [0.55, 1.19403], [1.2, 1.315789], [2.0, 1.315789]];
for (const [b, want] of expected) check(Math.abs(sizeScale(table, b) - want) < 1e-5, `sizeScale(${b}) = ${sizeScale(table, b)} vs ${want} (Python)`);
check(sizeScale(null, 0.4) === 1 && sizeScale({ bias: [0, 1], xh: [0.5, 0.5] }, 0.3) === 1.5, 'sizeScale: no table gives 1, the factor is limited to 1.5');
const one = layoutPage(rows, { width: 4000, gap: page.gap, normal: () => 0 });           // one long line: nothing wraps
const big = layoutPage(rows, { width: 4000, gap: page.gap, normal: () => 0, scale: 1.25 });
check(one.words.length === big.words.length && one.lines === big.lines, 'scaled layout keeps words and lines');
let worstWidth = 0, worstGap = 0, worstInk = 0;
one.words.forEach((w, i) => {
  const v = big.words[i];
  worstWidth = Math.max(worstWidth, Math.abs(v.width - 1.25 * w.width));
  if (i > 0 && w.y === one.words[i - 1].y) {
    const g1 = w.x - (one.words[i - 1].x + one.words[i - 1].width), g2 = v.x - (big.words[i - 1].x + big.words[i - 1].width);
    worstGap = Math.max(worstGap, Math.abs(g1 - g2));
  }
  // every point: enlarged about the word's left end on its baseline
  const p = one.strokes[i], q = big.strokes[i];
  for (let j = 0; j < p.length; j += 3) {
    worstInk = Math.max(worstInk, Math.abs((q[j] - v.x) - 1.25 * (p[j] - w.x)), Math.abs((q[j + 1] - v.y) - 1.25 * (p[j + 1] - w.y)));
  }
});
check(worstWidth < 1e-3, `scaled word widths differ by ${worstWidth}`);
check(worstGap < 1e-3, `gaps must not be scaled, differ by ${worstGap}`);
check(worstInk < 1e-3, `scaled ink differs by ${worstInk}`);

// 5. dots: what a text calls for, and which of several attempts is kept
check(dotsSeen > 0, 'the fixture page must contain dots to count');
check(expectedDots('Über Österreich nach Zürich') === 8 && expectedDots('Jahr 2026: Haus am See') === 0 && expectedDots('jij') === 3, 'expectedDots');
const att = (ok, missingDots) => ({ ok, missingDots });
check(betterAttempt(att(true, 2), att(false, 0)), 'a sound attempt beats a faulty one');
check(!betterAttempt(att(false, 0), att(true, 2)), 'a faulty attempt never replaces a sound one');
check(betterAttempt(att(true, 0), att(true, 1)) && !betterAttempt(att(true, 1), att(true, 0)), 'fewer missing dots win');
check(!betterAttempt(att(true, 1), att(true, 1)), 'the earlier attempt wins a tie');

// 6. how many attempts a piece gets (hw/sampling.py: Synthesizer.write)
const attempts = (outcomes, tries) => {        // outcomes: [ok, missingDots] per attempt, as they would come out
  let best = null, n = 0;
  for (const [ok, md] of outcomes) {
    n++;
    const a = att(ok, md);
    if (best === null || betterAttempt(a, best)) best = a;
    if (!anotherAttempt(best, n, tries)) break;
  }
  return n;
};
check(TRIES === 3 && TRIES_FOR_DOTS === 6, 'three attempts, six when only dots are missing');
check(attempts([[true, 0], [true, 0]]) === 1, 'a perfect first attempt is kept');
check(attempts([[false, 0], [false, 0], [false, 0], [false, 0]]) === 3, 'a faulty piece gets three attempts');
check(attempts([[true, 1], [true, 1], [true, 1], [true, 1], [true, 1], [true, 1], [true, 1]]) === 6, 'a sound piece lacking a dot gets six');
check(attempts([[false, 0], [false, 0], [true, 1], [true, 0], [true, 0]]) === 4, 'sound by the third attempt: more until perfect');
check(attempts([[true, 1], [false, 0], [false, 0], [false, 0]]) === 4, 'the best attempt counts, not the latest');
check(attempts([[false, 1], [false, 1], [false, 1], [true, 1]]) === 3, 'faulty after three: no more');
check(attempts([[true, 1], [true, 1], [true, 1]], 1) === 1 && attempts([[false, 0], [false, 0], [false, 0]], 2) === 2, 'tries caps every piece');

console.log(JSON.stringify({ pieces: k, dots: dotsSeen, words_levelled: levelled, max_level_diff: +worstLevel.toExponential(2), words: pg.words.length, lines: pg.lines, max_baseline_diff: +worstBase.toExponential(2),
  max_straight_diff: +worstStraight.toExponential(2), max_word_pos_diff: +worstPos.toExponential(2), failures }));
process.exit(failures ? 1 : 0);
