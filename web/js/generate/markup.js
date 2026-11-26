// Typed text with marks -> the document model the page mode lays out.  No DOM.
//
//   parseMarkup(text, 'auto' | 'markdown' | 'latex' | 'text') -> { format, blocks, notes }
//   plainText(doc)    the words without marks (hidden PDF text layer, plain copy)
//
//   Block = { type: 'paragraph' | 'heading' | 'item' | 'rule' | 'pagebreak' | 'blank',
//             level?, marker?: 'bullet' | 'number' | 'check' | 'checked', align?: 'center' | 'right',
//             box?: number, lines: [[Span]] }
//   Span  = { text, bold?, underline?, strike?, mark?, color?, arrow?, part?, body? }   (an arrow span has text '')
//
// A line may have parts: spans with part 'center' or 'right' (none = left), in that
// order, are written on the same line, centred and against the right edge.  In a
// heading the heading part is the centred one, else the left one; the spans of the
// other parts carry body: true and are written as ordinary text.
//
// Markdown: one typed line break is one line on the page, an empty line one empty
// line.  Marks that do not pair up stay as typed.  LaTeX follows TeX instead (lines
// join, \\ breaks, an empty line separates paragraphs).  Nothing in here throws.

const MARK_COLORS = { gelb: 'gelb', yellow: 'gelb', 'grün': 'gruen', gruen: 'gruen', green: 'gruen', rosa: 'rosa', pink: 'rosa', blau: 'blau', blue: 'blau', orange: 'orange' };
const INK_COLORS = {
  rot: 'rot', red: 'rot', blau: 'blau', blue: 'blau', 'grün': 'gruen', gruen: 'gruen', green: 'gruen', schwarz: 'schwarz', black: 'schwarz',
  orange: 'orange', lila: 'lila', violett: 'lila', violet: 'lila', purple: 'lila', grau: 'grau', gray: 'grau', grey: 'grau',
};
const ALIGNS = { mitte: 'center', zentriert: 'center', center: 'center', rechts: 'right', right: 'right', links: 'left', left: 'left' };
const ARROW_CHARS = { '→': 'right', '⟶': 'right', '➔': 'right', '➜': 'right', '⇒': 'double', '⟹': 'double', '←': 'left', '⟵': 'left', '⇐': 'left', '⟸': 'left', '↔': 'both', '⟷': 'both', '⇔': 'both' };
const ARROW_RE = /[→⟶➔➜⇒⟹←⟵⇐⟸↔⟷⇔]/u;
const STYLE_KEYS = ['bold', 'underline', 'strike', 'mark', 'color'];
const SPAN_KEYS = [...STYLE_KEYS, 'part'];
const PART_RANK = { left: 0, center: 1, right: 2 };
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/** 'latex' when the text has \begin{, \section or two known LaTeX commands, else 'markdown'. */
export function detectFormat(text) {
  const s = String(text ?? '');
  if (/\\begin\{|\\(?:sub){0,2}section\*?\s*[{[]/.test(s)) return 'latex';
  let k = 0;
  for (const _ of s.matchAll(LATEX_HINTS)) if (++k >= 2) return 'latex';
  return 'markdown';
}
const LATEX_HINTS = /\\(?:textbf|textit|emph|underline|textcolor|color|hl|sout|item|maketitle|documentclass|usepackage|newpage|clearpage|fbox|boxed|framebox|centering|today|rightarrow|Rightarrow|leftarrow|leftrightarrow|newline|hline|hrule|title|author|chapter|noindent|vspace|ss)(?![a-zA-Z])/g;

/** The document model of a typed text.  `options.today` (a Date) is what \today writes. */
export function parseMarkup(text, format = 'auto', options = {}) {
  const src = clean(text);
  const kind = format === 'auto' || !['markdown', 'latex', 'text'].includes(format) ? detectFormat(src) : format;
  try {
    if (kind === 'text') return { format: 'text', blocks: textBlocks(src), notes: [] };
    const today = options.today instanceof Date ? options.today : new Date();
    if (kind === 'latex') return parseLatex(src, today);
    const st = { notes: new Set(), box: 0, date: notebookDate(today) };
    return { format: 'markdown', blocks: dropTrailingBlanks(markdownBlocks(src.split('\n'), st)), notes: [...st.notes] };
  } catch {
    // A bug here must not cost the user their text: write it as typed.
    return { format: 'text', blocks: textBlocks(src), notes: ['Die Auszeichnung konnte nicht gelesen werden; der Text wird so geschrieben, wie er dasteht.'] };
  }
}

/** The document as plain text: lines as written, no marks; arrows as arrow characters,
 *  list items with their bullet or box and two spaces per nesting level. */
export function plainText(doc) {
  const out = [];
  for (const b of doc?.blocks ?? []) {
    if (b.type === 'blank') { out.push(''); continue; }
    if (b.type === 'rule' || b.type === 'pagebreak') continue;
    // the parts of a line one space apart, in reading order
    const lines = (b.lines ?? []).map((l) => l.map((s, i) => (i && s.part !== l[i - 1].part ? ' ' : '') + (s.arrow ? ARROW_TEXT[s.arrow] ?? '' : s.text)).join(''));
    if (b.type === 'item') {
      const pad = '  '.repeat(Math.max(0, (b.level ?? 1) - 1)), m = MARKER_TEXT[b.marker] ?? '';
      lines.forEach((l, k) => out.push(pad + (k ? ' '.repeat(m.length) : m) + l));
    } else out.push(...lines);
  }
  return out.join('\n');
}
const ARROW_TEXT = { right: '→', left: '←', both: '↔', double: '⇒' };
const MARKER_TEXT = { bullet: '• ', check: '☐ ', checked: '☒ ' };

/** A short German overview of the marks, for the interface. */
export const CHEAT_SHEET = Object.freeze([
  { schreiben: '# Titel', ergebnis: 'Überschrift, größer und unterstrichen; ## und ### kleiner' },
  { schreiben: '- Punkt', ergebnis: 'Aufzählung; zwei Leerzeichen davor rücken eine Ebene ein (bis 3)' },
  { schreiben: '1. Punkt   a) Punkt', ergebnis: 'nummerierte Liste, die Nummer bleibt wie getippt' },
  { schreiben: '- [ ] Aufgabe   - [x] erledigt', ergebnis: 'leeres oder abgehaktes Kästchen' },
  { schreiben: '> Merksatz', ergebnis: 'eingerahmt; Zeilen mit > direkt untereinander teilen einen Rahmen' },
  { schreiben: '**wichtig**', ergebnis: 'kräftiger geschrieben' },
  { schreiben: '*betont*', ergebnis: 'unterstrichen' },
  { schreiben: '==markiert==', ergebnis: 'gelb markiert; ==so=={grün} auch {rosa}, {blau}, {orange}' },
  { schreiben: '~~falsch~~', ergebnis: 'durchgestrichen' },
  { schreiben: '[Text]{rot}', ergebnis: 'in Rot; auch blau, grün, schwarz, orange, lila, grau' },
  { schreiben: '->  =>  <-  <->', ergebnis: 'Pfeile → ⇒ ← ↔' },
  { schreiben: '---', ergebnis: 'Linie über die ganze Breite' },
  { schreiben: '===   oder   {seite}', ergebnis: 'neue Seite' },
  { schreiben: '{mitte} Text   {rechts} Text', ergebnis: 'diese Zeile mittig / rechtsbündig' },
  { schreiben: '{datum} {mitte} Titel {rechts} 7b', ergebnis: 'in einer Zeile: links, Mitte, rechts; mit # davor wird der mittlere Teil zur Überschrift' },
  { schreiben: '{datum}', ergebnis: 'das heutige Datum, z. B. 26.11.2026' },
  { schreiben: '\\*Stern\\*', ergebnis: 'ein \\ davor: das Zeichen bleibt, wie es ist' },
  { schreiben: '\\section{…}  \\textbf{…}  \\item', ergebnis: 'LaTeX wird auch verstanden' },
]);

// ---------- shared ----------

function clean(text) {
  return String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n')
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, (c) => (c === '\f' ? '\n' : ''));
}

function pushSpan(spans, text, style) {
  if (!text && !style.arrow) return;
  const last = spans[spans.length - 1];
  if (!style.arrow && last && !last.arrow && !last.hfill && SPAN_KEYS.every((k) => last[k] === style[k])) { last.text += text; return; }
  const s = { text: style.arrow ? '' : text };
  for (const k of SPAN_KEYS) if (style[k]) s[k] = style[k];
  if (style.arrow) s.arrow = style.arrow;
  spans.push(s);
}

/** Trims a line's ends; drops spans left empty. */
function finishLine(spans) {
  const out = spans.filter((s) => s.arrow || s.text);
  while (out.length && !out[0].arrow) { out[0].text = out[0].text.replace(/^\s+/u, ''); if (out[0].text) break; out.shift(); }
  while (out.length && !out.at(-1).arrow) { const s = out.at(-1); s.text = s.text.replace(/\s+$/u, ''); if (s.text) break; out.pop(); }
  return out;
}

/** A line's spans with parts: every part trimmed, empty parts dropped.  A line left
 *  with only a left part has no parts; with `lone` false a line left with one part of
 *  any kind is an ordinary line aligned as that part ({ spans, align }). */
function finishParts(spans, align, lone = false) {
  const groups = [];
  for (const sp of spans) { if (!groups.length || groups.at(-1).part !== sp.part) groups.push({ part: sp.part, spans: [] }); groups.at(-1).spans.push(sp); }
  const kept = groups.map((g) => ({ part: g.part, spans: finishLine(g.spans) })).filter((g) => g.spans.length);
  if (kept.length === 1 && (!kept[0].part || !lone)) {
    for (const sp of kept[0].spans) delete sp.part;
    return { spans: kept[0].spans, align: kept[0].part || align };
  }
  return { spans: kept.flatMap((g) => g.spans), align: kept.length ? 'left' : align };
}

/** In a heading line with parts, every part but the heading's own is ordinary text. */
function markBody(spans) {
  if (!spans.some((sp) => sp.part)) return spans;
  const head = spans.some((sp) => sp.part === 'center') ? 'center' : undefined;
  for (const sp of spans) if (sp.part !== head) sp.body = true;
  return spans;
}

function notebookDate(d) { return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`; }

function dropTrailingBlanks(blocks) {
  while (blocks.length && blocks.at(-1).type === 'blank') blocks.pop();
  return blocks;
}

function withBox(b, box) { const { lines, ...rest } = b; return { ...rest, box, lines }; }

function textBlocks(src) {
  const blocks = [];
  let para = null;
  for (const raw of src.split('\n')) {
    const line = raw.replace(/\t/g, ' ').trim();
    if (!line) { blocks.push({ type: 'blank', lines: [] }); para = null; continue; }
    if (para) para.lines.push([{ text: line }]);
    else blocks.push(para = { type: 'paragraph', lines: [[{ text: line }]] });
  }
  return dropTrailingBlanks(blocks);
}

// ---------- Markdown: blocks ----------

const BOX = /^ {0,3}>[ \t]?(.*)$/, BOXES = /^(?: {0,3}>[ \t]?)+/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const PAGE = /^ {0,3}(?:={3,}|\{(?:seite|neue ?seite|seitenumbruch)\})[ \t]*$/i;
const HEAD = /^ {0,3}(#{1,6})[ \t]+(.*\S)[ \t]*$/;
const BULLET = /^([ \t]*)([-*+•])[ \t]+(\S.*)$/;
const NUMBER = /^([ \t]*)(\d{1,3}[.)]|[a-zA-Z][.)]|[ivxIVX]{2,4}[.)])[ \t]+(\S.*)$/;
const CHECK = /^\[([ xX])\][ \t]+(\S.*)$/;
const ALIGN = /^[ \t]*\{(mitte|zentriert|center|rechts|right|links|left)\}[ \t]*/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

const cols = (ws) => [...ws].reduce((n, c) => n + (c === '\t' ? 4 : 1), 0);

function markdownBlocks(lines, st) {
  const blocks = [];
  let indents = [];               // list nesting: the indent of every open level
  let open = null;                // 'para' | 'item': what the previous line continued
  const inline = (s) => finishLine(inlineMarkdown(s, st));
  // a line of paragraph or heading text: {mitte} and {rechts} inside it start its parts
  const inlineParts = (s, align) => finishParts(inlineMarkdown(s, st, align), align);
  for (let k = 0; k < lines.length; k++) {
    const raw = lines[k];
    const was = open;
    open = null;
    if (!raw.trim()) { blocks.push({ type: 'blank', lines: [] }); continue; }
    const fence = FENCE.exec(raw);
    if (fence) {
      let e = k + 1;
      while (e < lines.length && !lines[e].trimStart().startsWith(fence[1])) e++;
      if (e < lines.length) {                    // a code block: its lines as typed
        let para = null;
        for (const l of lines.slice(k + 1, e)) {
          const t = l.replace(/\t/g, '    ').trimEnd();
          if (!t.trim()) { blocks.push({ type: 'blank', lines: [] }); para = null; continue; }
          if (para) para.lines.push([{ text: t.trim() }]);
          else blocks.push(para = { type: 'paragraph', lines: [[{ text: t.trim() }]] });
        }
        k = e; indents = [];
        continue;
      }
    }
    if (BOX.test(raw)) {
      const inner = [];
      // "> > x" is one box, not a box in a box (and no recursion as deep as the line is long)
      while (k < lines.length && BOX.test(lines[k])) inner.push(lines[k++].replace(BOXES, ''));
      k--;
      const id = ++st.box, got = dropTrailingBlanks(markdownBlocks(inner, st));
      while (got.length && got[0].type === 'blank') got.shift();
      for (const b of got) blocks.push(withBox(b, id));
      indents = [];
      continue;
    }
    if (RULE.test(raw)) { blocks.push({ type: 'rule', lines: [] }); indents = []; continue; }
    if (PAGE.test(raw)) { blocks.push({ type: 'pagebreak', lines: [] }); indents = []; continue; }
    if (/^\s*\|.*\|\s*$/.test(raw)) st.notes.add('Markdown: Tabellen werden als Text geschrieben');

    const item = listItem(raw);
    if (item) {
      const spans = inline(item.text);
      if (spans.length) {
        while (indents.length && item.indent < indents.at(-1)) indents.pop();
        if (!indents.length || (item.indent > indents.at(-1) && indents.length < 3)) indents.push(item.indent);
        if (item.label) {
          if (!spans[0].arrow && STYLE_KEYS.every((key) => !spans[0][key])) spans[0].text = `${item.label} ${spans[0].text}`;
          else spans.unshift({ text: `${item.label} ` });
        }
        blocks.push({ type: 'item', level: indents.length, marker: item.marker, lines: [spans] });
        open = 'item';
        continue;
      }
    }
    if (was === 'item' && cols(/^[ \t]*/.exec(raw)[0]) >= 2) {      // an indented line goes on with the item
      const spans = inline(raw);
      if (spans.length) blocks.at(-1).lines.push(spans);
      open = 'item';
      continue;
    }
    indents = [];
    let line = raw, align = 'left';
    const am = ALIGN.exec(line);
    if (am) { align = ALIGNS[am[1].toLowerCase()]; line = line.slice(am[0].length); }
    if (!line.trim()) { blocks.push({ type: 'blank', lines: [] }); continue; }
    const h = HEAD.exec(line);
    if (h) {
      let t = h[2].replace(/[ \t]+#+$/, '');
      const am2 = ALIGN.exec(t);
      if (am2) { align = ALIGNS[am2[1].toLowerCase()]; t = t.slice(am2[0].length); }
      const got = inlineParts(t, align), spans = markBody(got.spans);
      align = got.align;
      if (spans.length) {
        const b = { type: 'heading', level: Math.min(h[1].length, 3) };
        if (align !== 'left') b.align = align;
        b.lines = [spans];
        blocks.push(b);
        continue;
      }
    }
    const got = inlineParts(line, align), spans = got.spans;
    align = got.align;
    if (!spans.length) continue;                 // nothing left to write (an image only)
    const prev = blocks.at(-1);
    if (was === 'para' && (prev.align ?? 'left') === align) prev.lines.push(spans);
    else {
      const b = { type: 'paragraph' };
      if (align !== 'left') b.align = align;
      b.lines = [spans];
      blocks.push(b);
    }
    open = 'para';
  }
  return blocks;
}

function listItem(raw) {
  let m = BULLET.exec(raw);
  if (m) {
    const c = CHECK.exec(m[3]);
    if (c) return { indent: cols(m[1]), marker: c[1] === ' ' ? 'check' : 'checked', text: c[2] };
    return { indent: cols(m[1]), marker: 'bullet', text: m[3] };
  }
  m = NUMBER.exec(raw);
  // "z. B. …" and "d. h. …" at the start of a line are abbreviations, not labels.
  if (m && !(/^[a-zA-Z]\.$/.test(m[2]) && /^\p{L}\./u.test(m[3]))) return { indent: cols(m[1]), marker: 'number', label: m[2], text: m[3] };
  return null;
}

// ---------- Markdown: inside a line ----------

const PUNCT = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"]*[^\s<>".,;:!?)\]}'*_~=]/giu;
const DELIMS = ['**', '__', '~~', '==', '*', '_'];
const DELIM_STYLE = { '**': { bold: true }, '__': { bold: true }, '~~': { strike: true }, '==': { mark: 'gelb' }, '*': { underline: true }, '_': { underline: true } };
const ASCII_ARROW = /<-{1,2}>|<={1,2}>|<-{1,2}|-{1,2}>|={1,2}>/y;
const ASCII_KIND = (a) => (a[0] === '<' ? (a.endsWith('>') ? 'both' : 'left') : a.includes('=') ? 'double' : 'right');

/** The spans of a line.  With `start` (the part the line starts in: 'left', 'center'
 *  or 'right') {mitte} and {rechts} start the line's next parts; without it they
 *  stay as typed (list items).  {datum} is today's date everywhere. */
function inlineMarkdown(s, st, start = null) {
  const n = s.length, notes = st.notes;
  let part = start;
  const put = (text, style) => pushSpan(out, text, part && part !== 'left' ? { ...style, part } : style);
  // esc: 1 = a backslash that escapes the next character, 2 = that character
  const esc = new Uint8Array(n);
  for (let i = 0; i < n - 1; i++) if (s[i] === '\\' && PUNCT.test(s[i + 1])) { esc[i] = 1; esc[i + 1] = 2; i++; }
  // Stretches written as typed: web addresses (their _ and * are not marks) and `code`.
  const litEnd = new Int32Array(n).fill(-1), codeAt = new Map(), inLit = new Uint8Array(n);
  for (const m of s.matchAll(URL_RE)) if (!esc[m.index]) { litEnd[m.index] = m.index + m[0].length; inLit.fill(1, m.index, m.index + m[0].length); }
  for (const m of s.matchAll(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g)) {
    if (esc[m.index] || inLit[m.index]) continue;
    codeAt.set(m.index, { end: m.index + m[0].length, text: m[2] });
    inLit.fill(1, m.index, m.index + m[0].length);
  }
  // Every closing position of every mark, so that finding the partner of an opening
  // mark is a binary search: no quadratic time on long lines full of stray marks.
  const closers = {};
  for (const d of DELIMS) closers[d] = [];
  for (let j = 1; j < n; j++) {
    if (esc[j] || inLit[j] || /\s/u.test(s[j - 1])) continue;
    for (const d of DELIMS) {
      if (!s.startsWith(d, j)) continue;
      const after = s[j + d.length];
      if (after === undefined || !WORD.test(after)) closers[d].push(j);
    }
  }
  const nextClose = new Int32Array(n + 1).fill(-1), nextParen = new Int32Array(n + 1).fill(-1);
  for (let i = n - 1; i >= 0; i--) {
    nextClose[i] = s[i] === ']' && !esc[i] ? i : nextClose[i + 1];
    nextParen[i] = s[i] === ')' && !esc[i] ? i : nextParen[i + 1];
  }
  const findCloser = (d, from, to) => {
    const list = closers[d];
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] < from) lo = mid + 1; else hi = mid; }
    return lo < list.length && list[lo] + d.length <= to ? list[lo] : -1;
  };
  const colorAt = (i, to, table) => {
    const m = /^\{([^{}\s]{1,12})\}/u.exec(s.slice(i, Math.min(to, i + 14)));
    const name = m && table[m[1].toLowerCase()];
    return name ? { name, end: i + m[0].length } : null;
  };

  const out = [];
  const walk = (from, to, style) => {
    let buf = '', i = from;
    const flush = () => { if (buf) put(buf, style); buf = ''; };
    while (i < to) {
      const c = s[i];
      if (esc[i] === 1) { buf += i + 1 < to ? s[i + 1] : '\\'; i += 2; continue; }
      if (litEnd[i] > 0 && litEnd[i] <= to) { buf += s.slice(i, litEnd[i]); i = litEnd[i]; continue; }
      const code = codeAt.get(i);
      if (code && code.end <= to) { buf += code.text; i = code.end; continue; }
      if (c === '[' || (c === '!' && s[i + 1] === '[')) {
        const open = c === '!' ? i + 1 : i, j = nextClose[open + 1];
        if (j > 0 && j < to) {
          const color = c === '[' && s[j + 1] === '{' ? colorAt(j + 1, to, { ...MARK_COLORS, ...INK_COLORS }) : null;
          if (color) {
            const ink = Object.prototype.hasOwnProperty.call(INK_COLORS, s.slice(j + 2, color.end - 1).toLowerCase());
            flush(); walk(open + 1, j, ink ? { ...style, color: color.name } : { ...style, mark: color.name });
            i = color.end; continue;
          }
          const p = s[j + 1] === '(' ? nextParen[j + 2] : -1;
          if (p > 0 && p < to) {
            if (c === '!') notes.add('Markdown: Bilder werden nicht geschrieben');
            else { notes.add('Markdown: von Links wird nur der Text geschrieben'); flush(); walk(open + 1, j, style); }
            i = p + 1; continue;
          }
        }
      }
      if (c === '<' || c === '-' || c === '=') {
        ASCII_ARROW.lastIndex = i;
        const m = ASCII_ARROW.exec(s);
        if (m && i + m[0].length <= to && !esc[i + m[0].length - 1]) {
          flush(); put('', { ...style, arrow: ASCII_KIND(m[0]) });
          i += m[0].length; continue;
        }
      }
      if (ARROW_CHARS[c]) { flush(); put('', { ...style, arrow: ARROW_CHARS[c] }); i++; continue; }
      if (c === '{') {
        const m = /^\{(datum|mitte|zentriert|center|rechts|right)\}/i.exec(s.slice(i, i + 11));
        const name = m && m[1].toLowerCase();
        if (name === 'datum') { buf += st.date; i += m[0].length; continue; }
        // a part only moves on to the right: "{rechts} a {mitte} b" keeps the second mark as typed
        if (m && start && PART_RANK[ALIGNS[name]] > PART_RANK[part]) { flush(); part = ALIGNS[name]; i += m[0].length; continue; }
        // the user meant a mark, so say why it is written out instead of hiding it
        if (m) notes.add(start ? 'Markdown: {mitte} und {rechts} stehen in einer Zeile je einmal und in dieser Reihenfolge; eine weitere Marke wird mitgeschrieben'
          : 'Markdown: {mitte} und {rechts} teilen nur Absätze und Überschriften; in Listen werden sie mitgeschrieben');
      }
      const d = (c === '*' || c === '_' || c === '~' || c === '=') && !inLit[i] ? DELIMS.find((x) => s.startsWith(x, i)) : null;
      if (d) {
        const len = d.length, next = s[i + len];
        let j = -1;
        if (next !== undefined && !/\s/u.test(next) && (i === 0 || !WORD.test(s[i - 1]))) j = findCloser(d, i + len + 1, to);
        if (j > 0) {
          // "***x***": the closing run is taken from its end, so the inner mark closes first.
          let run = 0;
          while (s[i + run] === c) run++;
          if (run > len) while (j + len < to && s[j + len] === c && !esc[j + len]) j++;
          let st = { ...style, ...DELIM_STYLE[d] }, end = j + len;
          if (d === '==') { const col = colorAt(end, to, MARK_COLORS); if (col) { st = { ...st, mark: col.name }; end = col.end; } }
          flush(); walk(i + len, j, st);
          i = end; continue;
        }
        buf += d; i += len; continue;
      }
      buf += c === '\t' ? ' ' : c;
      i++;
    }
    flush();
  };
  walk(0, n, {});
  return out;
}

// ---------- LaTeX ----------

const HEADINGS = { part: 1, chapter: 1, section: 1, subsection: 2, subsubsection: 3 };
const ARG_STYLE = {
  textbf: { bold: true }, mathbf: { bold: true }, boldsymbol: { bold: true }, bm: { bold: true },
  emph: { underline: true }, textit: { underline: true }, textsl: { underline: true }, mathit: { underline: true }, underline: { underline: true }, uline: { underline: true },
  hl: { mark: 'gelb' }, highlight: { mark: 'gelb' }, sout: { strike: true }, st: { strike: true }, xout: { strike: true }, cancel: { strike: true },
};
const DECL_STYLE = { bfseries: { bold: true }, bf: { bold: true }, itshape: { underline: true }, slshape: { underline: true }, em: { underline: true }, it: { underline: true }, sl: { underline: true }, normalfont: { bold: undefined, underline: undefined } };
const PASS = new Set('textrm textsf texttt textsc textup textmd textnormal text mbox mathrm mathsf mathtt mathnormal mathcal mathbb operatorname caption textsuperscript textsubscript ensuremath'.split(' '));
const SILENT = new Set(('noindent indent normalsize tiny scriptsize footnotesize small large Large LARGE huge Huge rmfamily sffamily ttfamily mdseries upshape scshape ' +
  'vfill null relax protect displaystyle textstyle left right big Big bigg Bigg nolinebreak nopagebreak raggedbottom flushbottom frenchspacing ' +
  'nonfrenchspacing selectfont phantomsection centerline par appendix frontmatter mainmatter backmatter clearpage').split(' '));
const DROP = new Set(('documentclass usepackage RequirePackage geometry newgeometry restoregeometry pagestyle thispagestyle setlength addtolength setcounter addtocounter ' +
  'definecolor hypersetup graphicspath label pagenumbering bibliographystyle linespread setstretch onehalfspacing doublespacing singlespacing captionsetup lstset ' +
  'thanks setmainfont setsansfont usetikzlibrary').split(' '));
const DROP_NOTE = new Set(('newcommand renewcommand providecommand newenvironment renewenvironment DeclareMathOperator ref eqref pageref autoref cref cite citep citet ' +
  'includegraphics tableofcontents listoffigures listoftables printbibliography bibliography input include footnotemark').split(' '));
const LATEX_ARROWS = {
  rightarrow: 'right', to: 'right', longrightarrow: 'right', mapsto: 'right', leftarrow: 'left', gets: 'left', longleftarrow: 'left', Leftarrow: 'left', Longleftarrow: 'left', impliedby: 'left',
  Rightarrow: 'double', Longrightarrow: 'double', implies: 'double', leftrightarrow: 'both', Leftrightarrow: 'both', longleftrightarrow: 'both', Longleftrightarrow: 'both', iff: 'both',
};
const SYMBOLS = {
  ss: 'ß', SS: 'SS', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', o: 'ø', O: 'Ø', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', i: 'ı',
  euro: '€', EUR: '€', texteuro: '€', S: '§', P: '¶', dots: '…', ldots: '…', cdots: '…', textellipsis: '…', textendash: '–', textemdash: '—',
  glqq: '„', grqq: '“', glq: '‚', grq: '‘', flqq: '«', frqq: '»', textquotedblleft: '“', textquotedblright: '”', textbackslash: '\\', textasciitilde: '~',
  textasciicircum: '^', textunderscore: '_', textbar: '|', LaTeX: 'LaTeX', LaTeXe: 'LaTeX2e', TeX: 'TeX', copyright: '©', textcopyright: '©', textregistered: '®',
  textdegree: '°', degree: '°', checkmark: '✓', times: '×', cdot: '·', pm: '±', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈',
  infty: '∞', textbullet: '•', bullet: '•', quad: ' ', qquad: ' ', enspace: ' ', enskip: ' ', thinspace: ' ', space: ' ', hfil: ' ', dag: '†', percent: '%',
};
// Greek letters: the network cannot write them, so their names are written instead.
const GREEK = new Set(('alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho varrho sigma varsigma ' +
  'tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega').split(' '));
const ACCENTS = { '"': '\u0308', "'": '\u0301', '`': '\u0300', '^': '\u0302', '~': '\u0303', '=': '\u0304', '.': '\u0307', c: '\u0327', v: '\u030C', u: '\u0306', H: '\u030B' };
const GERMAN_SHORT = { a: 'ä', o: 'ö', u: 'ü', A: 'Ä', O: 'Ö', U: 'Ü', s: 'ß', '`': '„', "'": '“', '-': '', '=': '-', '|': '', '~': '-' };
const LIST_ENVS = new Set(['itemize', 'enumerate', 'description', 'compactitem', 'compactenum', 'enumerate*', 'itemize*', 'checklist', 'todolist']);
const ALIGN_ENVS = { center: 'center', flushright: 'right', flushleft: 'left' };
const BOX_ENVS = new Set(['framed', 'mdframed', 'tcolorbox', 'shaded', 'leftbar', 'quote', 'quotation', 'verse', 'boxedminipage', 'fminipage', 'oframed']);
const MATH_ENVS = new Set(['equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*', 'displaymath', 'math', 'eqnarray', 'eqnarray*', 'flalign', 'flalign*']);
const TABLE_ENVS = new Set(['tabular', 'tabular*', 'tabularx', 'array', 'longtable', 'tabulary']);
const QUIET_ENVS = new Set(['document', 'minipage', 'figure', 'figure*', 'table', 'table*', 'abstract', 'wrapfigure', 'small', 'footnotesize', 'large', 'Large', 'raggedright', 'raggedleft', 'titlepage']);
// Groups nested deeper than this are written as their bare text: real documents
// stay far below, and pasted brace soup must not exhaust the call stack.
const MAX_DEPTH = 120;
const VERBATIM_ENVS = new Set(['verbatim', 'verbatim*', 'lstlisting', 'minted', 'Verbatim']);

/** Removes % comments the way TeX does: a line that is only a comment disappears,
 *  a comment after text joins that text to the next line. */
function stripComments(src) {
  const out = [];
  let join = false;
  for (const line of src.split('\n')) {
    let k = -1;
    for (let i = line.indexOf('%'); i >= 0; i = line.indexOf('%', i + 1)) {
      let b = 0;
      while (i - b - 1 >= 0 && line[i - b - 1] === '\\') b++;
      if (b % 2 === 0) { k = i; break; }
    }
    const kept = k >= 0 ? line.slice(0, k) : line;
    if (k >= 0 && !kept.trim()) continue;
    if (join && out.length && line.trim()) out[out.length - 1] += kept.trimStart();
    else out.push(kept);
    join = k >= 0;
  }
  return out.join('\n');
}

/** A LaTeX line with \hfill, plain TeX's way to split a line: "a \hfill b" is left
 *  and right, "a \hfill b \hfill c" left, centre and right.  More of them, and
 *  any in a list item, are spaces. */
function hfillParts(spans, type) {
  const segs = [[]], parts = type === 'paragraph' || type === 'heading';
  for (const sp of spans) {
    if (!sp.hfill) segs.at(-1).push(sp);
    else if (parts && segs.length < 3) segs.push([]);
    else if (!/\s$/u.test(segs.at(-1).at(-1)?.text ?? ' ')) segs.at(-1).push({ text: ' ' });
  }
  if (segs.length === 1) {
    if (!spans.some((sp) => sp.hfill)) return finishLine(spans);
    const out = [];
    for (const sp of segs[0]) pushSpan(out, sp.text, sp);
    return finishLine(out);
  }
  const names = segs.length === 2 ? [undefined, 'right'] : [undefined, 'center', 'right'];
  const out = [];
  segs.forEach((seg, k) => { for (const sp of seg) pushSpan(out, sp.text, names[k] ? { ...sp, part: names[k] } : sp); });
  const got = finishParts(out, 'left', true).spans;
  return type === 'heading' ? markBody(got) : got;
}

function germanDate(d) { return `${d.getDate()}. ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; }

function colorName(raw) { return raw.trim().split('!')[0].toLowerCase(); }

/** Collects blocks: open / close, text with whitespace folded as TeX does. */
function latexBuilder() {
  const blocks = [], lists = [];
  // bare: the line so far is empty or ends in a space, so leading spaces of new text go.
  // Kept as a flag: reading the end of a long concatenated span flattens it every time.
  let cur = null, pendingBlank = false, boxes = 0, bare = true;
  const lineOf = () => cur.lines[cur.lines.length - 1];
  const b = {
    lists,
    newBox: () => ++boxes,
    get cur() { return cur; },
    open(type, ctx, extra = {}) {
      const prev = blocks.at(-1);
      // the empty line is inside a box only when the box goes on on both sides of it
      if (pendingBlank && prev && !['blank', 'pagebreak'].includes(prev.type)) blocks.push(ctx.box && prev.box === ctx.box ? { type: 'blank', box: ctx.box, lines: [] } : { type: 'blank', lines: [] });
      pendingBlank = false;
      cur = { type, ...extra };
      if ((type === 'paragraph' || type === 'heading') && ctx.align !== 'left') cur.align = ctx.align;
      if (ctx.box) cur.box = ctx.box;
      cur.lines = [[]];
      bare = true;
    },
    close() {
      if (!cur) return;
      const block = cur;
      cur = null;
      const lines = block.lines.map((l) => hfillParts(l, block.type));
      while (lines.length && !lines[0].length) lines.shift();
      while (lines.length && !lines.at(-1).length) lines.pop();
      if (!lines.length) return;
      // An empty line inside a block (\\ \\) becomes an empty line between two blocks.
      let part = [];
      const { lines: _, ...attrs } = block;
      const emit = () => { if (part.length) blocks.push({ ...attrs, lines: part }); part = []; };
      for (const l of lines) {
        if (l.length) { part.push(l); continue; }
        if (block.type === 'item') continue;
        if (part.length) { emit(); blocks.push(block.box ? { type: 'blank', box: block.box, lines: [] } : { type: 'blank', lines: [] }); }
      }
      emit();
    },
    text(t, ctx) {
      if (!t) return;
      if (!cur) { if (!t.trim()) return; b.open('paragraph', ctx); }
      const line = lineOf();
      if (bare) t = t.replace(/^\s+/u, '');
      if (!t) return;
      bare = /\s/u.test(t[t.length - 1]);
      if (!ARROW_RE.test(t)) { pushSpan(line, t, ctx.style); return; }
      for (const part of t.split(/([→⟶➔➜⇒⟹←⟵⇐⟸↔⟷⇔])/u)) {
        if (ARROW_CHARS[part]) pushSpan(line, '', { ...ctx.style, arrow: ARROW_CHARS[part] });
        else pushSpan(line, part, ctx.style);
      }
    },
    hfill(ctx) { if (!cur) b.open('paragraph', ctx); lineOf().push({ text: '', hfill: true }); bare = true; },
    arrow(kind, ctx) { if (!cur) b.open('paragraph', ctx); pushSpan(lineOf(), '', { ...ctx.style, arrow: kind }); bare = false; },
    plain(t, ctx) { if (!cur) b.open('paragraph', ctx); pushSpan(lineOf(), t, {}); bare = /\s$/u.test(t); },
    lineBreak() { if (cur) { cur.lines.push([]); bare = true; } },
    trimEnd() { const last = cur && lineOf().at(-1); if (last && !last.arrow) last.text = last.text.replace(/\s+$/u, ''); bare = true; },
    parBreak() {
      if (lists.length) { if (cur?.type === 'item') b.lineBreak(); return; }
      b.close(); pendingBlank = true;
    },
    single(type, ctx) {
      b.close();
      if (pendingBlank && type === 'rule' && blocks.length && !['blank', 'pagebreak'].includes(blocks.at(-1).type)) blocks.push({ type: 'blank', lines: [] });
      pendingBlank = false;
      blocks.push(type === 'rule' && ctx.box ? { type, box: ctx.box, lines: [] } : { type, lines: [] });
    },
    finish() { b.close(); return dropTrailingBlanks(blocks); },
  };
  return b;
}

function parseLatex(src, today) {
  const notes = new Set(), b = latexBuilder(), meta = {}, envs = [];
  let s = stripComments(src), pre = '';
  const start = s.indexOf('\\begin{document}');
  if (start >= 0) {
    pre = s.slice(0, start);
    s = s.slice(start + '\\begin{document}'.length);
    const end = s.indexOf('\\end{document}');
    if (end >= 0) s = s.slice(0, end);
  }
  // "a, "o, "s ... are babel's German shorthands; elsewhere a " stays a quote mark.
  const german = /german/.test(pre) || /\\usepackage(?:\[[^\]]*\])?\{[^}]*german/.test(s);

  const reader = (str) => {
    const n = str.length, match = new Int32Array(n).fill(-1);
    { const stack = [];
      for (let i = 0; i < n; i++) {
        const c = str[i];
        if (c === '\\') { i++; continue; }
        if (c === '{') stack.push(i); else if (c === '}' && stack.length) match[stack.pop()] = i;
      } }
    const skipSpace = (i, to) => {
      let nl = 0;
      while (i < to && (str[i] === ' ' || str[i] === '\t' || (str[i] === '\n' && !nl++))) i++;
      return i;
    };
    const optArg = (i, to) => {
      const j = skipSpace(i, to);
      if (str[j] !== '[') return null;
      let depth = 0;
      for (let k = j + 1; k < Math.min(to, j + 400); k++) {
        const c = str[k];
        if (c === '\\') { k++; continue; }
        if (c === '{') depth++; else if (c === '}') depth--; else if (c === ']' && depth <= 0) return { from: j + 1, to: k, next: k + 1 };
      }
      return null;
    };
    // braceOnly: only a {...} group counts (for commands whose arguments are dropped)
    const reqArg = (i, to, braceOnly = false) => {
      const j = skipSpace(i, to);
      if (j >= to) return null;
      if (str[j] === '{') { const e = match[j] >= 0 && match[j] < to ? match[j] : to; return { from: j + 1, to: e, next: Math.min(e + 1, to) }; }
      if (braceOnly || str[j] === '}') return null;
      if (str[j] === '\\') { const m = /^\\(?:[a-zA-Z]+|.)/.exec(str.slice(j, j + 40)); const e = j + (m ? m[0].length : 1); return { from: j, to: e, next: e }; }
      return { from: j, to: j + 1, next: j + 1 };
    };
    const raw = (a) => (a ? str.slice(a.from, a.to) : '');
    const dropArgs = (i, to) => {
      for (;;) {
        const o = optArg(i, to);
        if (o) { i = o.next; continue; }
        let j = i;
        while (j < to && (str[j] === ' ' || str[j] === '\t')) j++;
        if (str[j] !== '{') return i;
        i = reqArg(j, to).next;
      }
    };
    const inner = (ctx, more = {}) => ({ ...ctx, style: { ...ctx.style }, depth: ctx.depth + 1, ...more });

    const parse = (from, to, ctx) => {
      if (ctx.depth > MAX_DEPTH) { b.text(str.slice(from, to).replace(/\\[a-zA-Z@]+\*?|[\\{}$]/g, ' ').replace(/\s+/g, ' '), ctx); return; }
      let i = from;
      while (i < to) {
        const c = str[i];
        if (c === '\\') { i = command(i, to, ctx); continue; }
        if (c === '{') { const e = match[i] >= 0 && match[i] < to ? match[i] : to; parse(i + 1, e, inner(ctx)); i = e + 1; continue; }
        if (c === '}') { i++; continue; }
        if (c === '$' && !ctx.verbatim) { i = math(i, to, ctx); continue; }
        if (c === '\n') {
          let j = i + 1, nl = 1;
          while (j < to && (str[j] === ' ' || str[j] === '\t' || str[j] === '\n')) { if (str[j] === '\n') nl++; j++; }
          if (nl > 1 && !ctx.math) b.parBreak(); else b.text(' ', ctx);
          i = j; continue;
        }
        if (!ctx.math) {
          if (c === '~') { b.text(' ', ctx); i++; continue; }
          if (c === '-' && str[i + 1] === '-') { const three = str[i + 2] === '-'; b.text(three ? '—' : '–', ctx); i += three ? 3 : 2; continue; }
          if (c === '`') { const two = str[i + 1] === '`'; b.text(two ? '“' : '‘', ctx); i += two ? 2 : 1; continue; }
          if (c === "'" && str[i + 1] === "'") { b.text('”', ctx); i += 2; continue; }
          if (c === '"' && german && GERMAN_SHORT[str[i + 1]] !== undefined) { b.text(GERMAN_SHORT[str[i + 1]], ctx); i += 2; continue; }
        }
        if (c === '&') { b.text(' ', ctx); i++; continue; }
        let j = i + 1;
        while (j < to && !'\\{}$\n~-`\'"&'.includes(str[j])) j++;
        b.text(str.slice(i, j).replace(/[ \t]+/g, ' '), ctx);
        i = j;
      }
    };

    const math = (i, to, ctx) => {
      const display = str[i + 1] === '$', len = display ? 2 : 1;
      let e = i + len - 1;
      do e = str.indexOf(display ? '$$' : '$', e + 1); while (e > 0 && str[e - 1] === '\\');
      if (e < 0 || e >= to) { b.text('$', ctx); return i + 1; }
      parse(i + len, e, inner(ctx, { math: true }));
      return e + len;
    };

    const command = (i, to, ctx) => {
      const d = str[i + 1];
      if (i + 1 >= to) { b.text('\\', ctx); return i + 1; }
      if (d === '\\') {
        b.lineBreak();
        let j = i + 2;
        if (str[j] === '*') j++;
        if (str[j] === '[') { const o = optArg(j, to); if (o) j = o.next; }
        return j;
      }
      if (/[a-zA-Z@]/.test(d)) {
        let j = i + 1;
        while (j < to && /[a-zA-Z@]/.test(str[j])) j++;
        const name = str.slice(i + 1, j);
        if (str[j] === '*') j++;
        return word(name, j, to, ctx);
      }
      if ('%&$#_{}'.includes(d)) { b.text(d, ctx); return i + 2; }
      if (d === '(' || d === '[') {
        const close = d === '(' ? '\\)' : '\\]', e = str.indexOf(close, i + 2);
        if (e < 0 || e >= to) return i + 2;
        parse(i + 2, e, inner(ctx, { math: true }));
        return e + 2;
      }
      if (ACCENTS[d] && !ctx.math) {
        const a = reqArg(i + 2, to);
        if (!a) return i + 2;
        const letter = raw(a).replace(/[{}\\]/g, '');
        b.text((letter.slice(0, 1) + ACCENTS[d]).normalize('NFC') + letter.slice(1), ctx);
        return a.next;
      }
      if (' \t\n,;:>'.includes(d)) { b.text(' ', ctx); return i + 2; }
      if ('!-/@'.includes(d)) return i + 2;
      b.text(d, ctx);
      return i + 2;
    };

    // TeX swallows the spaces after a command word; arguments follow at `j`.
    const word = (name, j, to, ctx) => {
      const eat = (k) => { while (k < to && (str[k] === ' ' || str[k] === '\t')) k++; return k; };
      if (name.length === 1 && ACCENTS[name] && !ctx.math) {             // \c{c}, \v{s}, \u{a}, \H{o}
        const a = reqArg(j, to);
        if (!a) return j;
        const letter = raw(a).replace(/[{}\\]/g, '');
        b.text((letter.slice(0, 1) + ACCENTS[name]).normalize('NFC') + letter.slice(1), ctx);
        return a.next;
      }
      if (Object.prototype.hasOwnProperty.call(HEADINGS, name)) {
        const o = optArg(j, to), a = reqArg(o ? o.next : j, to);
        if (!a) return j;
        b.close();
        b.open('heading', ctx, { level: HEADINGS[name] });
        parse(a.from, a.to, inner(ctx));
        b.close();
        return a.next;
      }
      if (name === 'paragraph' || name === 'subparagraph') {
        const a = reqArg(j, to);
        if (!a) return j;
        b.close();
        parse(a.from, a.to, inner(ctx, { style: { ...ctx.style, bold: true } }));
        b.text(' ', ctx);
        return a.next;
      }
      if (ARG_STYLE[name]) {
        const a = reqArg(j, to);
        if (!a) return j;
        parse(a.from, a.to, inner(ctx, { style: { ...ctx.style, ...ARG_STYLE[name] } }));
        return a.next;
      }
      if (PASS.has(name)) { const a = reqArg(j, to); if (a) parse(a.from, a.to, inner(ctx)); return a ? a.next : j; }
      if (DECL_STYLE[name]) { ctx.style = { ...ctx.style, ...DECL_STYLE[name] }; return eat(j); }
      if (LATEX_ARROWS[name]) { b.arrow(LATEX_ARROWS[name], ctx); return j; }      // the spaces around an arrow stay
      if (GREEK.has(name)) { b.text(name.replace(/^var/, ''), ctx); return j; }
      if (SYMBOLS[name] !== undefined) { b.text(SYMBOLS[name], ctx); return name === 'quad' || name === 'qquad' ? j : eat(j); }
      if (SILENT.has(name)) { if (name === 'par') b.parBreak(); if (name === 'clearpage') b.single('pagebreak', ctx); return eat(j); }
      if (DROP.has(name)) return dropArgs(j, to);
      if (DROP_NOTE.has(name)) { notes.add(`LaTeX: \\${name} wird nicht unterstützt`); return dropArgs(j, to); }
      switch (name) {
        case 'textcolor': case 'colorbox': {
          const o = optArg(j, to), c = reqArg(o ? o.next : j, to), a = c && reqArg(c.next, to);
          if (!a) return c ? c.next : j;
          const col = colorName(raw(c));
          let style = ctx.style;
          if (name === 'colorbox') style = { ...style, mark: MARK_COLORS[col] ?? 'gelb' };
          else if (INK_COLORS[col]) style = { ...style, color: INK_COLORS[col] };
          else notes.add(`LaTeX: die Farbe ${col} gibt es nicht, der Text bleibt schwarz`);
          parse(a.from, a.to, inner(ctx, { style }));
          return a.next;
        }
        case 'color': {
          const o = optArg(j, to), c = reqArg(o ? o.next : j, to);
          if (!c) return j;
          const col = colorName(raw(c));
          if (INK_COLORS[col]) ctx.style = { ...ctx.style, color: INK_COLORS[col] };
          else notes.add(`LaTeX: die Farbe ${col} gibt es nicht, der Text bleibt schwarz`);
          return eat(c.next);
        }
        case 'centering': case 'raggedleft': case 'raggedright': {
          ctx.align = name === 'centering' ? 'center' : name === 'raggedleft' ? 'right' : 'left';
          const cur = b.cur;
          if (cur && (cur.type === 'paragraph' || cur.type === 'heading')) { if (ctx.align === 'left') delete cur.align; else cur.align = ctx.align; }
          return eat(j);
        }
        case 'fbox': case 'boxed': case 'framebox': case 'fcolorbox': {
          let k = j;
          if (name === 'fcolorbox') { const c1 = reqArg(k, to); const c2 = c1 && reqArg(c1.next, to); k = c2 ? c2.next : k; }
          for (let o = optArg(k, to); o; o = optArg(k, to)) k = o.next;
          const a = reqArg(k, to);
          if (!a) return k;
          if (!b.cur) b.open('paragraph', ctx);
          const id = b.newBox();
          b.cur.box = id;
          parse(a.from, a.to, inner(ctx, { box: id }));
          return a.next;
        }
        case 'parbox': case 'makebox': {
          let k = j;
          for (let o = optArg(k, to); o; o = optArg(k, to)) k = o.next;
          if (name === 'parbox') { const w = reqArg(k, to); k = w ? w.next : k; }
          const a = reqArg(k, to);
          if (a) parse(a.from, a.to, inner(ctx));
          return a ? a.next : k;
        }
        case 'href': {
          const u = reqArg(j, to), a = u && reqArg(u.next, to);
          if (a) parse(a.from, a.to, inner(ctx));
          return a ? a.next : u ? u.next : j;
        }
        case 'url': case 'nolinkurl': { const a = reqArg(j, to); if (a) b.text(raw(a), ctx); return a ? a.next : j; }
        case 'verb': {
          const dl = str[j], e = dl ? str.indexOf(dl, j + 1) : -1;
          if (e < 0 || e >= to) return j;
          b.text(str.slice(j + 1, e), ctx);
          return e + 1;
        }
        case 'enquote': case 'footnote': {
          const a = reqArg(j, to);
          if (!a) return j;
          b.text(name === 'enquote' ? '„' : ' (', ctx); parse(a.from, a.to, inner(ctx)); b.text(name === 'enquote' ? '“' : ')', ctx);
          return a.next;
        }
        case 'today': b.text(germanDate(today), ctx); return eat(j);
        case 'hfill': b.hfill(ctx); return eat(j);
        case 'title': case 'author': case 'date': { const a = reqArg(j, to); if (a) meta[name] = { parse, from: a.from, to: a.to, empty: !raw(a).trim() }; return a ? a.next : j; }
        case 'and': b.trimEnd(); b.text(', ', ctx); return eat(j);
        case 'maketitle': title(ctx); return eat(j);
        case 'newline': case 'linebreak': case 'break': { b.lineBreak(); const o = optArg(j, to); return o ? o.next : eat(j); }
        case 'newpage': case 'pagebreak': case 'cleardoublepage': case 'newpage@': { b.single('pagebreak', ctx); const o = optArg(j, to); return o ? o.next : eat(j); }
        case 'hrule': case 'hline': case 'toprule': case 'midrule': case 'bottomrule': case 'rule': case 'hrulefill':
          if (!ctx.table) b.single('rule', ctx);
          return name === 'rule' ? dropArgs(j, to) : eat(j);
        case 'smallskip': case 'medskip': case 'bigskip': b.parBreak(); return eat(j);
        case 'vspace': case 'vskip': b.parBreak(); return dropArgs(j, to);
        case 'hspace': b.text(' ', ctx); return dropArgs(j, to);
        case 'item': {
          const o = optArg(j, to);
          item(o ? raw(o) : null, ctx);
          return o ? o.next : j;
        }
        case 'begin': { const a = reqArg(j, to, true); return a ? begin(raw(a).trim(), a.next, to, ctx) : j; }
        case 'end': { const a = reqArg(j, to, true); if (a) end(raw(a).trim(), ctx); return a ? a.next : j; }
      }
      // Unknown: dropped, the content of its braces kept.
      notes.add(`LaTeX: \\${name} wird nicht unterstützt`);
      let k = j, first = true;
      for (;;) {
        const o = optArg(k, to);
        if (o) { k = o.next; continue; }
        let m = k;
        while (m < to && (str[m] === ' ' || str[m] === '\t')) m++;
        if (str[m] !== '{') break;
        const a = reqArg(m, to);
        if (!first) b.text(' ', ctx);
        parse(a.from, a.to, inner(ctx));
        k = a.next; first = false;
      }
      return first ? eat(k) : k;
    };

    const item = (label, ctx) => {
      b.close();
      const list = b.lists.at(-1);
      const level = Math.min(Math.max(b.lists.length, 1), 3);
      const lab = label == null ? null : label.replace(/\$/g, '').trim();
      if (list?.type === 'description') {
        b.open('paragraph', ctx);
        if (lab) { parseLabel(label, inner(ctx, { style: { ...ctx.style, bold: true } })); b.text(' ', ctx); }
        return;
      }
      let marker = 'bullet', text = null;
      if (lab != null && lab !== '') {
        if (/^\\(?:square|Box|ballotbox|openbox)(?![a-zA-Z])/.test(lab)) marker = 'check';
        else if (/^\\(?:checkmark|boxtimes|CheckedBox|XBox|ballotboxcheck|ballotboxx|blacksquare)(?![a-zA-Z])/.test(lab)) marker = 'checked';
        else if (!/^(?:-{1,3}|–|—|\*|•|\\textbullet|\\bullet|\\cdot|\\textendash|\\ast|\\textasteriskcentered)$/.test(lab)) {
          marker = 'number';
          text = lab.replace(/\\[a-zA-Z]+\*?/g, '').replace(/[{}]/g, '').trim() || lab;
        }
      } else if (list?.type === 'enumerate') {
        list.n++;
        marker = 'number';
        const n = list.n, abc = (base) => String.fromCharCode(base + ((n - 1) % 26));
        text = list.fmt && /\\(?:arabic|alph|Alph|roman|Roman)\*/.test(list.fmt)
          ? list.fmt.replace(/\\arabic\*/g, n).replace(/\\alph\*/g, abc(97)).replace(/\\Alph\*/g, abc(65)).replace(/\\roman\*/g, roman(n)).replace(/\\Roman\*/g, roman(n).toUpperCase()).replace(/[{}$]/g, '')
          : enumLabel(n, b.lists.filter((l) => l.type === 'enumerate').length);
      }
      b.open('item', ctx, { level, marker });
      if (text) b.plain(`${text} `, ctx);
    };
    const parseLabel = (label, ctx) => reader(label).parse(0, label.length, ctx);

    const begin = (name, j, to, ctx) => {
      if (name === 'document') return j;
      if (VERBATIM_ENVS.has(name)) {
        const close = `\\end{${name}}`, e = str.indexOf(close, j);
        const stop = e < 0 || e > to ? to : e;
        b.close();
        const lines = str.slice(j, stop).replace(/^[^\n]*\n/, (m) => (m.trim() ? m : '')).split('\n');
        for (const l of lines) { if (l.trim()) { b.text(l.trim(), ctx); } b.lineBreak(); }
        b.close();
        return e < 0 || e > to ? to : e + close.length;
      }
      envs.push({ name, save: { ...ctx } });
      let k = j;
      if (LIST_ENVS.has(name)) {
        const o = optArg(k, to); if (o) k = o.next;
        b.close();
        // enumitem's label=\alph*) and the like: the counter in the label as written
        const fmt = o && /label\s*=\s*(\{[^{}]*\}|[^,]*)/.exec(str.slice(o.from, o.to));
        b.lists.push({ type: name.startsWith('enum') || name === 'compactenum' ? 'enumerate' : name === 'description' ? 'description' : 'itemize', n: 0, fmt: fmt ? fmt[1].trim().replace(/^\{|\}$/g, '') : null });
        return k;
      }
      if (ALIGN_ENVS[name]) { b.close(); ctx.align = ALIGN_ENVS[name]; return k; }
      if (BOX_ENVS.has(name)) { const o = optArg(k, to); if (o) k = o.next; b.close(); ctx.box = b.newBox(); return k; }
      if (MATH_ENVS.has(name)) { b.close(); ctx.math = true; return k; }
      if (TABLE_ENVS.has(name)) {
        notes.add(`LaTeX: Tabellen (${name}) werden als Text geschrieben`);
        b.close(); ctx.table = true;
        const o = optArg(k, to); if (o) k = o.next;
        const args = name === 'tabular' || name === 'array' || name === 'longtable' ? 1 : 2;
        for (let n = 0; n < args; n++) { const a = reqArg(k, to, true); if (a) k = a.next; }
        return k;
      }
      if (QUIET_ENVS.has(name)) {
        for (let o = optArg(k, to); o; o = optArg(k, to)) k = o.next;
        if (name === 'minipage') { const a = reqArg(k, to, true); if (a) k = a.next; }
        if (name === 'wrapfigure') for (let n = 0; n < 2; n++) { const a = reqArg(k, to, true); if (a) k = a.next; }
        if (name !== 'small' && name !== 'footnotesize' && name !== 'large' && name !== 'Large') b.close();
        return k;
      }
      notes.add(`LaTeX: die Umgebung ${name} wird nicht unterstützt`);
      return k;
    };

    const end = (name, ctx) => {
      if (name === 'document') return;
      let k = envs.length - 1;
      while (k >= 0 && envs[k].name !== name) k--;
      if (k < 0) return;
      const gone = envs.splice(k);
      if (!['small', 'footnotesize', 'large', 'Large'].includes(name)) b.close();
      for (const e of gone) if (LIST_ENVS.has(e.name)) b.lists.pop();
      const { style, ...rest } = gone[0].save;
      Object.assign(ctx, rest, { style });
    };

    const title = (ctx) => {
      b.close();
      if (meta.title && !meta.title.empty) {
        b.open('heading', ctx, { level: 1 });
        meta.title.parse(meta.title.from, meta.title.to, inner(ctx));
        b.close();
      }
      const author = meta.author && !meta.author.empty, date = !meta.date || !meta.date.empty;
      if (author || date) {
        const right = inner(ctx, { align: 'right' });
        b.open('paragraph', right);
        if (author) meta.author.parse(meta.author.from, meta.author.to, right);
        if (author && date) b.text(', ', right);
        if (meta.date) meta.date.parse(meta.date.from, meta.date.to, right);
        else b.text(germanDate(today), right);
        b.close();
      }
    };

    return { parse };
  };

  const ctx0 = () => ({ style: {}, align: 'left', box: 0, math: false, table: false, depth: 0 });
  if (pre) {
    // The preamble: only \title, \author and \date matter; everything else is set-up.
    const r = reader(pre);
    for (const m of pre.matchAll(/\\(title|author|date)(?![a-zA-Z])/g)) {
      const j = m.index + m[0].length;
      let k = j;
      while (k < pre.length && /\s/.test(pre[k])) k++;
      if (pre[k] === '[') { const e = pre.indexOf(']', k); if (e > 0) k = e + 1; while (k < pre.length && /\s/.test(pre[k])) k++; }
      if (pre[k] !== '{') continue;
      let depth = 0, e = k;
      for (; e < pre.length; e++) {
        if (pre[e] === '\\') { e++; continue; }
        if (pre[e] === '{') depth++; else if (pre[e] === '}' && --depth === 0) break;
      }
      meta[m[1]] = { parse: r.parse, from: k + 1, to: Math.min(e, pre.length), empty: !pre.slice(k + 1, e).trim() };
    }
  }
  const body = reader(s);
  body.parse(0, s.length, ctx0());
  return { format: 'latex', blocks: b.finish(), notes: [...notes] };

  function enumLabel(n, depth) {
    if (depth === 2) return `${String.fromCharCode(96 + ((n - 1) % 26) + 1)})`;
    if (depth === 3) return `${roman(n)}.`;
    if (depth >= 4) return `${String.fromCharCode(64 + ((n - 1) % 26) + 1)}.`;
    return `${n}.`;
  }
}

function roman(n) {
  let out = '';
  for (const [v, r] of [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]) while (n >= v) { out += r; n -= v; }
  return out;
}
