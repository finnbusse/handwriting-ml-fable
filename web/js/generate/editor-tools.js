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
const TEX_HEAD = /^([ \t]*)\\(?:sub){0,2}section\*?\{(.*)\}[ \t]*$/;
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
        const open = l.s.indexOf('{') + 1, close = l.s.lastIndexOf('}');
        edits.push({ from: l.from, to: l.from + open, text: l.head[1], after: true }, { from: l.from + close, to: l.to, text: '', after: false });
      } else if (!l.head) {
        const old = l.item ? l.item[0].length : /^[ \t]*/.exec(l.s)[0].length;
        const tail = /[ \t]*$/.exec(l.s)[0].length;
        edits.push({ from: l.from, to: l.from + old, text: '\\section{', after: true }, { from: l.to - tail, to: l.to, text: '}', after: false });
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
// [pattern, open, close]; group 1 of a pattern is the marked text (the colour patterns
// also carry the colour's name)
const WRAPS = {
  markdown: {
    bold: [/\*\*(?![\s*])(.+?)(?<![\s*\\])\*\*/g, '**', '**'],
    underline: [/(?<![*\\])\*(?![\s*])(.+?)(?<![\s*\\])\*(?!\*)/g, '*', '*'],
    mark: [/==(?![\s=])(.+?)(?<![\s=\\])==(?:\{[^{}\s]{1,12}\})?/g, '==', '=='],
    color: [new RegExp(`(?<!\\\\)\\[([^\\]\\n]*)\\]\\{(${INK_NAMES})\\}`, 'giu'), '[', ']{rot}'],
  },
  latex: {
    bold: [/\\textbf\{([^{}\n]*)\}/g, '\\textbf{', '}'],
    underline: [/\\underline\{([^{}\n]*)\}/g, '\\underline{', '}'],
    mark: [/\\hl\{([^{}\n]*)\}/g, '\\hl{', '}'],
    color: [new RegExp(`\\\\textcolor\\{(${INK_NAMES})\\}\\{([^{}\\n]*)\\}`, 'giu'), '\\textcolor{red}{', '}'],
  },
};
const WORD = /[\p{L}\p{N}_-]/u;

function wrapTool(tool, text, start, end, format) {
  const [re, open, close] = WRAPS[format][tool];
  const tex = format === 'latex', color = tool === 'color';
  // the part of every touched line that is marked: the selection there, without the
  // line's prefix and the spaces at its ends; a caret: its word
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
    }
    // the mark around it, if there is one
    let hit = null;
    for (const m of text.slice(r.from, r.to).matchAll(re)) {
      const mFrom = r.from + m.index, mTo = mFrom + m[0].length;
      if (mFrom <= s && e <= mTo) {
        const inner = tex && color ? m[2] : m[1], at = tex && color ? '\\textcolor{'.length + m[1].length + 2 : open.length;
        hit = { mFrom, mTo, from: mFrom + at, to: mFrom + at + inner.length, color: color ? (tex ? m[1] : m[2]).toLowerCase() : null };
        break;
      }
    }
    segs.push({ s, e, hit });
  }
  if (!segs.length) return { text, start, end };
  const edits = [];
  // a second tap on a pair just put in at the caret takes it out again
  if (start === end && text.slice(start - open.length, start) === open && text.slice(start, start + close.length) === close) {
    return applyEdits(text, start, end, [{ from: start - open.length, to: start + close.length, text: '', after: true }]);
  }
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
        const nameFrom = tex ? h.mFrom + '\\textcolor{'.length : h.to + 2, nameTo = tex ? h.from - 2 : h.mTo - 1;
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
  // a selection made on one line now covers what was marked, so a second tap takes it off
  if (start !== end && segs.length === 1) { const g = segs[0]; return { text: r.text, start: mapPos(g.s, edits), end: mapPos(g.e, edits) }; }
  return r;
}

// ---------- insertions ----------

function insertTool(tool, text, start, end, format) {
  const tex = format === 'latex';
  const word = tool === 'arrow' ? (tex ? '$\\rightarrow$' : '->') : (tex ? '\\today{}' : '{datum}');
  const before = start > 0 && !/\s/u.test(text[start - 1]) ? ' ' : '';
  const after = text[end] === ' ' ? '' : ' ';
  const out = text.slice(0, start) + before + word + after + text.slice(end);
  const at = start + before.length + word.length + 1;
  return { text: out, start: at, end: at };
}

/** One mark tool on the selection [start, end) of text. */
export function applyTool(tool, text, start, end, format = 'markdown') {
  const f = format === 'latex' ? 'latex' : 'markdown';
  start = Math.max(0, Math.min(start, text.length)); end = Math.max(start, Math.min(end, text.length));
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
      return applyEdits(text, start, end, [{ from: start, to: start, text: `\n${it[1]}\\item${label} `, after: true }]);
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
    return applyEdits(text, start, end, [{ from: start, to: start, text: `\n${box}${l.kind ? l.indent : ''}${marker}`, after: true }]);
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
  return applyEdits(text, start, end, edits);
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
  let caretFrame = 0;
  function keyboard() {
    if (!vv) return;
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    root.style.setProperty('--pg-kb', `${kb}px`);
    root.style.setProperty('--pg-vh', `${Math.round(vv.height)}px`);
    if (kb > 0) root.dataset.kb = ''; else delete root.dataset.kb;
    if (document.activeElement !== text) return;
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

  function refresh() { marks.hidden = fmt() === 'text'; }

  layout();
  refresh();
  keyboard();
  return { refresh, get state() { return { ...state }; } };
}
