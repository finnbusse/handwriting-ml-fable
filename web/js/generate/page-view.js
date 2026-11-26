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
import { lookColors } from './render.js';
import { documentToPDF, pdfFileName } from './pdf.js';
import { createEnginePool, poolSize } from './engine-client.js';

export const PAGE_DEFAULTS = Object.freeze({ text: '', paper: 'liniert', size: 'mittel', textLayer: true });
const MAX_PIXELS = 8e6;        // per page canvas
// Drawn pages kept when they scroll away, the ones seen last first: a page dropped is drawn
// again on its way back into view (a Bleistift page: 130 ms in the paint worker).  Three is
// as many as are near the viewport at once anyway, so a document of up to three pages is
// drawn once and scrolling through it draws nothing.
const KEEP_PAGES = 3;
const TAP_MOVE = 10;           // CSS px a tap may move and still count as a tap
const REACH = { touch: 3, pen: 2, mouse: 1.5 };   // mm around a word that still hits it (a finger is wide)

/**
 * deps: { store, model() -> { entry, info, normalizer } | null, look() -> render.js look,
 * bias() -> number, painter (paint-worker.js: draws the pages), onIdle() (called when
 * nothing is being written any more) }
 */
export function createPageView(deps) {
  const { store, model, look, bias, painter } = deps;
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
    frames: [],           // per page: { wrap, canvas, id, key, drawn: word keys on the canvas, seen }
    near: new Set(), done: new Set(), seen: 0, raf: 0, lastStatus: '',
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
    P.done.clear();
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
  /** A word as laid out: the same key is the same ink at the same place.  While a text is
   *  written the words on a page only ever grow at its end (document.js), so a page draws
   *  just its new words; anything else (a rewrite, other paper) draws the page anew. */
  const wordKeys = (page) => (page ? page.words.map((w, k) => `${w.piece}.${w.word}.${page.strokes[k].length}.${Math.round(w.x * 100)}.${Math.round(w.box[1] * 100)}.${Math.round(w.box[2] * 100)}.${Math.round(w.box[3] * 100)}`) : []);

  // Pages near the viewport (one screen height around it) are drawn; P.done holds the pages
  // whose canvas shows the current document and look, so scrolling past drawn pages runs no
  // drawing at all.
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
    let need = false;
    for (const e of entries) {
      const i = P.frames.findIndex((f) => f.wrap === e.target);
      if (i < 0) continue;
      if (e.isIntersecting) { P.near.add(i); P.frames[i].seen = ++P.seen; if (!P.done.has(i)) need = true; } else P.near.delete(i);
    }
    if (need) schedule();
  }, { root: el.stage, rootMargin: '100% 0px' }) : null;

  function frames(n) {
    while (P.frames.length < n) {
      const wrap = document.createElement('div');
      wrap.className = 'pg-page';
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      wrap.append(canvas);
      el.pages.insertBefore(wrap, el.pick);
      const f = { wrap, canvas, id: `page${P.frames.length}`, key: '', drawn: [], seen: 0 };
      painter.attach(f.id, canvas);
      P.frames.push(f);
      if (io) io.observe(wrap); else P.near.add(P.frames.length - 1);
    }
    while (P.frames.length > n) {
      const f = P.frames.pop();
      painter.run([{ op: 'free', id: f.id }]);
      if (io) io.unobserve(f.wrap);
      f.wrap.remove();
      P.near.delete(P.frames.length); P.done.delete(P.frames.length);
    }
    P.frames.forEach((f, i) => f.wrap.setAttribute('aria-label', `Seite ${i + 1} von ${n}`));
    if (el.empty.parentNode !== P.frames[0].wrap) P.frames[0].wrap.append(el.empty);   // the hint sits in the first page's top margin
  }

  function schedule() {
    if (P.raf || !P.visible) return;
    P.raf = requestAnimationFrame(() => { P.raf = 0; paint(); });
  }

  function paint() {
    if (!P.visible || !P.active) return;
    if (!P.doc) relayout();
    const doc = P.doc;
    const n = Math.max(1, doc.pages.length);
    frames(n);
    const w = cssWidth();
    if (!w) return;
    const l = look();
    const ratio = Math.min(dpr(), Math.sqrt(MAX_PIXELS / (w * w * (PAGE.height / PAGE.width))));
    const pw = Math.round(w * ratio);
    const o = { doc, pw, ph: Math.round(pw * PAGE.height / PAGE.width), look: l, colors: lookColors(l), key: [pw, lookKey(l), doc.settings.paper, doc.settings.size].join('#') };
    // the pages on the screen first, then the ones about to come into view
    const mid = el.stage.scrollTop + el.stage.clientHeight / 2;
    const away = (i) => { const f = P.frames[i].wrap; return Math.max(0, f.offsetTop - mid, mid - f.offsetTop - f.offsetHeight); };
    for (const i of [...P.near].filter((k) => k < n && !P.done.has(k)).sort((a, b) => away(a) - away(b))) drawPage(i, o);
    keep();
    el.empty.hidden = !!(P.run && doc.placed) || P.phase === 'writing';
    placeMarks();
    placePick();
    follow();
  }

  /** Bring page i up to date: its new words only, or the whole page when anything else
   *  changed (ink cannot be taken off a canvas).  The steps of one page are drawn together,
   *  so the page never shows half a redraw. */
  function drawPage(i, o) {
    const f = P.frames[i];
    const page = o.doc.pages[i];
    const words = wordKeys(page);
    const scale = o.pw / PAGE.width;
    const steps = [];
    if (!(f.key === o.key && f.drawn.length <= words.length && f.drawn.every((k, j) => k === words[j]))) {
      steps.push({ op: 'size', id: f.id, w: o.pw, h: o.ph }, { op: 'page', id: f.id, doc: { page: o.doc.page, geometry: o.doc.geometry }, scale, look: o.look, colors: o.colors });
      f.key = o.key; f.drawn = [];
    }
    if (page && f.drawn.length < words.length) {
      steps.push({ op: 'words', id: f.id, words: page.strokes.slice(f.drawn.length), xh: o.doc.geometry.xh, scale, look: o.look, colors: o.colors });
      f.drawn = words;
    }
    painter.run(steps);
    P.done.add(i);
  }

  /** Pages that scrolled away keep their canvas, KEEP_PAGES in all, the ones seen last
   *  first; the others give their memory back. */
  function keep() {
    const kept = P.frames.map((f, i) => ({ f, i })).filter(({ f }) => f.key);
    if (kept.length <= KEEP_PAGES) return;
    kept.sort((a, b) => (P.near.has(b.i) - P.near.has(a.i)) || b.f.seen - a.f.seen);
    for (const { f, i } of kept.slice(KEEP_PAGES)) {
      if (P.near.has(i)) continue;
      painter.run([{ op: 'free', id: f.id }]);
      f.key = ''; f.drawn = [];
      P.done.delete(i);
    }
  }

  // The piece picked for rewriting is marked by boxes laid over the page, blended so that
  // the ink stays on top: picking a word redraws nothing.
  let marksKey = '';
  function placeMarks() {
    const boxes = P.pick && P.doc ? pieceBoxes(P.doc, P.pick.piece) : [];
    const key = JSON.stringify(boxes);
    if (key === marksKey) return;
    marksKey = key;
    for (const m of el.pages.querySelectorAll('.pg-mark')) m.remove();
    const pad = P.doc ? 0.12 * P.doc.geometry.pitch : 0;
    for (const { page, box: [x0, y0, x1, y1] } of boxes) {
      const f = P.frames[page];
      if (!f) continue;
      const m = document.createElement('div');
      m.className = 'pg-mark';
      m.style.cssText = `left:${(100 * (x0 - pad)) / PAGE.width}%;top:${(100 * (y0 - pad)) / PAGE.height}%;width:${(100 * (x1 - x0 + 2 * pad)) / PAGE.width}%;height:${(100 * (y1 - y0 + 2 * pad)) / PAGE.height}%`;
      f.wrap.append(m);
    }
  }

  /** Redraw everything (look, width or theme changed). */
  function redraw() { P.done.clear(); schedule(); }

  // The writer scrolling by hand ends the following; listened for only while it is on, so
  // that scrolling finished pages runs no script at all.
  function unfollow() { P.follow = false; for (const t of ['wheel', 'touchmove']) el.stage.removeEventListener(t, unfollow); }
  function followOn() { P.follow = true; for (const t of ['wheel', 'touchmove']) el.stage.addEventListener(t, unfollow, { passive: true }); }

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
    P.phase = 'writing'; followOn();
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
    unfollow();
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
    show() { P.visible = true; if (P.phase === 'writing') followOn(); autosize(); redraw(); },
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
        drawn: P.frames.map((f) => !!f.key),
      };
    },
  };
}
