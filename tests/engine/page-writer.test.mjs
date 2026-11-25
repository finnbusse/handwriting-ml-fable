// End-to-end in Node: text -> pieces -> engine -> page -> SVG, without a browser.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HandwritingModel, makeRandom, writePiece } from '../../web/js/engine/engine.js';
import { createPageWriter } from '../../web/js/generate/page-writer.js';
import { toSVG } from '../../web/js/generate/render.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
if (!fs.existsSync(path.join(dir, 'model.json'))) { console.log('SKIP: no fixtures'); process.exit(0); }
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'));
const bin = fs.readFileSync(path.join(dir, 'model.bin'));
const model = new HandwritingModel(manifest, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log('FAIL', msg); } };

const writer = createPageWriter({
  normalize: (t) => model.normalize(t), xhModel: model.xhModel, gapXh: model.gapXh,
  writePiece: async ({ text, bias, seed }) => writePiece(model, text, { bias, random: makeRandom(seed) }),
});
const text = 'Liebe Grüße aus dem Urlaub!\nDas Wetter ist herrlich, und wir waren heute schon schwimmen.';
const seen = [];
const t0 = performance.now();
const page = await writer.write(text, { seed: 11, width: 60, onPiece: (e) => seen.push([e.done, e.total, e.fresh.length, e.page.words.length]) });
const ms = performance.now() - t0;
check(page && page.words.length === text.split(/\s+/).length, `page has ${page && page.words.length} words`);
check(seen.length === seen[0][1], 'one report per piece');
check(seen.every((s, i) => i === 0 || s[3] > seen[i - 1][3]), 'page grows piece by piece');
check(page.lines >= 3, `expected wrapping, got ${page.lines} lines`);
check(page.words.every((w) => w.x >= 3 - 1e-6 && w.x + w.width <= 60 - 3 + 12), 'words stay on the page');
const again = await writer.write(text, { seed: 11, width: 60 });
check(JSON.stringify(again.words) === JSON.stringify(page.words), 'same seed gives the same page');
const p1 = writer.write(text, { seed: 1 });
writer.cancel();
check((await p1) === null, 'a cancelled write resolves to null');
const svg = toSVG(page);
check(svg.startsWith('<?xml') && svg.includes('<path d="M') && !svg.includes('NaN'), 'SVG export');
fs.writeFileSync(path.join(dir, 'page-writer.svg'), svg);
console.log(JSON.stringify({ words: page.words.length, lines: page.lines, points: page.strokes.reduce((s, q) => s + q.length / 3, 0), ms: Math.round(ms), svg_kb: Math.round(svg.length / 1024), failures }));
process.exit(failures ? 1 : 0);
