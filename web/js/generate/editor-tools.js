// The page mode's editor (SPEC 2.5.2): mark tools for a touch keyboard, list keys, and
// the editor's layout (hidden beside the pages, large or small under them, above the
// on-screen keyboard).
//
// The text operations are pure: (text, selection start, end, format) -> { text, start,
// end }, in the forms markup.js reads ('markdown' or 'latex').  createEditor binds them
// to the textarea and puts every change in through the browser's own editing, so that
// undo keeps working and the field fires the input event typing fires.

export const TOOLS = ['heading', 'list', 'check', 'bold', 'underline', 'mark', 'color', 'arrow', 'box', 'date', 'center'];

// ---------- edits ----------
// An edit replaces [from, to) with text.  `after`: a position at the edit (an insertion
// point, or inside the replaced text) ends up after the new text, else before it; a line
// prefix keeps the caret after it, a closing mark keeps it before.

function mapPos(q, edits) {
  let d = 0;
  for (const e of edits) {
    const len = e.text.length;
    if (e.to < q || (e.to === q && e.from < q)) { d += len - (e.to - e.from); continue; }
    if (e.from > q) break;
    if (e.from === e.to) { if (e.after) { d += len; continue; } break; }
    return e.from + d + (e.after ? len : 0);
  }
  return q + d;
}

function applyEdits(text, start, end, edits) {
  edits.sort((a, b) => a.from - b.from);
  let out = '', at = 0;
  for (const e of edits) { out += text.slice(at, e.from) + e.text; at = e.to; }
  out += text.slice(at);
  const s = mapPos(start, edits), t = mapPos(end, edits);
  return { text: out, start: Math.min(s, t), end: Math.max(s, t) };
}

/** The lines a selection touches: [{ from, to }] (a selection ending at the start of a
 *  line leaves that line out). */
function linesOf(text, start, end) {
  const a = text.lastIndexOf('\n', start - 1) + 1;
  let b = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const nl = text.indexOf('\n', b);
  b = nl < 0 ? text.length : nl;
  const out = [];
  for (let i = a; ;) {
    const j = text.indexOf('\n', i);
    const to = j < 0 || j > b ? b : j;
    out.push({ from: i, to });
    if (to >= b) break;
    i = to + 1;
  }
  return out;
}

// ---------- Markdown lines ----------

// box, indent, then one of: bullet (+ check box), number, heading hashes; then an alignment
const MD_LINE = /^( {0,3}>[ \t]?)?([ \t]*)(?:([-*+•])[ \t]+(\[[ xX]\](?:[ \t]+|$))?|(\d{1,3}[.)]|[a-zA-Z][.)])[ \t]+|(#{1,6})[ \t]+)?(\{(?:mitte|zentriert|center|rechts|right|links|left)\}[ \t]*)?/i;

function mdLine(text, from, to) {
  const s = text.slice(from, to), m = MD_LINE.exec(s);
  const kind = m[4] ? (/x/i.test(m[4]) ? 'checked' : 'check') : m[3] ? 'bullet' : m[5] ? 'number' : m[6] ? 'heading' : null;
  return {
    from, to, box: m[1] || '', indent: m[2], bullet: m[3] || '-', number: m[5] || '', hashes: m[6] || '#', kind,
    align: m[7] ? m[7].replace(/^\{(\w+)\}.*$/s, '$1').toLowerCase() : '', prefix: m[0].length, body: s.slice(m[0].length),
  };
}
const LIST = new Set(['bullet', 'check', 'checked', 'number']);
const CENTER = new Set(['mitte', 'zentriert', 'center']);

/** The prefix of a parsed line with some of its parts changed (an empty row of a box
 *  among others is a bare >). */
function mdPrefix(l, ch, alone) {
  const p = { ...l, ...ch };
  const marker = p.kind === 'heading' ? `${p.hashes} ` : p.kind === 'bullet' ? `${p.bullet} ` : p.kind === 'check' ? `${p.bullet} [ ] ` : p.kind === 'checked' ? `${p.bullet} [x] ` : p.kind === 'number' ? `${p.number} ` : '';
  const align = p.align ? `{${p.align}} ` : '';
  const box = p.box && !alone && !(marker || align || p.body.trim() || p.indent) ? p.box.replace(/[ \t]+$/, '') : p.box;
  return box + p.indent + marker + align;
}

function mdLineTool(tool, text, start, end) {
  const all = linesOf(text, start, end).map((r) => mdLine(text, r.from, r.to));
  // empty lines take a mark only when they are all there is (a caret on an empty line);
  // a box also takes the empty lines between its rows
  const filled = all.filter((l) => l.body.trim() || l.kind);
  const lines = tool === 'box' || !filled.length ? all : filled;
  const every = (f) => lines.every(f);
  let change;
  if (tool === 'heading') {
    const off = every((l) => l.kind === 'heading');
    change = (l) => (off ? { kind: null, indent: '' } : l.kind === 'heading' ? null : { kind: 'heading', indent: '' });
  } else if (tool === 'list') {
    const off = every((l) => l.kind === 'bullet');
    change = (l) => (off ? { kind: null, indent: '' } : l.kind === 'bullet' ? null : { kind: 'bullet', indent: LIST.has(l.kind) ? l.indent : '', align: '' });
  } else if (tool === 'check') {
    // empty box -> ticked -> no box
    const target = every((l) => l.kind === 'checked') ? null : every((l) => l.kind === 'check' || l.kind === 'checked') ? 'checked' : 'check';
    change = (l) => (target === null ? { kind: null, indent: '' } : target === 'check' && (l.kind === 'check' || l.kind === 'checked') ? null : { kind: target, indent: LIST.has(l.kind) ? l.indent : '', align: '' });
  } else if (tool === 'box') {
    const off = every((l) => l.box);
    change = (l) => (off ? { box: '' } : l.box ? null : { box: '> ' });
  } else if (tool === 'center') {
    const off = every((l) => CENTER.has(l.align));
    change = (l) => (off ? { align: '' } : CENTER.has(l.align) ? null : { align: 'mitte', ...(LIST.has(l.kind) ? { kind: null, indent: '' } : {}) });
  }
  const edits = [];
  for (const l of lines) {
    const ch = change(l);
    if (!ch) continue;
    const pre = mdPrefix(l, ch, lines.length === 1), old = text.slice(l.from, l.from + l.prefix);
    if (pre !== old) edits.push({ from: l.from, to: l.from + l.prefix, text: pre, after: true });
  }
  return applyEdits(text, start, end, edits);
}

// ---------- LaTeX lines ----------

const TEX_ITEM = /^([ \t]*)\\item(?![a-zA-Z])(\[[^\]\n]*\])?[ \t]*/;
const TEX_HEAD = /^([ \t]*)\\(?:sub){0,2}section\*?\{(.*)\}([ \t]*(?:%.*)?)$/;
const TEX_CHECK = { check: '[$\\square$]', checked: '[$\\checkmark$]' };
const texKind = (label) => (!label ? 'bullet' : /\\(?:square|Box)/.test(label) ? 'check' : /\\(?:checkmark|boxtimes)/.test(label) ? 'checked' : 'other');
const TEX_ENV = { box: 'framed', center: 'center' };

function texLineTool(tool, text, start, end) {
  const all = linesOf(text, start, end);
  if (TEX_ENV[tool]) return texEnv(TEX_ENV[tool], text, start, end, all);
  const filled = all.filter((r) => text.slice(r.from, r.to).trim());
  const lines = (filled.length ? filled : all).map((r) => {
    const s = text.slice(r.from, r.to), h = TEX_HEAD.exec(s), it = TEX_ITEM.exec(s);
    return { ...r, s, head: h, item: it, kind: it ? texKind(it[2]) : null };
  });
  const edits = [];
  const setItem = (l, label) => {       // the line's \item (or none) replaced
    const old = l.item ? l.item[0].length : /^[ \t]*/.exec(l.s)[0].length;
    const indent = l.item ? l.item[1] : '';
    const pre = label === null ? indent : `${indent}\\item${label} `;
    if (pre !== l.s.slice(0, old)) edits.push({ from: l.from, to: l.from + old, text: pre, after: true });
  };
  if (tool === 'heading') {
    const off = lines.every((l) => l.head);
    for (const l of lines) {
      if (off) {
        const open = l.s.indexOf('{') + 1, close = l.s.length - l.head[3].length - 1;
        edits.push({ from: l.from, to: l.from + open, text: l.head[1], after: true }, { from: l.from + close, to: l.from + close + 1, text: '', after: false });
      } else if (!l.head) {
        const old = l.item ? l.item[0].length : /^[ \t]*/.exec(l.s)[0].length;
        // the brace closes before a comment; a line whose braces do not pair stays as it is
        const body = /^((?:[^%\\]|\\.)*?)[ \t]*(%.*)?$/s.exec(l.s.slice(old))[1];
        let depth = 0;
        for (let i = 0; i < body.length && depth >= 0; i++) { if (body[i] === '\\') i++; else if (body[i] === '{') depth++; else if (body[i] === '}') depth--; }
        if (depth) continue;
        const close = l.from + old + body.length;
        edits.push({ from: l.from, to: l.from + old, text: '\\section{', after: true }, { from: close, to: close, text: '}', after: false });
      }
    }
  } else if (tool === 'list') {
    const off = lines.every((l) => l.kind === 'bullet');
    for (const l of lines) if (off || l.kind !== 'bullet') setItem(l, off ? null : '');
  } else if (tool === 'check') {
    const target = lines.every((l) => l.kind === 'checked') ? null : lines.every((l) => l.kind === 'check' || l.kind === 'checked') ? 'checked' : 'check';
    for (const l of lines) if (!(target === 'check' && (l.kind === 'check' || l.kind === 'checked'))) setItem(l, target === null ? null : TEX_CHECK[target]);
  }
  return applyEdits(text, start, end, edits);
}

/** Lines wrapped in \begin{env} ... \end{env}, or taken out of it again. */
function texEnv(env, text, start, end, lines) {
  const a = lines[0].from, b = lines[lines.length - 1].to;
  const prevFrom = a > 0 ? text.lastIndexOf('\n', a - 2) + 1 : -1;
  const nextTo = b < text.length ? (text.indexOf('\n', b + 1) < 0 ? text.length : text.indexOf('\n', b + 1)) : -1;
  const begin = `\\begin{${env}}`, close = `\\end{${env}}`;
  if (prevFrom >= 0 && nextTo >= 0 && text.slice(prevFrom, a - 1).trim() === begin && text.slice(b + 1, nextTo).trim() === close) {
    return applyEdits(text, start, end, [{ from: prevFrom, to: a, text: '', after: true }, { from: b, to: nextTo, text: '', after: false }]);
  }
  return applyEdits(text, start, end, [{ from: a, to: a, text: `${begin}\n`, after: true }, { from: b, to: b, text: `\n${close}`, after: false }]);
}

// ---------- marks inside a line ----------

const INK = ['rot', 'blau', 'grün'];
const TEX_INK = { rot: 'red', blau: 'blue', 'grün': 'green' };
const INK_NAMES = 'rot|blau|grün|gruen|schwarz|orange|lila|violett|grau|red|blue|green|black|purple|violet|gray|grey';
// Markdown: [pattern, open, close]; group 1 of a pattern is the marked text (the colour
// pattern also carries the colour's name).  LaTeX: the command that opens the group,
// whose closing brace is found by counting (a group may hold other groups).
const WRAPS = {
  markdown: {
    mark: [/==(?![\s=])(.+?)(?<![\s=\\])==(?:\{[^{}\s]{1,12}\})?/g, '==', '=='],
    color: [new RegExp(`(?<!\\\\)\\[([^\\]\\n]*)\\]\\{(${INK_NAMES})\\}`, 'giu'), '[', ']{rot}'],
  },
  latex: {
    bold: [/\\textbf\{/g, '\\textbf{', '}'],
    underline: [/\\underline\{/g, '\\underline{', '}'],
    mark: [/\\hl\{/g, '\\hl{', '}'],
    color: [new RegExp(`\\\\textcolor\\{(${INK_NAMES})\\}\\{`, 'giu'), '\\textcolor{red}{', '}'],
  },
};
const WORD = /[\p{L}\p{N}_-]/u;
// what markup.js counts as a word: a Markdown mark opens and closes only at its edge
const LETTER = /[\p{L}\p{N}]/u;

/** The part of every touched line that is marked: the selection there, without the
 *  line's prefix and the spaces at its ends, widened to whole words where Markdown needs
 *  it; a caret: its word. */
function segments(text, start, end, tex, whole) {
  const segs = [];
  for (const r of linesOf(text, start, end)) {
    const bodyFrom = r.from + (tex ? (TEX_ITEM.exec(text.slice(r.from, r.to)) || [''])[0].length : mdLine(text, r.from, r.to).prefix);
    let s = Math.max(start, bodyFrom), e = Math.min(end, r.to);
    if (start === end) {
      e = s;
      while (s > bodyFrom && WORD.test(text[s - 1])) s--;
      while (e < r.to && WORD.test(text[e])) e++;
    } else {
      while (s < e && /\s/u.test(text[s])) s++;
      while (e > s && /\s/u.test(text[e - 1])) e--;
      if (s >= e) continue;
      if (whole) {
        while (s > bodyFrom && LETTER.test(text[s - 1]) && LETTER.test(text[s])) s--;
        while (e < r.to && LETTER.test(text[e]) && LETTER.test(text[e - 1])) e++;
      }
    }
    segs.push({ r, bodyFrom, s, e });
  }
  return segs;
}

/** LaTeX groups opened by re in [from, to): { mFrom, mTo, from, to, color }. */
function texGroups(text, from, to, re, color) {
  const out = [];
  for (const m of text.slice(from, to).matchAll(re)) {
    const open = from + m.index + m[0].length;
    let depth = 1, i = open;
    for (; i < to && depth; i++) {
      if (text[i] === '\\') { i++; continue; }
      if (text[i] === '{') depth++; else if (text[i] === '}') depth--;
    }
    if (depth) continue;
    out.push({ mFrom: from + m.index, mTo: i, from: open, to: i - 1, color: color ? m[1].toLowerCase() : null, name: color ? m[1] : null });
  }
  return out;
}

function wrapTool(tool, text, start, end, format) {
  const [re, open, close] = WRAPS[format][tool];
  const tex = format === 'latex', color = tool === 'color';
  // a second tap on a pair just put in at the caret takes it out again
  if (start === end && text.slice(start - open.length, start) === open && text.slice(start, start + close.length) === close) {
    return applyEdits(text, start, end, [{ from: start - open.length, to: start + close.length, text: '', after: true }]);
  }
  const segs = segments(text, start, end, tex, !tex && !color);
  if (!segs.length) return { text, start, end };
  for (const g of segs) {
    const { r } = g;
    let marks;
    if (tex) {
      // a selection that cuts one of these groups takes all of it
      const all = Object.values(WRAPS.latex).flatMap(([x], i) => texGroups(text, r.from, r.to, new RegExp(x.source, x.flags), i === 3));
      for (const m of all) {
        if (m.mFrom < g.s && g.s < m.mTo && g.e > m.mTo) g.s = m.mFrom;
        if (m.mFrom < g.e && g.e < m.mTo && g.s < m.mFrom) g.e = m.mTo;
      }
      marks = texGroups(text, r.from, r.to, new RegExp(re.source, re.flags), color);
    } else {
      marks = [...text.slice(r.from, r.to).matchAll(new RegExp(re.source, re.flags))].map((m) => {
        const mFrom = r.from + m.index;
        return { mFrom, mTo: mFrom + m[0].length, from: mFrom + open.length, to: mFrom + open.length + m[1].length, color: color ? m[2].toLowerCase() : null };
      });
    }
    // the mark around it, if there is one (the innermost)
    g.hit = marks.filter((m) => m.mFrom <= g.s && g.e <= m.mTo).sort((x, y) => (x.mTo - x.mFrom) - (y.mTo - y.mFrom))[0] || null;
  }
  const edits = [];
  const unwrap = (h) => edits.push({ from: h.mFrom, to: h.from, text: '', after: true }, { from: h.to, to: h.mTo, text: '', after: false });
  if (segs.every((g) => g.hit)) {
    if (color) {
      // a colour goes round: rot, blau, grün, then none
      const names = Object.fromEntries(Object.entries(TEX_INK).map(([k, v]) => [v, k]));
      const now = names[segs[0].hit.color] || (segs[0].hit.color === 'gruen' ? 'grün' : segs[0].hit.color);
      const next = INK[INK.indexOf(now) + 1];
      for (const { hit: h } of segs) {
        if (!next) { unwrap(h); continue; }
        const name = tex ? TEX_INK[next] : next;
        const nameFrom = tex ? h.mFrom + '\\textcolor{'.length : h.to + 2, nameTo = tex ? nameFrom + h.name.length : h.mTo - 1;
        edits.push({ from: nameFrom, to: nameTo, text: name, after: !tex });
      }
    } else for (const { hit } of segs) unwrap(hit);
    return applyEdits(text, start, end, edits);
  }
  for (const g of segs) {
    if (g.hit) continue;
    edits.push({ from: g.s, to: g.s, text: open, after: true }, { from: g.e, to: g.e, text: close, after: false });
  }
  const r = applyEdits(text, start, end, edits);
  // a selection now covers what was marked, so a second tap takes it off
  if (start !== end) return { text: r.text, start: mapPos(segs[0].s, edits), end: mapPos(segs[segs.length - 1].e, edits) };
  return r;
}

// ---------- Markdown: ** and * ----------
// Bold and underline share the star: *x* underline, **x** bold, ***x*** both.  A tap
// reads the stars of the stretch it touches into a style per character, changes it, and
// writes the stretch out again in that flat form, so that marks never cut a word or one
// another ("Foto**synth**ese" or "****x****" would be written with their stars).

const B = 2, U = 1;      // the bits are the number of stars: 1 underline, 2 bold, 3 both

/** The star mark that opens at i (the first star of a run), read as markup.js reads it:
 *  { k, end } or null. */
function starSpan(s, i, to) {
  if (i > 0 && (s[i - 1] === '*' || LETTER.test(s[i - 1]))) return null;
  let k = 0;
  while (i + k < to && s[i + k] === '*') k++;
  if (i + k >= to || /\s/u.test(s[i + k])) return null;
  for (let open = Math.min(k, 3); open > 0; open--) {
    for (let p = i + k; p < to; p++) {
      if (s[p] === '\\') { p++; continue; }
      if (s[p] !== '*') continue;
      let q = 0;
      while (p + q < to && s[p + q] === '*') q++;
      if (q >= open && !/\s/u.test(s[p - 1]) && !(p + q < s.length && LETTER.test(s[p + q]))) return { k: open, end: p + q };
      p += q - 1;
    }
  }
  return null;
}

/** The characters of [from, to) without their stars: [{ at, st }]. */
function readStars(s, from, to, st, out) {
  for (let i = from; i < to;) {
    const sp = s[i] === '*' ? starSpan(s, i, to) : null;
    if (sp) { readStars(s, i + sp.k, sp.end - sp.k, st | sp.k, out); i = sp.end; continue; }
    const n = s[i] === '\\' && i + 1 < to ? 2 : 1;
    for (let q = 0; q < n; q++) out.push({ at: i + q, st });
    i += n;
  }
  return out;
}

/** The characters written out with the fewest stars; { text, pos } (pos: where each
 *  character went). */
function writeStars(s, chars) {
  let out = '';
  const pos = new Map();
  for (let i = 0; i < chars.length;) {
    let j = i;
    while (j < chars.length && chars[j].st === chars[i].st) j++;
    const run = chars.slice(i, j), str = run.map((c) => s[c.at]).join('');
    const lead = /^\s*/u.exec(str)[0].length, core = str.trim().length, stars = '*'.repeat(chars[i].st);
    run.forEach((c, n) => pos.set(c.at, out.length + n + (core && n >= lead ? stars.length : 0) + (core && n >= lead + core ? stars.length : 0)));
    out += core && chars[i].st ? str.slice(0, lead) + stars + str.slice(lead, lead + core) + stars + str.slice(lead + core) : str;
    i = j;
  }
  return { text: out, pos };
}

function starTool(tool, text, start, end) {
  const bit = tool === 'bold' ? B : U, open = '*'.repeat(bit);
  if (start === end && text.slice(start - bit, start) === open && text.slice(start, start + bit) === open && text[start - bit - 1] !== '*' && text[start + bit] !== '*') {
    return applyEdits(text, start, end, [{ from: start - bit, to: start + bit, text: '', after: true }]);
  }
  const segs = segments(text, start, end, false, true);
  for (const g of segs) {
    // the stretch: the target and every star mark that touches it
    const spans = [];
    for (let i = g.bodyFrom; i < g.r.to; i++) {
      if (text[i] === '\\') { i++; continue; }
      const sp = text[i] === '*' ? starSpan(text, i, g.r.to) : null;
      if (sp) { spans.push({ from: i, to: sp.end }); i = sp.end - 1; }
    }
    g.a = g.s; g.b = g.e;
    for (const sp of spans) if (sp.from <= g.b && sp.to >= g.a) { g.a = Math.min(g.a, sp.from); g.b = Math.max(g.b, sp.to); }
    // a caret beside a mark, in no word: the mark is the target
    if (g.s === g.e && g.a < g.b) { g.s = g.a; g.e = g.b; }
    g.chars = readStars(text, g.a, g.b, 0, []);
    g.in = (c) => c.at >= g.s && c.at < g.e;
  }
  // a caret in no word, beside no mark: an empty pair, the caret inside
  if (segs.length === 1 && segs[0].s === segs[0].e) {
    return applyEdits(text, start, end, [{ from: start, to: start, text: open, after: true }, { from: start, to: start, text: open, after: false }]);
  }
  const live = segs.filter((g) => g.chars.some((c) => g.in(c) && !/\s/u.test(text[c.at])));
  if (!live.length) return { text, start, end };
  const off = live.every((g) => g.chars.every((c) => !g.in(c) || /\s/u.test(text[c.at]) || c.st & bit));
  const edits = [];
  for (const g of live) {
    for (const c of g.chars) if (g.in(c)) c.st = off ? c.st & ~bit : c.st | bit;
    g.out = writeStars(text, g.chars);
    edits.push({ from: g.a, to: g.b, text: g.out.text });
  }
  const r = applyEdits(text, start, end, edits.map((e) => ({ ...e, after: true })));
  // positions in the new text: the target's first and last character, or the caret
  const shift = (g) => edits.filter((e) => e.from < g.a).reduce((d, e) => d + e.text.length - (e.to - e.from), 0);
  const at = (g, c) => g.a + shift(g) + g.out.pos.get(c.at);
  const first = live[0], last = live[live.length - 1];
  if (start !== end) {
    const a = first.chars.find(first.in), z = last.chars.filter(last.in).pop();
    return { text: r.text, start: at(first, a), end: at(last, z) + 1 };
  }
  const prev = first.chars.find((c) => c.at === start - 1), next = first.chars.find((c) => c.at >= start);
  const p = prev && first.in(prev) ? at(first, prev) + 1 : next ? at(first, next) : first.a + shift(first) + first.out.text.length;
  return { text: r.text, start: p, end: p };
}

// ---------- insertions ----------

/** An arrow or the date, after the selection (which stays as it is). */
function insertTool(tool, text, start, end, format) {
  const tex = format === 'latex';
  const word = tool === 'arrow' ? (tex ? '$\\rightarrow$' : '->') : (tex ? '\\today{}' : '{datum}');
  const before = end > 0 && !/\s/u.test(text[end - 1]) ? ' ' : '';
  const after = text[end] === ' ' ? '' : ' ';
  const out = text.slice(0, end) + before + word + after + text.slice(end);
  const at = end + before.length + word.length + 1;
  return { text: out, start: at, end: at };
}

/** One mark tool on the selection [start, end) of text. */
export function applyTool(tool, text, start, end, format = 'markdown') {
  const f = format === 'latex' ? 'latex' : 'markdown';
  start = Math.max(0, Math.min(start, text.length)); end = Math.max(start, Math.min(end, text.length));
  if ((tool === 'bold' || tool === 'underline') && f === 'markdown') return starTool(tool, text, start, end);
  if (tool === 'bold' || tool === 'underline' || tool === 'mark' || tool === 'color') return wrapTool(tool, text, start, end, f);
  if (tool === 'arrow' || tool === 'date') return insertTool(tool, text, start, end, f);
  if (tool === 'heading' || tool === 'list' || tool === 'check' || tool === 'box' || tool === 'center') return f === 'latex' ? texLineTool(tool, text, start, end) : mdLineTool(tool, text, start, end);
  return { text, start, end };
}

// ---------- keys ----------

const MAX_INDENT = 4;      // two spaces a level; markup.js nests lists 3 levels deep

function nextNumber(n) {
  const m = /^(\d+|[a-zA-Z])([.)])$/.exec(n);
  if (!m) return null;
  if (/\d/.test(m[1])) return `${Number(m[1]) + 1}${m[2]}`;
  return /[zZ]/.test(m[1]) ? null : String.fromCharCode(m[1].charCodeAt(0) + 1) + m[2];
}

/**
 * Enter, Tab, Shift+Tab on list lines: { text, start, end }, or null where the key keeps
 * its own meaning.  key: 'Enter' | 'Tab' | 'ShiftTab'.
 */
export function listKey(key, text, start, end, format = 'markdown') {
  if (format === 'text') return null;
  const tex = format === 'latex';
  if (key === 'Enter') {
    if (start !== end) return null;
    const [r] = linesOf(text, start, start);
    if (tex) {
      const s = text.slice(r.from, r.to), it = TEX_ITEM.exec(s);
      if (!it || start < r.from + it[1].length + '\\item'.length) return null;
      if (!s.slice(it[0].length).trim()) return applyEdits(text, start, end, [{ from: r.from, to: r.to, text: it[1], after: true }]);
      const k = texKind(it[2]), label = k === 'check' || k === 'checked' ? TEX_CHECK.check : '';
      const sp = /^[ \t]*/.exec(text.slice(start, r.to))[0].length;      // no double space before the moved text
      return applyEdits(text, start, end, [{ from: start, to: start + sp, text: `\n${it[1]}\\item${label} `, after: true }]);
    }
    const l = mdLine(text, r.from, r.to);
    if (!LIST.has(l.kind) && !l.box) return null;
    if (start < r.from + l.prefix && (l.body.trim() || l.align)) return null;      // at the start of the item: a plain line break
    if (!l.body.trim()) {
      // an empty item (or an empty box row) ends the list (the box)
      const keep = LIST.has(l.kind) ? l.box : '';
      return applyEdits(text, start, end, [{ from: r.from, to: r.to, text: keep, after: true }]);
    }
    const n = l.kind === 'number' && nextNumber(l.number);
    const marker = l.kind === 'bullet' ? `${l.bullet} ` : l.kind === 'check' || l.kind === 'checked' ? `${l.bullet} [ ] ` : n ? `${n} ` : '';
    const box = l.box ? l.box.replace(/[ \t]*$/, ' ') : '';
    const sp = /^[ \t]*/.exec(text.slice(start, r.to))[0].length;
    return applyEdits(text, start, end, [{ from: start, to: start + sp, text: `\n${box}${l.kind ? l.indent : ''}${marker}`, after: true }]);
  }
  if (tex) return null;
  const lines = linesOf(text, start, end).map((r) => mdLine(text, r.from, r.to)).filter((l) => LIST.has(l.kind));
  if (!lines.length) return null;
  const edits = [];
  for (const l of lines) {
    const at = l.from + l.box.length, n = l.indent.length;
    if (key === 'Tab' && /^ *$/.test(l.indent) && n + 2 <= MAX_INDENT) edits.push({ from: at, to: at, text: '  ', after: false });
    if (key === 'ShiftTab' && n) edits.push({ from: at, to: at + Math.min(2, n), text: '', after: true });
  }
  // a line that cannot move further: the key keeps its meaning (the focus moves on)
  return edits.length ? applyEdits(text, start, end, edits) : null;
}

// ---------- the text field ----------

const STORE_KEY = 'hw.pageEditor';
const WIDE = '(min-width: 900px)';

/**
 * Binds the tools (#pg-marks), the list keys, the layout controls (#pg-editor-btn beside
 * the pages, #pg-size-btn under them) and the keyboard's height to the page mode's
 * textarea.  format() -> 'markdown' | 'latex' | 'text' (the text as it will be read).
 */
export function createEditor({ text, root, format }) {
  const $ = (id) => document.getElementById(id);
  const marks = $('pg-marks'), hideBtn = $('pg-editor-btn'), sizeBtn = $('pg-size-btn');
  const wide = window.matchMedia(WIDE);
  let state = { hidden: false, big: false };
  try { state = { ...state, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') }; } catch (_) { /* defaults */ }

  function layout() {
    if (state.hidden) root.dataset.editor = 'hidden'; else delete root.dataset.editor;
    if (state.big) root.dataset.field = 'big'; else delete root.dataset.field;
    hideBtn.setAttribute('aria-expanded', state.hidden ? 'false' : 'true');
    hideBtn.setAttribute('aria-label', state.hidden ? 'Text einblenden' : 'Text ausblenden');
    hideBtn.title = hideBtn.getAttribute('aria-label');
    sizeBtn.setAttribute('aria-label', state.big ? 'Textfeld verkleinern' : 'Textfeld vergrößern');
    sizeBtn.title = sizeBtn.getAttribute('aria-label');
    sizeBtn.querySelector('use').setAttribute('href', state.big ? '#i-shrink' : '#i-expand');
  }
  function set(ch) {
    state = { ...state, ...ch };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) { /* this visit only */ }
    layout();
  }

  /** A new value put in through the browser's editing (undo, input event), only the part
   *  that changed, then the selection set. */
  function commit(r) {
    const old = text.value;
    if (r.text !== old) {
      let p = 0;
      const n = Math.min(old.length, r.text.length);
      while (p < n && old[p] === r.text[p]) p++;
      let q = 0;
      while (q < n - p && old[old.length - 1 - q] === r.text[r.text.length - 1 - q]) q++;
      const middle = r.text.slice(p, r.text.length - q);
      if (document.activeElement !== text) text.focus({ preventScroll: true });
      text.setSelectionRange(p, old.length - q);
      let done = false;
      try { done = document.execCommand(middle ? 'insertText' : 'delete', false, middle); } catch (_) { done = false; }
      if (!done || text.value !== r.text) {
        // no editing command here: set the value (the browser's undo does not reach this)
        text.setRangeText(middle, p, old.length - q, 'end');
        text.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: middle }));
      }
    }
    text.setSelectionRange(r.start, r.end);
  }

  const fmt = () => { const f = format(); return f === 'latex' || f === 'text' ? f : 'markdown'; };

  // A tap on a tool keeps the focus (and the on-screen keyboard) in the text.
  for (const b of [marks, sizeBtn]) {
    b.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    b.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  }
  marks.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tool]');
    const f = fmt();
    if (!b || f === 'text') return;
    if (document.activeElement !== text) text.focus({ preventScroll: true });
    commit(applyTool(b.dataset.tool, text.value, text.selectionStart, text.selectionEnd, f));
  });

  let shiftEnter = false;
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') shiftEnter = e.shiftKey;
    if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return;
    const r = listKey(e.shiftKey ? 'ShiftTab' : 'Tab', text.value, text.selectionStart, text.selectionEnd, fmt());
    if (!r) return;
    e.preventDefault();
    commit(r);
  });
  // Enter as an edit, not a key: on-screen keyboards send it as one too
  text.addEventListener('beforeinput', (e) => {
    if ((e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph') || e.isComposing) return;
    if (shiftEnter) { shiftEnter = false; return; }
    const r = listKey('Enter', text.value, text.selectionStart, text.selectionEnd, fmt());
    if (!r) return;
    e.preventDefault();
    commit(r);
  });
  // a long paste makes the narrow field large by itself
  text.addEventListener('input', (e) => {
    if (e.inputType === 'insertFromPaste' && !wide.matches && !state.big && text.scrollHeight > text.clientHeight + 4) set({ big: true });
  });
  // Away from the keyboard the small field shows two lines: from the start, not a line cut in half.
  text.addEventListener('blur', () => { if (!wide.matches && !state.big) text.scrollTop = 0; });

  hideBtn.addEventListener('click', () => {
    const inside = document.activeElement === text;
    set({ hidden: !state.hidden });
    if (inside) hideBtn.focus({ preventScroll: true });
  });
  sizeBtn.addEventListener('click', () => set({ big: !state.big }));

  // The on-screen keyboard shortens the visual viewport, not the layout: the page mode
  // ends where the keyboard begins (--pg-kb), the large field is half of what is left
  // (--pg-vh), and the caret is scrolled back into view.
  const vv = window.visualViewport;
  let caretFrame = 0, lastKb = -1;
  function keyboard() {
    // a pinch zoom shortens the visual viewport too, and is no keyboard
    if (!vv || vv.scale > 1.01) return;
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    root.style.setProperty('--pg-kb', `${kb}px`);
    root.style.setProperty('--pg-vh', `${Math.round(vv.height)}px`);
    if (kb > 0) root.dataset.kb = ''; else delete root.dataset.kb;
    const moved = kb !== lastKb;
    lastKb = kb;
    if (!moved || document.activeElement !== text) return;
    cancelAnimationFrame(caretFrame);
    caretFrame = requestAnimationFrame(showCaret);
  }
  /** Scrolls the field so that the caret's line is in view (a textarea does not do this
   *  when it gets shorter): the text up to the caret, wrapped in a hidden copy of the
   *  field, ends at the caret's line. */
  function showCaret() {
    const cs = getComputedStyle(text), lh = parseFloat(cs.lineHeight) || 25;
    const probe = document.createElement('textarea');
    probe.style.cssText = `position:absolute;visibility:hidden;left:-9999px;top:0;height:0;box-sizing:border-box;border:0;overflow:hidden;white-space:pre-wrap;width:${text.clientWidth}px;padding:0 ${cs.paddingRight} 0 ${cs.paddingLeft};font:${cs.font};line-height:${lh}px`;
    probe.value = text.value.slice(0, text.selectionEnd);
    document.body.append(probe);
    const y = Math.max(probe.scrollHeight, lh);
    probe.remove();
    const top = text.scrollTop, h = text.clientHeight - 2 * (parseFloat(cs.paddingTop) || 0);
    if (y > top + h) text.scrollTop = y - h;
    else if (y - lh < top) text.scrollTop = Math.max(0, y - lh);
  }
  if (vv) { vv.addEventListener('resize', keyboard); vv.addEventListener('scroll', keyboard); }

  // The tool row scrolls sideways: the end that runs on out of sight fades out, so that no
  // word looks cut off.
  function edges() {
    const x = marks.scrollLeft, more = marks.scrollWidth - marks.clientWidth;
    marks.dataset.fade = more <= 1 ? '' : (x > 1 ? 'l' : '') + (x < more - 1 ? 'r' : '');
  }
  marks.addEventListener('scroll', edges, { passive: true });
  if (window.ResizeObserver) new ResizeObserver(edges).observe(marks);
  text.addEventListener('blur', (e) => { if (!marks.contains(e.relatedTarget)) { marks.scrollLeft = 0; edges(); } });

  function refresh() { marks.hidden = fmt() === 'text'; edges(); }

  layout();
  refresh();
  keyboard();
  return { refresh, get state() { return { ...state }; } };
}
