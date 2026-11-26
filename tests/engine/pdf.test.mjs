// The PDF writer (web/js/generate/pdf.js), checked without external tools:
// header, objects at their xref offsets, page tree, stream lengths, the text layer.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { HandwritingModel, makeRandom, writePiece } from '../../web/js/engine/engine.js';
import { planDocument, pieceSeed, preparePiece, layoutDocument } from '../../web/js/generate/document.js';
import { pdfBytes, documentToPDF, winAnsi, pdfDate, pdfFileName } from '../../web/js/generate/pdf.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
if (!fs.existsSync(path.join(dir, 'model.json'))) { console.log('SKIP: no fixtures'); process.exit(0); }
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'));
const bin = fs.readFileSync(path.join(dir, 'model.bin'));
const model = new HandwritingModel(manifest, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log('FAIL', msg); } };

check(JSON.stringify(winAnsi('äöüÄÖÜß€')) === '[228,246,252,196,214,220,223,128]', 'umlauts, ß and € in WinAnsi');
check(JSON.stringify(winAnsi('a„b“–😀')) === '[97,132,98,147,150,63]', 'German quotes and dash; other characters become ?');
check(/^D:\d{14}[+-]\d\d'\d\d'$/.test(pdfDate(new Date())), 'PDF date format');
check(pdfFileName(new Date(2026, 10, 26)) === 'handschrift-2026-11-26.pdf', 'file name with the date');

const text = 'Grüße aus Köln, 12,50 €!\nÄrger? Nö.';
const plan = planDocument(text, (t) => model.normalize(t));
const written = plan.pieces.map((p) => preparePiece(writePiece(model, p.text, { bias: 0.4, random: makeRandom(pieceSeed(2, p.index)) }), model.xhModel));
const one = layoutDocument(plan, written, { paper: 'kariert', seed: 2 }, { gapXh: model.gapXh, sizeByBias: manifest.size_by_bias });
// several pages: the same pieces many times
const big = planDocument(Array(110).fill(text.replace('\n', ' ')).join('\n'), (t) => model.normalize(t));
const bigDoc = layoutDocument(big, big.pieces.map((p, i) => written[i % written.length]), { paper: 'liniert', seed: 2 }, { gapXh: model.gapXh, sizeByBias: manifest.size_by_bias });

const latin1 = (u8) => Buffer.from(u8).toString('latin1');

/** Parse and check a PDF; returns { pages, contents: [string] }. */
function inspect(bytes, label) {
  const s = latin1(bytes);
  check(s.startsWith('%PDF-1.4\n%') && bytes[10] > 127, `${label}: header with a binary comment`);
  check(s.endsWith('%%EOF\n'), `${label}: ends with %%EOF`);
  const sx = /startxref\n(\d+)\n%%EOF\n$/.exec(s);
  check(!!sx, `${label}: startxref`);
  const xrefAt = Number(sx[1]);
  check(s.slice(xrefAt, xrefAt + 5) === 'xref\n', `${label}: startxref points at the xref table`);
  const head = /^xref\n0 (\d+)\n/.exec(s.slice(xrefAt));
  const n = Number(head[1]);
  const table = s.slice(xrefAt + head[0].length, xrefAt + head[0].length + 20 * n);
  check(table.slice(0, 20) === '0000000000 65535 f \n', `${label}: free entry 0`);
  const objs = {};
  for (let k = 1; k < n; k++) {
    const e = table.slice(20 * k, 20 * k + 20);
    check(/^\d{10} 00000 n \n$/.test(e), `${label}: xref entry ${k} is 20 bytes`);
    const off = Number(e.slice(0, 10));
    check(s.startsWith(`${k} 0 obj\n`, off), `${label}: object ${k} at its offset`);
    const end = s.indexOf('\nendobj\n', off);
    objs[k] = { off, body: s.slice(off + `${k} 0 obj\n`.length, end), bytesFrom: off + `${k} 0 obj\n`.length };
  }
  const trailer = s.slice(xrefAt + head[0].length + 20 * n);
  check(new RegExp(`/Size ${n} `).test(trailer), `${label}: trailer /Size`);
  const root = Number(/\/Root (\d+) 0 R/.exec(trailer)[1]), info = Number(/\/Info (\d+) 0 R/.exec(trailer)[1]);
  check(/\/Type \/Catalog/.test(objs[root].body), `${label}: root is the catalog`);
  check(/\/Title <FEFF[0-9A-F]+>/.test(objs[info].body) && /\/CreationDate \(D:\d{14}/.test(objs[info].body), `${label}: title and creation date`);
  const pagesObj = Number(/\/Pages (\d+) 0 R/.exec(objs[root].body)[1]);
  const kids = [...objs[pagesObj].body.matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));
  const count = Number(/\/Count (\d+)/.exec(objs[pagesObj].body)[1]);
  check(kids.length === count, `${label}: /Count matches the kids`);
  const contents = [];
  for (const kid of kids) {
    const page = objs[kid].body;
    check(/\/Type \/Page /.test(page) && /\/MediaBox \[0 0 595.28 841.89\]/.test(page), `${label}: A4 page`);
    const c = Number(/\/Contents (\d+) 0 R/.exec(page)[1]);
    const o = objs[c];
    const len = Number(/\/Length (\d+)/.exec(o.body)[1]);
    const start = s.indexOf('stream\n', o.bytesFrom) + 'stream\n'.length;
    check(s.slice(start + len, start + len + '\nendstream'.length) === '\nendstream', `${label}: stream length of object ${c}`);
    const data = bytes.subarray(start, start + len);
    contents.push(/\/FlateDecode/.test(o.body) ? zlib.inflateSync(data).toString('latin1') : latin1(data));
  }
  return { pages: count, contents, objects: n - 1 };
}

const doc = (d, look) => ({ ...d, settings: { ...d.settings, look } });
for (const pen of ['fineliner', 'fueller', 'bleistift']) {
  for (const scheme of ['dark_on_light', 'light_on_dark']) {
    const look = { pen, width: 0.25, paper: 'kariert', scheme, ink: 'blueblack' };
    const bytes = await pdfBytes(doc(one, look), { title: 'Grüße – Test', date: new Date(2026, 10, 26, 9, 5, 0) });
    const r = inspect(bytes, `${pen} ${scheme}`);
    const c = r.contents[0];
    check(r.pages === 1, `${pen} ${scheme}: one page`);
    check((scheme === 'light_on_dark') === / re f/.test(c), `${pen} ${scheme}: background only on dark paper`);
    check(/ m\n/.test(c) && /\nS/.test(c) && /1 J 1 j/.test(c), `${pen} ${scheme}: stroked paths, round caps and joins`);
    if (pen === 'fineliner') check(/ c\n/.test(c), 'fineliner: curves');
    if (pen === 'bleistift') check(/\/G\d+ gs/.test(c) && /\/CA 0\.\d+ \/BM \/(Darken|Lighten)/.test(latin1(bytes)), 'bleistift: tones through ExtGState opacity');
    if (pen === 'fueller') check(new Set([...c.matchAll(/\n([\d.]+) w\n/g)].map((m) => m[1])).size > 2, 'fueller: several widths');
    const nums = c.replace(/\(([^()\\]|\\.)*\)/g, '').match(/-?\d+\.\d+/g) || [];
    check(nums.every((v) => v.split('.')[1].length <= 2), `${pen} ${scheme}: coordinates rounded to 0.01 pt`);
    check(!/NaN|Infinity|undefined/.test(c), `${pen} ${scheme}: no NaN`);
    const tj = [...c.matchAll(/\((([^()\\]|\\.)*)\) Tj/g)].length;
    check(tj === one.pages[0].words.length && /BT 3 Tr/.test(c), `${pen} ${scheme}: one invisible text per word (${tj})`);
    check(c.includes('(Gr\\374\\337e ') && c.includes('\\200'), `${pen} ${scheme}: umlauts, ß and € in the text layer`);
  }
}
{
  // the text layer carries the words as typed: German quotes and the dash survive the model's folding
  const q = planDocument('„Süße Ähre“ – gut', (t) => model.normalize(t));
  const qw = q.pieces.map((p) => preparePiece(writePiece(model, p.text, { bias: 0.4, random: makeRandom(pieceSeed(3, p.index)) }), model.xhModel));
  const qd = layoutDocument(q, qw, { paper: 'liniert', seed: 3 }, { gapXh: model.gapXh, sizeByBias: manifest.size_by_bias });
  const qc = inspect(await pdfBytes(qd, { compress: false }), 'typed text').contents[0];
  check(qc.includes('(\\204S\\374\\337e ') && qc.includes('\\223 ') && qc.includes('(\\226 '), `typed quotes and dash in the text layer (${(qc.match(/\(([^()\\]|\\.)*\) Tj/g) || []).join(' ')})`);
}
const noText = inspect(await pdfBytes(one, { textLayer: false }), 'no text layer');
check(!/BT/.test(noText.contents[0]), 'the text layer can be switched off');
const plain = await pdfBytes(one, { compress: false });
const plainR = inspect(plain, 'uncompressed');
check(!/FlateDecode/.test(latin1(plain)) && /BT 3 Tr/.test(plainR.contents[0]), 'without compression the streams are plain');
const t0 = performance.now();
const many = await pdfBytes(bigDoc, { look: { pen: 'fueller', width: 0.25, scheme: 'dark_on_light', ink: 'blueblack' } });
const ms = performance.now() - t0;
const manyR = inspect(many, 'several pages');
check(manyR.pages === bigDoc.pages.length && manyR.pages >= 3, `several pages: ${manyR.pages} PDF pages for ${bigDoc.pages.length} document pages`);
check(manyR.contents.every((c, i) => [...c.matchAll(/\) Tj/g)].length === bigDoc.pages[i].words.length), 'several pages: every word in the text layer of its page');
const out = await documentToPDF(one);
check(out instanceof Uint8Array, 'documentToPDF gives bytes in Node');

console.log(JSON.stringify({ pages: manyR.pages, kb_per_page: Math.round(many.length / 1024 / manyR.pages), ms_per_page: Math.round(ms / manyR.pages), failures }));
process.exit(failures ? 1 : 0);
