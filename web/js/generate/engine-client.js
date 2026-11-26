// Main-thread side of the engine worker (js/engine/worker.js).
//
//   const engine = createEngine(manifest, buffer);
//   const info = await engine.ready;            // { charset, xhModel, gapXh }
//   const result = await engine.writePiece({ text, bias, seed });   // optional tries: a cap on the attempts
//   engine.cancel();                            // pending writePiece() promises reject with .cancelled = true
//   engine.terminate();
//
// `buffer` stays with the caller: the workers read it from one Blob made of a copy.

function cancelled() { const e = new Error('cancelled'); e.cancelled = true; return e; }

// Copying the 7.6 MB model for every engine on the main thread (slice, then a structured
// clone) takes 98 ms for four engines on a 4x slowed CPU, a task that stops the page just as
// writing starts.  One Blob per model is made once; each worker reads it on its own thread.
const blobs = new WeakMap();
const modelBlob = (buffer) => { let b = blobs.get(buffer); if (!b) { b = new Blob([buffer]); blobs.set(buffer, b); } return b; };

export function createEngine(manifest, buffer, { workerUrl = new URL('../engine/worker.js', import.meta.url) } = {}) {
  const worker = new Worker(workerUrl, { type: 'module' });
  const pending = new Map();           // id -> { resolve, reject }
  let nextId = 1;
  let dead = null;
  let readyHandlers = null;
  let onProgress = null;

  const ready = new Promise((resolve, reject) => { readyHandlers = { resolve, reject }; });
  ready.catch(() => {});

  const failAll = (error) => {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };

  worker.onmessage = (event) => {
    const m = event.data;
    if (m.type === 'ready') readyHandlers.resolve({ charset: m.charset, xhModel: m.xhModel, gapXh: m.gapXh });
    else if (m.type === 'progress') { if (onProgress) onProgress(m); }
    else if (m.type === 'done') {
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); p.resolve(m.result); }
    } else if (m.type === 'error') {
      const error = new Error(m.message || 'engine error');
      if (m.id !== undefined && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p.reject(error); }
      else { dead = error; readyHandlers.reject(error); failAll(error); }     // the model did not load: this engine is no use
    }
  };
  worker.onerror = (event) => {
    dead = new Error((event && event.message) || 'worker failed');
    readyHandlers.reject(dead);
    failAll(dead);
  };

  worker.postMessage({ type: 'load', manifest, model: modelBlob(buffer) });

  return {
    ready,
    /** The worker crashed or could not load the model; every writePiece() fails. */
    get failed() { return !!dead; },
    set onProgress(fn) { onProgress = fn; },
    writePiece({ text, bias, seed, tries }) {
      if (dead) return Promise.reject(dead);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: 'write', id, text, bias, seed, tries });
      });
    },
    cancel() {
      worker.postMessage({ type: 'cancel' });
      failAll(cancelled());
    },
    terminate() {
      worker.terminate();
      failAll(cancelled());
    },
  };
}

/** How many engines a device can spare for writing pages: one core stays with the
 *  page, at most 4 (a piece is about 600 steps at ~200 steps/s per core), and fewer
 *  where memory is small (every engine holds its own copy of the model). */
export function poolSize(nav = typeof navigator !== 'undefined' ? navigator : {}) {
  let n = Math.min(4, Math.max(1, (nav.hardwareConcurrency || 2) - 1));
  const mem = nav.deviceMemory;
  if (mem && mem <= 2) n = 1;
  else if (mem && mem <= 4) n = Math.min(n, 2);
  return n;
}

/**
 * Several engines writing pieces side by side.  Same interface as one engine, plus
 * `size`; writePiece({ ..., first: true }) goes ahead of everything queued (a piece
 * the writer asked to rewrite).  Pieces are handed out in the order they are asked
 * for, so the start of a text is written first.
 *
 * A piece that fails is tried once more, on another engine if there is one.  An
 * engine whose worker died (crash, out of memory, model not loaded) is replaced by
 * a fresh one; after `size` replacements a dead engine is dropped instead, and only
 * when none is left do the pieces fail.  Without this a dead engine, which fails at
 * once, would take most of the queue and fail the whole text.
 */
export function createEnginePool(manifest, buffer, size = poolSize(), o = {}) {
  const make = o.createEngine || createEngine;
  const engines = Array.from({ length: Math.max(1, size) }, () => make(manifest, buffer, o));
  const busy = new Set();
  let queue = [];          // { job, resolve, reject, tried }
  let renewals = 0;
  const ready = Promise.any(engines.map((e) => e.ready));
  ready.catch(() => {});

  const replace = (e) => {
    const k = engines.indexOf(e);
    if (k < 0) return;
    e.terminate();
    if (renewals < engines.length + 1) { renewals++; engines[k] = make(manifest, buffer, o); engines[k].ready.catch(() => {}); }
    else engines.splice(k, 1);
  };

  const pump = () => {
    if (!engines.length) {
      const q = queue; queue = [];
      for (const it of q) it.reject(new Error('no engine left'));
      return;
    }
    for (const e of [...engines]) {
      if (!queue.length) return;
      if (busy.has(e)) continue;
      const item = queue.shift();
      busy.add(e);
      e.writePiece(item.job).then(item.resolve, (error) => {
        if (error && error.cancelled) { item.reject(error); return; }
        if (e.failed) replace(e);
        if (item.tried) item.reject(error);
        else { item.tried = true; queue.unshift(item); }
      }).finally(() => { busy.delete(e); pump(); });
    }
  };

  return {
    ready,
    get size() { return engines.length; },
    writePiece(job) {
      return new Promise((resolve, reject) => {
        const { first, ...rest } = job;
        const item = { job: rest, resolve, reject, tried: false };
        if (first) queue.unshift(item); else queue.push(item);
        pump();
      });
    },
    /** Pending and running pieces reject with .cancelled = true. */
    cancel() {
      const q = queue; queue = [];
      for (const it of q) it.reject(cancelled());
      for (const e of busy) e.cancel();
    },
    terminate() {
      this.cancel();
      for (const e of engines) e.terminate();
    },
  };
}
