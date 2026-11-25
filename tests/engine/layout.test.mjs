// Checks web/js/generate/layout.js against the page laid out by hw/page.py.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HandwritingModel } from '../../web/js/engine/engine.js';
import { splitPieces, straighten, pieceWords, layoutPage, toXh, baseline } from '../../web/js/generate/layout.js';

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

// 2. write every piece with the reference's random draws, then straighten and cut into words
let k = 0, worstBase = 0, worstStraight = 0;
const rows = paragraphs.map((para) => para.map((text) => {
  const ref = page.pieces[k++];
  const run = model.begin(text, { bias: fixture.bias });
  for (let t = 0; t < ref.draws.length && !run.done; t++) run.step(...ref.draws[t]);
  const ink = toXh(run.finish(), model.xhModel);
  const base = baseline(ink.points);
  worstBase = Math.max(worstBase, Math.abs(base.a - ref.baseline.a) * 50, Math.abs(base.b - ref.baseline.b));
  const st = straighten(ink);
  const flat = ref.straight.flat();
  check(st.points.length === flat.length, `${text}: ${st.points.length / 3} points vs ${flat.length / 3}`);
  for (let i = 0; i < Math.min(flat.length, st.points.length); i++) worstStraight = Math.max(worstStraight, Math.abs(st.points[i] - flat[i]));
  const words = pieceWords(st);
  check(words.length === ref.words.length, `${text}: ${words.length} words vs ${ref.words.length}`);
  words.forEach((w, i) => { if (ref.words[i]) check(w.text === ref.words[i].text && w.points.length / 3 === ref.words[i].points, `${text}: word ${i}`); });
  return st;
}));
check(worstBase < 0.02, `baseline differs by ${worstBase}`);
check(worstStraight < 0.03, `straightened points differ by ${worstStraight}`);

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

console.log(JSON.stringify({ pieces: k, words: pg.words.length, lines: pg.lines, max_baseline_diff: +worstBase.toExponential(2),
  max_straight_diff: +worstStraight.toExponential(2), max_word_pos_diff: +worstPos.toExponential(2), failures }));
process.exit(failures ? 1 : 0);
