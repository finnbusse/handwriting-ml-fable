// A document (document.js) as a vector PDF, written by hand: one A4 page per
// document page, the paper colour, the ruling, the ink as stroked paths in the
// look of the screen (render.js: the same curves, width steps and tones), and an
// invisible text layer so that the PDF can be searched and copied.
//
//   const blob = await documentToPDF(doc, { look, title, date });   // Blob in the browser, Uint8Array in Node
import { normalizeLook, lookColors, toPolylines, penGroups, docWordXh, rulingColor, FUELLER_LEVELS } from './render.js';
import { fuellerWidth, pencilTone, hexRgb, TONES } from '../capture/ink.js';
import { pageLines } from './document.js';

const PT = 72 / 25.4;                   // points per mm
const f2 = (v) => { const r = Math.round(v * 100) / 100; return Object.is(r, -0) ? '0' : String(r); };   // 0.01 pt
const rgb = (hex) => hexRgb(hex).map((v) => f2(v / 255)).join(' ');

// Helvetica advance widths (1/1000 em), WinAnsi codes 32..255; 0 = not in the font.
const HELV = (() => {
  const w = new Array(256).fill(0);
  const ascii = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
    278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722,
    667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556,
    333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
  ascii.forEach((v, i) => { w[32 + i] = v; });
  const hi = { 0x80: 556, 0x82: 222, 0x84: 333, 0x85: 1000, 0x8B: 333, 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0x95: 350, 0x96: 556, 0x97: 1000, 0x9B: 333 };
  Object.entries(hi).forEach(([k, v]) => { w[k] = v; });
  for (let c = 0xA0; c <= 0xFF; c++) {
    const ch = String.fromCharCode(c);
    const base = ch.normalize('NFD')[0];
    w[c] = base !== ch && base.charCodeAt(0) < 128 ? w[base.charCodeAt(0)] : 556;
  }
  w[0xA0] = 278; w[0xDF] = 611; w[0xB0] = 400; w[0xB7] = 278; w[0xAB] = 556; w[0xBB] = 556; w[0xD7] = 584; w[0xF7] = 584;
  return w;
})();
// The WinAnsi codes outside Latin-1 that a German text may use.
const WIN = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‹': 0x8B, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '›': 0x9B };

/** A word as WinAnsi bytes (characters the encoding lacks become '?'). */
export function winAnsi(text) {
  const out = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (WIN[ch] !== undefined) out.push(WIN[ch]);
    else if ((c >= 32 && c < 127) || (c >= 0xA0 && c <= 0xFF)) out.push(c);
    else out.push(63);
  }
  return out;
}
const pdfString = (bytes) => `(${bytes.map((b) => (b === 40 || b === 41 || b === 92 ? `\\${String.fromCharCode(b)}` : b < 32 || b > 126 ? `\\${b.toString(8).padStart(3, '0')}` : String.fromCharCode(b))).join('')})`;

/** Content stream text of one page. */
function pageContent(doc, pageIndex, l, colors, textLayer, gstates) {
  const H = doc.page.height * PT, W = doc.page.width * PT;
  const X = (mm) => f2(mm * PT), Y = (mm) => f2(H - mm * PT);
  const g = doc.geometry, page = doc.pages[pageIndex];
  const out = [];
  if (colors.paper.toUpperCase() !== '#FFFFFF') out.push(`${rgb(colors.paper)} rg 0 0 ${f2(W)} ${f2(H)} re f`);
  const { ys, xs } = g.ruling;
  if (ys.length || xs.length) {
    out.push(`${rgb(rulingColor(doc, colors))} RG ${f2(g.ruling.width * PT)} w 0 J`);
    for (const y of ys) out.push(`0 ${Y(y)} m ${f2(W)} ${Y(y)} l`);
    for (const x of xs) out.push(`${X(x)} 0 m ${X(x)} ${f2(H)} l`);
    out.push('S');
  }
  // Ink: word arrays in the page's x-heights (as the screen draws them), xh -> mm -> pt.
  const xh = g.xh, P = (v) => v * xh;
  const words = page.strokes.map((q) => docWordXh(q, xh));
  const lw = l.width * xh;                                   // mm
  out.push(`1 J 1 j ${rgb(l.pen === 'bleistift' ? colors.graphite : colors.ink)} RG`);
  if (l.pen === 'fineliner') {
    out.push(`${f2(lw * PT)} w`);
    for (const points of words) {
      const path = [];
      for (const line of toPolylines(points)) {
        const p = line.map(([x, y]) => [P(x), P(y)]);
        path.push(`${X(p[0][0])} ${Y(p[0][1])} m`);
        if (p.length === 1) { path.push(`${X(p[0][0] + 0.004)} ${Y(p[0][1])} l`); continue; }
        // The screen's curve: quadratic pieces through the midpoints, as cubics.
        let ax = p[0][0], ay = p[0][1];
        for (let i = 1; i < p.length - 1; i++) {
          const [cx, cy] = p[i], bx = (cx + p[i + 1][0]) / 2, by = (cy + p[i + 1][1]) / 2;
          path.push(`${X(ax + (2 / 3) * (cx - ax))} ${Y(ay + (2 / 3) * (cy - ay))} ${X(bx + (2 / 3) * (cx - bx))} ${Y(by + (2 / 3) * (cy - by))} ${X(bx)} ${Y(by)} c`);
          ax = bx; ay = by;
        }
        const last = p[p.length - 1];
        path.push(`${X(last[0])} ${Y(last[1])} l`);
      }
      if (path.length) out.push(path.join('\n'), 'S');
    }
  } else {
    for (const { key, runs } of penGroups(words, l)) {
      if (l.pen === 'fueller') out.push(`${f2(fuellerWidth(lw, key / FUELLER_LEVELS) * PT)} w`);
      else { out.push(`${f2(lw * PT)} w /${gstates(key)} gs`); }
      const path = [];
      for (const { dot, pts } of runs) {
        path.push(`${X(P(pts[0][0]))} ${Y(P(pts[0][1]))} m`);
        if (dot) path.push(`${X(P(pts[0][0]) + 0.004)} ${Y(P(pts[0][1]))} l`);
        for (let i = 1; i < pts.length; i++) path.push(`${X(P(pts[i][0]))} ${Y(P(pts[i][1]))} l`);
      }
      out.push(path.join('\n'), 'S');
    }
    if (l.pen === 'bleistift') out.push('/GN gs');
  }
  // Text layer: every word invisible (render mode 3) on its baseline, stretched to its
  // width.  Its space is widened (word spacing) to reach the next word: text tools read a
  // gap of 2 em without a glyph as a column break and would put every word on a line.
  if (textLayer && page.words.length) {
    // The font size that fits the median word without stretching: the handwriting is
    // 2-3x as wide as Helvetica at its x-height, and words stretched that much differ
    // too much in size for text tools to see them as one line.
    const em = (w) => winAnsi(w.typed ?? w.text).reduce((s, b) => s + (HELV[b] || 556), 0) / 1000;
    const fits = page.words.filter((w) => em(w) > 0).map((w) => (w.width * PT) / em(w)).sort((a, b) => a - b);
    const size = fits.length ? fits[fits.length >> 1] : xh * PT / 0.523;
    const space = (HELV[32] / 1000) * size;
    out.push(`BT 3 Tr /F1 ${f2(size)} Tf`);
    for (const line of pageLines(page)) {
      line.forEach((w, i) => {
        const bytes = winAnsi(w.typed ?? w.text), adv = em(w) * size;
        const sx = adv > 0 ? (w.width * PT) / adv : 1;
        const next = line[i + 1];
        const tw = next ? Math.max(0, (next.x - w.x - w.width) * PT) / sx - space : 0;
        out.push(`${f2(sx)} 0 0 1 ${X(w.x)} ${Y(w.baseline)} Tm ${f2(tw)} Tw ${pdfString(next ? [...bytes, 32] : bytes)} Tj`);
      });
    }
    out.push('ET');
  }
  return out.join('\n');
}

const enc = new TextEncoder();

async function deflate(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** PDF date string D:YYYYMMDDHHmmSS+hh'mm' in local time. */
export function pdfDate(d) {
  const p = (v) => String(v).padStart(2, '0'), off = -d.getTimezoneOffset();
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}'${p(Math.abs(off) % 60)}'`;
}
const utf16Hex = (s) => `<FEFF${[...s].map((ch) => { const c = ch.codePointAt(0); return c > 0xFFFF ? '003F' : c.toString(16).toUpperCase().padStart(4, '0'); }).join('')}>`;

/**
 * The PDF bytes.  o = { look (default the document's), title, date (Date), textLayer
 * (default the document's setting), compress (default true where the browser can) }.
 */
export async function pdfBytes(doc, { look, title = 'Handschrift', date = new Date(), textLayer, compress = true } = {}) {
  const l = normalizeLook(look || doc.settings.look);
  const colors = lookColors(l);
  const text = textLayer ?? doc.settings.textLayer !== false;
  const objects = [];                     // index + 1 = object number; each a Uint8Array
  const add = (body) => { objects.push(body); return objects.length; };
  const reserve = () => add(null);
  const catalog = reserve(), pages = reserve(), font = reserve(), info = reserve();
  // Bleistift tones: graphite with the tone as opacity; Darken (Lighten on dark paper)
  // so overlapping pieces do not pile up, as on the screen.
  const used = new Set();
  const gstate = (key) => { used.add(key); return `G${key}`; };
  const blend = colors.dark ? '/Lighten' : '/Darken';
  const kids = [];
  const streamObj = async (content) => {
    const raw = enc.encode(content);
    const packed = compress ? await deflate(raw) : null;
    const data = packed || raw;
    const head = enc.encode(`<< /Length ${data.length}${packed ? ' /Filter /FlateDecode' : ''} >>\nstream\n`);
    return concat([head, data, enc.encode('\nendstream')]);
  };
  const pageCount = Math.max(doc.pages.length, 1);
  const contents = [];
  for (let i = 0; i < pageCount; i++) contents.push(doc.pages[i] ? pageContent(doc, i, l, colors, text, gstate) : '');
  const gsDict = [...used].sort((a, b) => a - b).map((k) => `/G${k} << /CA ${f2(pencilTone(Math.min(k, TONES - 1)))} /BM ${blend} >>`).join(' ');
  const resources = `<< /Font << /F1 ${font} 0 R >> /ExtGState << ${gsDict} /GN << /CA 1 /BM /Normal >> >> >>`;
  const mediaBox = `[0 0 ${f2(doc.page.width * PT)} ${f2(doc.page.height * PT)}]`;
  for (const content of contents) {
    const c = add(await streamObj(content));
    kids.push(add(enc.encode(`<< /Type /Page /Parent ${pages} 0 R /MediaBox ${mediaBox} /Resources ${resources} /Contents ${c} 0 R >>`)));
  }
  objects[catalog - 1] = enc.encode(`<< /Type /Catalog /Pages ${pages} 0 R >>`);
  objects[pages - 1] = enc.encode(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  objects[font - 1] = enc.encode('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects[info - 1] = enc.encode(`<< /Title ${utf16Hex(title)} /Creator (Handschrift) /CreationDate (${pdfDate(date)}) >>`);

  // The second line is a comment of bytes above 127: it tells transfer tools the file is binary.
  const parts = [enc.encode('%PDF-1.4\n'), new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A])];
  let offset = parts[0].length + parts[1].length;
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const chunk = concat([enc.encode(`${i + 1} 0 obj\n`), body, enc.encode('\nendobj\n')]);
    parts.push(chunk);
    offset += chunk.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(enc.encode(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return concat(parts);
}

function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** The document as a PDF: a Blob in the browser, a Uint8Array elsewhere. */
export async function documentToPDF(doc, o = {}) {
  const bytes = await pdfBytes(doc, o);
  return typeof document !== 'undefined' ? new Blob([bytes], { type: 'application/pdf' }) : bytes;
}

/** A file name with the date: handschrift-2026-11-26.pdf */
export function pdfFileName(date = new Date()) {
  const p = (v) => String(v).padStart(2, '0');
  return `handschrift-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}.pdf`;
}
