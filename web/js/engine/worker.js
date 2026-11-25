// Runs the network off the main thread (module worker).
//
//   -> { type: 'load', manifest, buffer }                      (buffer is transferred)
//   <- { type: 'ready', charset, xhModel, gapXh }
//   -> { type: 'write', id, text, bias, seed, tries }
//   <- { type: 'progress', id, attempt, steps }                 (about ten times a second)
//   <- { type: 'done', id, result: { text, points, count, ok, problems, finished, attempt, ms } }
//   -> { type: 'cancel' }                                       (the current and queued pieces are dropped)
//   <- { type: 'error', id?, message }
import { HandwritingModel, makeRandom } from './engine.js';

let model = null;
let generation = 0;          // bumped by 'cancel'; running work checks it and stops

const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

async function write({ id, text, bias = 0.8, seed, tries = 3 }) {
  const mine = generation;
  const random = makeRandom(seed);
  const t0 = performance.now();
  let best = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const run = model.begin(text, { bias });
    let lastReport = performance.now();
    while (!run.done) {
      run.step(random.uniform(), random.normal(), random.normal(), random.uniform());
      if ((run.steps & 31) === 0) {
        const now = performance.now();
        if (now - lastReport > 100) {
          lastReport = now;
          self.postMessage({ type: 'progress', id, attempt, steps: run.steps });
          await pause();                         // lets a 'cancel' message through
          if (mine !== generation) return;
        }
      }
    }
    const result = run.finish();
    result.attempt = attempt;
    if (best === null || result.ok) best = result;
    if (result.ok) break;
  }
  if (mine !== generation) return;
  best.ms = Math.round(performance.now() - t0);
  self.postMessage({ type: 'done', id, result: best }, [best.points.buffer]);
}

let queue = Promise.resolve();
self.onmessage = (event) => {
  const msg = event.data;
  try {
    if (msg.type === 'load') {
      model = new HandwritingModel(msg.manifest, msg.buffer);
      self.postMessage({ type: 'ready', charset: model.charset, xhModel: model.xhModel, gapXh: model.gapXh });
    } else if (msg.type === 'cancel') {
      generation++;
    } else if (msg.type === 'write') {
      if (!model) throw new Error('model not loaded');
      const mine = generation;
      queue = queue.then(() => (mine === generation ? write(msg) : null))
        .catch((e) => self.postMessage({ type: 'error', id: msg.id, message: String(e && e.message || e) }));
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: msg.id, message: String(e && e.message || e) });
  }
};
