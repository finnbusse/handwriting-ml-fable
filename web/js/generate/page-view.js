// The page mode of Schreiben ("Seite", SPEC 2.5.2): a typed text written onto A4
// pages by several engines at once, shown page by page while it is written, a tap
// on a word writes its piece again, and the pages download as one PDF.
//
// document.js lays out, render.js draws, pdf.js writes the file; all three read the
// same document object, so the pages on the screen are the pages in the PDF.
// view.js owns the model and the shared controls (Stil, Lesbarkeit) and hands them in.
import {
  planDocument, pieceSeed, preparePiece, layoutDocument, wordAt, pieceBoxes, typicalSize,
  PAGE, DOC_PAPERS, DOC_SIZES, TYPICAL_PIECES,
} from './document.js';
import { drawDocumentPage, lookColors } from './render.js';
import { documentToPDF, pdfFileName } from './pdf.js';
import { createEnginePool, poolSize } from './engine-client.js';

export const PAGE_DEFAULTS = Object.freeze({ text: '', paper: 'liniert', size: 'mittel', textLayer: true });
const MAX_PIXELS = 8e6;        // per page canvas; only the pages near the viewport keep theirs
const TAP_MOVE = 10;           // CSS px a tap may move and still count as a tap
const REACH = { touch: 3, pen: 2, mouse: 1.5 };   // mm around a word that still hits it (a finger is wide)

/**
 * deps: { store, model() -> { entry, info, normalizer } | null, look() -> render.js look,
 * bias() -> number, onIdle() (called when nothing is being written any more) }
 */
export function createPageView(deps) {
  const { store, model, look, bias } = deps;
  const $ = (id) => document.getElementById(id);
  const el = {
    stage: $('pg-stage'), pages: $('pg-pages'), empty: $('pg-empty'), pick: $('pg-pick'), redo: $('pg-redo'),
    text: $('pg-text'), write: $('pg-write'), cancel: $('pg-cancel'),
    busy: $('pg-busy'), busyText: $('pg-busy-text'), info: $('pg-info'), bar: $('pg-bar'), fill: $('pg-fill'),
    pdf: $('pg-pdf'), share: $('pg-share'), note: $('pg-note'), chars: $('pg-chars'),
    textLayer: $('pg-textlayer'),
  };
  const P = {
    settings: { ...PAGE_DEFAULTS },
    visible: false, active: false,
    pool: null, poolSha: null,
    run: null,            // { token, text, seed, bias, plan, written, version, typical, info, sizeByBias, start, done, cancelled }
    doc: null, phase: 'idle', rewriting: new Set(), pick: null, follow: true,
    frames: [],           // per page: { wrap, canvas, sig }
    near: new Set(), raf: 0, lastStatus: '',
  };
  let token = 0;

  // ---------- engines ----------

  function ensurePool(m) {
    const sha = m.entry.manifest.sha256;
    if (P.pool && P.poolSha === sha) return P.pool;
    if (P.pool) P.pool.terminate();
    P.pool = createEnginePool(m.entry.manifest, m.entry.buffer, poolSize());
    P.poolSha = sha;
    return P.pool;
  }

  /** A newer model: the engines go; written pages stay as they are. */
  function modelChanged() {
    if (P.phase === 'writing' || P.rewriting.size) return;
    if (P.pool) { P.pool.terminate(); P.pool = null; P.poolSha = null; }
  }

  const busy = () => P.phase === 'writing' || P.rewriting.size > 0;

  // A piece the layout flags (a word off the line or far too tall, document.js:
  // preparePiece) gets one more attempt, with a seed derived from its own, and the
  // one with fewer flags is kept.  About 1.5 % of pieces (3 of ~200 test pieces).
  const RETRY_SALT = 0x2545F491;
  async function writeChecked(pool, r, i, seed, first) {
    const job = { text: r.plan.pieces[i].text, bias: r.bias };
    const w = preparePiece(await pool.writePiece({ ...job, first, seed }), r.info.xhModel);
    if (!w.flags.length) return w;
    r.retried = (r.retried || 0) + 1;
    try {
      const again = preparePiece(await pool.writePiece({ ...job, first: true, seed: (seed ^ RETRY_SALT) >>> 0 }), r.info.xhModel);
      return again.flags.length < w.flags.length ? again : w;
    } catch (_) { return w; }          // cancelled or failed: the first attempt stands
  }

  // ---------- layout ----------

  const docSettings = () => ({
    paper: P.settings.paper, size: P.settings.size, textLayer: P.settings.textLayer,
    bias: P.run ? P.run.bias : bias(), seed: P.run ? P.run.seed : 1,
  });

  /** The pieces written so far laid out with the current paper and size (no writing). */
  function relayout() {
    const r = P.run;
    if (!r) { P.doc = layoutDocument({ paragraphs: [], pieces: [] }, [], docSettings()); return; }
    // The typical size is fixed as soon as the first pieces are there: from then on
    // nothing shown moves while the rest arrives, and a rewrite moves nothing before it.
    if (r.typical === undefined) {
      const need = Math.min(TYPICAL_PIECES, r.plan.pieces.length);
      let have = 0;
      for (let i = 0; i < need; i++) if (r.written[i]) have++;
      if (have === need) r.typical = typicalSize(r.written);
    }
    P.doc = layoutDocument(r.plan, r.written, docSettings(), { gapXh: r.info.gapXh, sizeByBias: r.sizeByBias, typical: r.typical });
  }

  // ---------- drawing ----------

  const dpr = () => window.devicePixelRatio || 1;
  const cssWidth = () => el.pages.clientWidth;
  const cssPerMm = () => cssWidth() / PAGE.width;
  const lookKey = (l) => [l.pen, l.width, l.scheme, l.ink].join('|');

  /** Cheap fingerprint of what a page shows: changes whenever a word is added or moves. */
  function pageSig(page) {
    if (!page) return 'blank';
    let s = 0;
    for (const w of page.words) s = (s * 31 + Math.round(w.x * 100) * 7 + Math.round(w.box[1] * 100) + Math.round(w.box[3] * 100) * 3 + w.piece) % 2147483647;
    return `${page.words.length}:${s}`;
  }

  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      const i = P.frames.findIndex((f) => f.wrap === e.target);
      if (i < 0) continue;
      if (e.isIntersecting) P.near.add(i); else P.near.delete(i);
    }
    schedule();
  }, { root: el.stage, rootMargin: '100% 0px' }) : null;

  function frames(n) {
    while (P.frames.length < n) {
      const wrap = document.createElement('div');
      wrap.className = 'pg-page';
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      wrap.append(canvas);
      el.pages.insertBefore(wrap, el.pick);
      const f = { wrap, canvas, sig: '' };
      P.frames.push(f);
      if (io) io.observe(wrap); else P.near.add(P.frames.length - 1);
    }
    while (P.frames.length > n) {
      const f = P.frames.pop();
      if (io) io.unobserve(f.wrap);
      f.wrap.remove();
      P.near.delete(P.frames.length);
    }
    P.frames.forEach((f, i) => f.wrap.setAttribute('aria-label', `Seite ${i + 1} von ${n}`));
    if (el.empty.parentNode !== P.frames[0].wrap) P.frames[0].wrap.append(el.empty);   // the hint sits in the first page's top margin
  }

  function schedule() {
    if (P.raf || !P.visible) return;
    P.raf = requestAnimationFrame(() => { P.raf = 0; paint(); });
  }

  const markColor = (l) => (l.scheme === 'light_on_dark' ? '#34406A' : '#DCE3F7');

  function paint() {
    if (!P.visible || !P.active) return;
    if (!P.doc) relayout();
    const doc = P.doc;
    const n = Math.max(1, doc.pages.length);
    frames(n);
    const w = cssWidth();
    if (!w) return;
    const l = look();
    const colors = lookColors(l);
    const marks = P.pick ? pieceBoxes(doc, P.pick.piece) : [];
    const ratio = Math.min(dpr(), Math.sqrt(MAX_PIXELS / (w * w * (PAGE.height / PAGE.width))));
    const pw = Math.round(w * ratio), ph = Math.round(pw * PAGE.height / PAGE.width);
    P.frames.forEach((f, i) => {
      if (!P.near.has(i)) {                       // far away: give the memory back
        if (f.canvas.width) { f.canvas.width = 0; f.canvas.height = 0; f.sig = ''; }
        return;
      }
      const mark = marks.filter((b) => b.page === i).map((b) => b.box);
      const sig = [pw, lookKey(l), doc.settings.paper, doc.settings.size, JSON.stringify(mark), pageSig(doc.pages[i])].join('#');
      if (sig === f.sig) return;
      if (f.canvas.width !== pw || f.canvas.height !== ph) { f.canvas.width = pw; f.canvas.height = ph; }
      drawDocumentPage(f.canvas.getContext('2d'), doc, i, { scale: pw / PAGE.width, look: l, colors, mark, markColor: markColor(l) });
      f.sig = sig;
    });
    el.empty.hidden = !!(P.run && doc.placed) || P.phase === 'writing';
    placePick();
    follow();
  }

  /** Redraw everything (look, width or theme changed). */
  function redraw() { for (const f of P.frames) f.sig = ''; schedule(); }

  /** Keep the line being written in view while writing, until the writer scrolls. */
  function follow() {
    if (!P.follow || P.phase !== 'writing' || !P.doc || !P.doc.pages.length) return;
    const pi = P.doc.pages.length - 1, page = P.doc.pages[pi];
    const last = page.words[page.words.length - 1];
    if (!last) return;
    const f = P.frames[pi];
    const y = f.wrap.offsetTop + last.baseline * cssPerMm();
    const room = 3 * P.doc.geometry.pitch * cssPerMm();
    const top = el.stage.scrollTop, bottom = top + el.stage.clientHeight;
    if (y + room > bottom) el.stage.scrollTo({ top: y + room - el.stage.clientHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  // ---------- tap to rewrite ----------

  /** The "Neu schreiben" bar sits next to the marked piece, under or over it, where
   *  it hides the least of the other words (the margins are often free). */
  function placePick() {
    const pick = P.pick && P.doc ? pieceBoxes(P.doc, P.pick.piece) : [];
    if (!pick.length) { el.pick.hidden = true; return; }
    const b = pick[pick.length - 1];
    const f = P.frames[b.page];
    if (!f) { el.pick.hidden = true; return; }
    const k = cssPerMm();
    el.pick.hidden = false;
    const writing = P.rewriting.has(P.pick.piece);
    el.redo.disabled = writing;
    el.redo.querySelector('span').textContent = writing ? 'schreibt …' : 'Neu schreiben';
    el.redo.classList.toggle('writing', writing);
    const bw = el.pick.offsetWidth / k, bh = el.pick.offsetHeight / k;     // mm
    const pad = 0.12 * P.doc.geometry.pitch, gap = 1.5;
    const others = P.doc.pages[b.page].words.filter((w) => w.piece !== P.pick.piece).map((w) => w.box);
    const clampX = (x) => Math.max(1, Math.min(PAGE.width - bw - 1, x));
    const xs = [clampX((b.box[0] + b.box[2]) / 2 - bw / 2), clampX(b.box[0]), clampX(b.box[2] - bw), 1, PAGE.width - bw - 1];
    const ys = [b.box[3] + pad + gap, b.box[1] - pad - gap - bh].filter((y) => y >= 1 && y + bh <= PAGE.height - 1);
    let best = null;
    for (const y of ys.length ? ys : [b.box[3] + pad + gap]) {
      for (const x of xs) {
        let hidden = 0;
        for (const o of others) hidden += Math.max(0, Math.min(x + bw, o[2]) - Math.max(x, o[0])) * Math.max(0, Math.min(y + bh, o[3]) - Math.max(y, o[1]));
        const away = Math.abs(x + bw / 2 - (b.box[0] + b.box[2]) / 2) / PAGE.width;     // nearer the piece wins a tie
        if (!best || hidden + away < best.score) best = { x, y, score: hidden + away };
      }
    }
    el.pick.style.transform = `translate(${Math.round(best.x * k)}px, ${Math.round(f.wrap.offsetTop + best.y * k)}px)`;
  }

  function choose(piece) {
    P.pick = piece === null || (P.pick && P.pick.piece === piece) ? null : { piece };
    schedule();
  }

  function onTap(e, f) {
    if (!P.doc || !P.run) return;
    const i = P.frames.indexOf(f);
    const r = f.wrap.getBoundingClientRect();
    const k = r.width / PAGE.width;
    const hit = wordAt(P.doc, i, (e.clientX - r.left) / k, (e.clientY - r.top) / k, REACH[e.pointerType] || REACH.mouse);
    choose(hit ? hit.piece : null);
  }

  async function rewrite() {
    const r = P.run;
    if (!P.pick || !r) return;
    const i = P.pick.piece;
    if (P.rewriting.has(i)) return;
    const m = model();
    if (!m) return;
    // A piece of another model would not match its neighbours (size, xh unit).
    if (m.entry.manifest.sha256 !== r.sha) { note('Inzwischen ist ein anderes Modell geladen. Bitte schreib den Text neu.'); return; }
    const pool = ensurePool(m);
    const ver = (r.version[i] || 0) + 1;
    r.version[i] = ver;
    P.rewriting.add(i);
    sync();
    try {
      const w = await writeChecked(pool, r, i, pieceSeed(r.seed, i, ver), true);
      if (r === P.run && r.version[i] === ver) { r.written[i] = w; r.done = r.written.filter(Boolean).length; relayout(); }
    } catch (e) {
      if (!e || !e.cancelled) { console.error(e); note('Das Neuschreiben hat nicht geklappt. Bitte versuch es noch einmal.'); }
      if (r.version[i] === ver) r.version[i] = ver - 1;
    }
    P.rewriting.delete(i);
    sync();
    schedule();
    idleCheck();
  }

  // ---------- writing ----------

  const note = (text) => { el.note.textContent = text || ''; el.note.hidden = !text; };
  const charsNote = (list) => {
    const set = [...new Set(list)];
    el.chars.textContent = set.length ? `Diese Zeichen kann ich nicht schreiben und lasse sie weg: ${set.slice(0, 8).map((c) => `„${c}“`).join(', ')}${set.length > 8 ? ' …' : ''}` : '';
    el.chars.hidden = !set.length;
  };

  async function write() {
    const m = model();
    if (!m || P.phase === 'writing') return;
    const text = String(el.text.value || '').replace(/\r\n?/g, '\n');
    note('');
    charsNote(m.normalizer.unsupported(text));
    const plan = planDocument(text, m.normalizer.normalize);
    if (!plan.pieces.length) {
      note(text.trim() ? 'In diesem Text steht nichts, was ich schreiben kann.' : 'Bitte tippe oder füge zuerst einen Text ein.');
      if (!text.trim()) el.text.focus();
      return;
    }
    const mine = ++token;
    const pool = ensurePool(m);
    if (matchMedia('(pointer: coarse)').matches) el.text.blur();      // the keyboard away: the pages are the thing to watch
    P.pick = null;
    P.rewriting.clear();
    P.run = {
      token: mine, sha: m.entry.manifest.sha256, text, seed: (Math.random() * 2 ** 32) >>> 0, bias: bias(), plan,
      written: [], version: [], typical: undefined, info: m.info,
      sizeByBias: m.entry.manifest.size_by_bias || null, start: performance.now(), done: 0, cancelled: false, workers: pool.size,
    };
    const r = P.run;
    P.phase = 'writing'; P.follow = true;
    el.stage.scrollTop = 0;
    relayout();
    sync();
    schedule();
    const jobs = plan.pieces.map((p, i) => writeChecked(pool, r, i, pieceSeed(r.seed, i, 0), false).then((w) => {
      if (r !== P.run || r.version[i]) return;            // replaced meanwhile by a rewrite
      r.written[i] = w;
      r.done = r.written.filter(Boolean).length;
      relayout();
      sync();
      schedule();
    }));
    const outcome = await Promise.allSettled(jobs);
    if (mine !== token) return;
    const failed = outcome.find((o) => o.status === 'rejected' && !(o.reason && o.reason.cancelled));
    if (failed) {
      // A piece failed twice (the pool already retried it and replaced dead engines):
      // stop, and start the next run with fresh engines.
      console.error(failed.reason);
      pool.terminate();
      if (P.pool === pool) { P.pool = null; P.poolSha = null; }
      note('Beim Schreiben ist etwas schiefgegangen. Was bis dahin geschrieben ist, bleibt stehen.');
    } else if (r.cancelled) {
      const kept = P.doc && P.doc.placed ? ' Was schon geschrieben ist, bleibt stehen.' : '';
      note(`${r.dropped ? 'Abgebrochen, auch das Neuschreiben.' : 'Abgebrochen.'}${kept}`);
    }
    r.ms = performance.now() - r.start;
    P.phase = 'idle';
    relayout();
    sync();
    schedule();
    save();
    idleCheck();
  }

  function cancel() {
    if (!busy()) return;
    if (P.run) { P.run.cancelled = true; if (P.rewriting.size) P.run.dropped = true; }
    if (P.pool) P.pool.cancel();
  }

  function idleCheck() { if (!busy() && deps.onIdle) deps.onIdle(); }

  // ---------- status ----------

  function sync() {
    const writing = P.phase === 'writing';
    const r = P.run, doc = P.doc;
    el.write.hidden = writing; el.cancel.hidden = !writing;
    el.write.disabled = writing || !model();
    const pages = doc ? doc.pages.length : 0;
    const canSave = !writing && pages > 0 && !!r && doc.placed > 0;
    el.pdf.disabled = !canSave; el.share.disabled = !canSave;
    el.busy.hidden = !writing;
    el.bar.hidden = !writing;
    let info = '';
    if (writing) {
      const total = r.plan.pieces.length;
      // [text, shown on a phone too]: the narrow form keeps to one line beside the tools
      const parts = [['schreibt … ', false], [`${r.done} von ${total}`, true]];
      if (pages > 1) parts.push([` · Seite ${pages}`, false]);
      // the rate is measured: only once every engine has finished a piece does it mean anything
      if (r.done >= Math.min(total, r.workers) && r.done < total) {
        const s = ((performance.now() - r.start) / r.done) * (total - r.done) / 1000;
        if (s < 50) parts.push([' · noch unter 1 Min.', true]);
        else parts.push([' · noch ', true], ['etwa ', false], [`${Math.max(1, Math.round(s / 60))} Min.`, true]);
      }
      el.busyText.replaceChildren(...parts.map(([t, short]) => { const e = document.createElement('span'); e.textContent = t; if (!short) e.className = 'pg-long'; return e; }));
      el.fill.style.width = `${(100 * r.done) / total}%`;
    } else if (r && doc && doc.placed) {
      info = `${pages === 1 ? '1 Seite' : `${pages} Seiten`} · Ein Wort antippen, um es neu schreiben zu lassen.`;
    }
    el.info.textContent = info;
    el.info.hidden = !info;
    if (deps.onStatus) deps.onStatus(writing || !!info);
    placePick();
  }

  // ---------- PDF ----------

  function title() {
    const line = ((P.run && P.run.text) || '').split('\n').map((s) => s.trim()).find(Boolean) || 'Handschrift';
    const chars = [...line];                          // by characters: never half an emoji
    return chars.length > 60 ? `${chars.slice(0, 59).join('')}…` : line;
  }

  async function pdfFile() {
    const date = new Date();
    const blob = await documentToPDF(P.doc, { look: look(), title: title(), date, textLayer: P.settings.textLayer });
    return { blob, name: pdfFileName(date) };
  }

  async function downloadPdf() {
    if (!P.doc || !P.doc.placed || P.phase === 'writing') return;
    try {
      const { blob, name } = await pdfFile();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch (e) { console.error(e); if (deps.toast) deps.toast('Das PDF konnte nicht erstellt werden.'); }
  }

  async function sharePdf() {
    if (!P.doc || !P.doc.placed || P.phase === 'writing') return;
    try {
      const { blob, name } = await pdfFile();
      await navigator.share({ files: [new File([blob], name, { type: 'application/pdf' })], title: title() });
    } catch (e) { if (e && e.name !== 'AbortError') { console.error(e); if (deps.toast) deps.toast('Teilen hat nicht geklappt. Herunterladen geht immer.'); } }
  }

  const canShareFiles = () => {
    try { return !!(navigator.canShare && navigator.share && navigator.canShare({ files: [new File(['%PDF'], 'x.pdf', { type: 'application/pdf' })] })); } catch (_) { return false; }
  };

  // ---------- settings ----------

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const { paper, size, textLayer } = P.settings;
      store.kvSet('page', { text: el.text.value, paper, size, textLayer }).catch(() => {});
    }, 300);
  }

  /** paper / size: the written pieces are laid out again, nothing is written. */
  function set(key, value) {
    if (key === 'paper' && DOC_PAPERS.includes(value)) P.settings.paper = value;
    else if (key === 'size' && DOC_SIZES.includes(value)) P.settings.size = value;
    else return;
    save();
    relayout();
    sync();
    schedule();
  }

  function autosize() {
    if (!P.visible || !P.active) return;
    el.text.style.height = 'auto';
    el.text.style.height = `${el.text.scrollHeight + 2}px`;
  }

  async function init() {
    try {
      const v = await store.kvGet('page', null);
      if (v && typeof v === 'object') {
        if (typeof v.text === 'string') el.text.value = v.text;
        if (DOC_PAPERS.includes(v.paper)) P.settings.paper = v.paper;
        if (DOC_SIZES.includes(v.size)) P.settings.size = v.size;
        P.settings.textLayer = v.textLayer !== false;
      }
    } catch (_) { /* defaults */ }
    el.textLayer.checked = P.settings.textLayer;
    el.share.hidden = !canShareFiles();
    el.write.addEventListener('click', write);
    el.cancel.addEventListener('click', cancel);
    el.text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); write(); } });
    // maxlength cuts a long paste without a word: say so
    el.text.addEventListener('input', () => { note(el.text.maxLength > 0 && el.text.value.length >= el.text.maxLength ? `Der Text ist auf ${el.text.maxLength.toLocaleString('de-DE')} Zeichen gekürzt.` : ''); autosize(); save(); });
    // Away from the keyboard the field shows two lines: from the start, not a line cut in half.
    el.text.addEventListener('blur', () => { el.text.scrollTop = 0; });
    el.pdf.addEventListener('click', downloadPdf);
    el.share.addEventListener('click', sharePdf);
    el.redo.addEventListener('click', rewrite);
    el.textLayer.addEventListener('change', () => { P.settings.textLayer = el.textLayer.checked; save(); });
    // A tap is a short press that hardly moves (a scroll with the finger is not a tap).
    let down = null;
    el.pages.addEventListener('pointerdown', (e) => {
      const f = P.frames.find((x) => x.wrap.contains(e.target));
      down = f && e.isPrimary ? { f, x: e.clientX, y: e.clientY } : null;
    });
    el.pages.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > TAP_MOVE) { down = null; return; }
      const f = down.f; down = null;
      onTap(e, f);
    });
    el.pages.addEventListener('pointercancel', () => { down = null; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && P.pick && P.active) choose(null); });
    for (const type of ['wheel', 'touchmove']) el.stage.addEventListener(type, () => { P.follow = false; }, { passive: true });
    let lastW = 0;
    new ResizeObserver(() => { const w = cssWidth(); if (w !== lastW) { lastW = w; redraw(); } }).observe(el.pages);
    sync();
  }

  return {
    init, set, redraw, modelChanged, busy, cancel, autosize, sync,
    /** Drop the mark and its "Neu schreiben" bar (Stil opened over the page). */
    unpick() { if (P.pick) choose(null); },
    get settings() { return { ...P.settings }; },
    /** The page mode is the one in use (shown when the tab is shown). */
    activate(on) { P.active = on; if (on) { autosize(); redraw(); } },
    show() { P.visible = true; P.follow = true; autosize(); redraw(); },
    hide() { P.visible = false; },
    debug: () => {
      const r = P.run, d = P.doc;
      return {
        phase: P.phase, rewriting: [...P.rewriting], pick: P.pick ? P.pick.piece : null,
        seed: r ? r.seed : null, total: r ? r.plan.pieces.length : 0, done: r ? r.done : 0, workers: r ? r.workers : 0, ms: r ? r.ms : null, retried: r ? r.retried || 0 : 0,
        versions: r ? r.plan.pieces.map((_, i) => r.version[i] || 0) : [], settings: { ...P.settings },
        pages: d ? d.pages.length : 0, placed: d ? d.placed : 0,
        words: d ? d.pages.flatMap((p, pi) => p.words.map((w) => ({ page: pi, text: w.text, piece: w.piece, line: w.line, x: w.x, baseline: w.baseline, box: w.box }))) : [],
        ink: r ? r.written.map((w) => (w ? w.words.map((x) => Array.from(x.points.slice(0, 12)).map((v) => Math.round(v * 1000))) : null)) : [],
        drawn: P.frames.map((f) => f.canvas.width > 0),
      };
    },
  };
}
