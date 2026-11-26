// Runs the network off the main thread (module worker).
//
//   -> { type: 'load', manifest, model }                       (model: a Blob of model.bin, read here)
//   <- { type: 'ready', charset, xhModel, gapXh }
//   -> { type: 'write', id, text, bias, seed, tries? }           (tries: a cap; without it the app's policy, layout.js: anotherAttempt)
//   <- { type: 'progress', id, attempt, steps }                 (about ten times a second)
//   <- { type: 'done', id, result: { text, points, count, ok, problems, finished, attempt, missingDots, ms } }
//   -> { type: 'cancel' }                                       (the current and queued pieces are dropped)
//   <- { type: 'error', id?, message }
import { HandwritingModel, makeRandom } from './engine.js';
import { judgePiece, betterAttempt, anotherAttempt } from '../generate/layout.js';

let model = null;
let generation = 0;          // bumped by 'cancel'; running work checks it and stops

const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

async function write({ id, text, bias = 0.8, seed, tries }) {
  const mine = generation;
  const random = makeRandom(seed);
  const t0 = performance.now();
  let best = null;
  for (let attempt = 1; ; attempt++) {
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
    judgePiece(result, run.norm, model.xhModel);      // missing dots, drift below the line
    if (best === null || betterAttempt(result, best)) best = result;
    if (!anotherAttempt(best, attempt, tries)) break;   // the best attempt is kept
  }
  if (mine !== generation) return;
  best.ms = Math.round(performance.now() - t0);
  delete best.where;                                  // only the judge needed it
  self.postMessage({ type: 'done', id, result: best }, [best.points.buffer]);
}

// Pieces wait in order behind the model being read.
let queue = Promise.resolve();
self.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'load') {
    queue = msg.model.arrayBuffer().then((buffer) => {
      model = new HandwritingModel(msg.manifest, buffer);
      self.postMessage({ type: 'ready', charset: model.charset, xhModel: model.xhModel, gapXh: model.gapXh });
    }).catch((e) => self.postMessage({ type: 'error', message: String(e && e.message || e) }));
  } else if (msg.type === 'cancel') {
    generation++;
  } else if (msg.type === 'write') {
    const mine = generation;
    queue = queue.then(() => {
      if (!model) throw new Error('model not loaded');
      return mine === generation ? write(msg) : null;
    }).catch((e) => self.postMessage({ type: 'error', id: msg.id, message: String(e && e.message || e) }));
  }
};
