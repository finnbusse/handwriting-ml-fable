// Main-thread side of the engine worker (js/engine/worker.js).
//
//   const engine = createEngine(manifest, buffer);
//   const info = await engine.ready;            // { charset, xhModel, gapXh }
//   const result = await engine.writePiece({ text, bias, seed, tries });
//   engine.cancel();                            // pending writePiece() promises reject with .cancelled = true
//   engine.terminate();
//
// `buffer` stays with the caller: the worker gets a copy.

function cancelled() { const e = new Error('cancelled'); e.cancelled = true; return e; }

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
      else { readyHandlers.reject(error); failAll(error); }
    }
  };
  worker.onerror = (event) => {
    dead = new Error((event && event.message) || 'worker failed');
    readyHandlers.reject(dead);
    failAll(dead);
  };

  // The worker gets its own copy; the transferred one is gone from here afterwards.
  worker.postMessage({ type: 'load', manifest, buffer: buffer.slice(0) });

  return {
    ready,
    set onProgress(fn) { onProgress = fn; },
    writePiece({ text, bias, seed, tries = 3 }) {
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
