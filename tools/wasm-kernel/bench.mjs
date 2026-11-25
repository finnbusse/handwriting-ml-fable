// bench.mjs -- single-threaded steps/second benchmark of one engine variant (run one variant per process).
// usage: node bench.mjs --engine js:axpy4|wasm:<file.wasm> [--f64] [--weights real|random] [--V 90] [--U 60]
//                       [--steps 700] [--reps 7] [--verify] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelFromBlob, randomModel, encodeText, samplePoint, mulberry32, M, NOUT } from './hwsyn_common.mjs';
import { createJsEngine } from './hwsyn_js.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const flag = (k) => args.includes('--' + k);
const engSpec = opt('engine', 'js:axpy4'), wsrc = opt('weights', 'real');
const STEPS = +opt('steps', 700), REPS = +opt('reps', 7), BIAS = +opt('bias', 0.5);

let model, codes;
if (wsrc === 'real') {
  const man = JSON.parse(fs.readFileSync(path.join(here, 'data/weights.json'), 'utf8'));
  const buf = fs.readFileSync(path.join(here, 'data/weights_f32.bin'));
  model = modelFromBlob(man, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  codes = encodeText(opt('text', 'Franz jagt im komplett verwahrlosten Taxi quer durch Bayern'), model.charset);
} else {
  const V = +opt('V', 90), U = +opt('U', 60);
  model = randomModel(V, 7);
  const r = mulberry32(99); codes = Int32Array.from({ length: U }, () => 1 + Math.floor(r() * (V - 1)));
}

let engine;
if (engSpec.startsWith('js:')) engine = createJsEngine(model, engSpec.slice(3), { f64: flag('f64') });
else {
  const { createWasmEngine } = await import('./hwsyn_wasm.mjs');
  engine = await createWasmEngine(fs.readFileSync(path.resolve(engSpec.slice(5))), model, { quant: opt('quant', 'f32') });
  engine.name = 'wasm:' + path.basename(engSpec.slice(5));
}

let verify = null;
if (flag('verify') && wsrc === 'real') {
  const tj = JSON.parse(fs.readFileSync(path.join(here, 'data/ref_trace.json'), 'utf8'));
  const rb = fs.readFileSync(path.join(here, 'data/ref_trace.bin'));
  const ref = new Float32Array(rb.buffer.slice(rb.byteOffset, rb.byteOffset + rb.byteLength));
  engine.setText(Int32Array.from(tj.codes));
  let maxAbs = 0, maxRel = 0, phiSteps = 0;
  for (let t = 0; t < tj.T; t++) {
    engine.step(Math.fround(tj.xs[t][0]), Math.fround(tj.xs[t][1]), Math.fround(tj.xs[t][2]), tj.bias);
    const row = ref.subarray(t * tj.row, (t + 1) * tj.row);
    let anyPhi = false;
    for (let i = 0; i < NOUT; i++) { const d = Math.abs(engine.out[i] - row[i]); if (d > maxAbs) maxAbs = d; const r = d / (Math.abs(row[i]) + 1e-3); if (r > maxRel) maxRel = r; }
    for (let u = 0; u < tj.codes.length; u++) { const d = Math.abs(engine.phi[u] - row[NOUT + u]); if (d > maxAbs) maxAbs = d; if (row[NOUT + u] > 1e-3) anyPhi = true; }
    if (anyPhi) phiSteps++;
  }
  verify = { steps: tj.T, stepsWithActiveWindow: phiSteps, maxAbsDiff: maxAbs, maxRelDiff: maxRel };
}

function rollout(steps, seed) {
  const rnd = mulberry32(seed), p = new Float64Array(3);
  engine.reset();
  let x0 = 0, x1 = 0, x2 = 0, acc = 0;
  for (let t = 0; t < steps; t++) {
    engine.step(x0, x1, x2, BIAS);
    samplePoint(engine.out, rnd, p, 0);
    x0 = p[0]; x1 = p[1]; x2 = p[2];
    acc += x0 + 2 * x1 + 3 * x2 + engine.phi[t % engine.U];
  }
  return acc;
}

engine.setText(codes);
let sink = 0;
sink += rollout(300, 1);                       // warm-up (JIT tier-up / wasm TurboFan)
sink += rollout(300, 2);
const times = [];
for (let r = 0; r < REPS; r++) {
  const t0 = process.hrtime.bigint();
  sink += rollout(STEPS, 100 + r);
  times.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
times.sort((a, b) => a - b);
const best = times[0], med = times[times.length >> 1];
const res = {
  engine: engine.name, weights: wsrc, V: model.V, U: codes.length, steps: STEPS, reps: REPS,
  ms_per_rollout_best: +best.toFixed(1), ms_per_rollout_median: +med.toFixed(1),
  steps_per_s_best: Math.round(STEPS / best * 1000), steps_per_s_median: Math.round(STEPS / med * 1000),
  us_per_step_median: +(med * 1000 / STEPS).toFixed(1),
  kappa_end: Array.from(engine.kappa).slice(0, 3).map((v) => +v.toFixed(2)), checksum: +sink.toFixed(4), verify,
};
if (flag('json')) console.log(JSON.stringify(res));
else console.log(`${res.engine.padEnd(28)} ${wsrc.padEnd(6)} V=${res.V} U=${res.U}  best ${String(res.steps_per_s_best).padStart(5)} steps/s  median ${String(res.steps_per_s_median).padStart(5)} steps/s  (${res.us_per_step_median} us/step, ${res.ms_per_rollout_median} ms/${STEPS} pts)  chk=${res.checksum} kappa=${res.kappa_end}` + (verify ? `  verify maxAbs=${verify.maxAbsDiff.toExponential(2)} maxRel=${verify.maxRelDiff.toExponential(2)} activeWin=${verify.stepsWithActiveWindow}/${verify.steps}` : ''));
