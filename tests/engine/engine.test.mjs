// Checks web/js/engine/engine.js against the Python reference.
//   python scripts/make_engine_fixture.py <checkpoint> tests/engine/fixtures
//   node tests/engine/engine.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HandwritingModel, makeRandom, writePiece } from '../../web/js/engine/engine.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
if (!fs.existsSync(path.join(dir, 'fixture.json'))) {
  console.log('SKIP: no fixtures (run scripts/make_engine_fixture.py first)');
  process.exit(0);
}
const fixture = JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'));
const bin = fs.readFileSync(path.join(dir, 'model.bin'));
const model = new HandwritingModel(manifest, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log('FAIL', msg); } };
const maxDiff = (a, b) => { let m = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

// 1. text normalisation and encoding
for (const c of fixture.normalize) {
  const out = model.normalize(c.in);
  check(out === c.out, `normalize(${JSON.stringify(c.in)}) = ${JSON.stringify(out)}, expected ${JSON.stringify(c.out)}`);
  check(JSON.stringify(model.encode(out)) === JSON.stringify(c.tokens), `encode(${JSON.stringify(out)})`);
}

// 2. step-by-step agreement with the reference, same random draws
const t0 = performance.now();
let steps = 0, worst = 0, worstTrace = 0;
const all = [...fixture.samples, ...fixture.page.pieces];
for (const s of all) {
  const run = model.begin(s.text, { bias: fixture.bias });
  check(JSON.stringify(run.tokens) === JSON.stringify(s.tokens), `tokens for ${JSON.stringify(s.text)}`);
  let firstBad = -1, diffAtEos = 0;
  for (let t = 0; t < s.draws.length && !run.done; t++) {
    const [uComp, n1, n2, uEos] = s.draws[t];
    const p = run.step(uComp, n1, n2, uEos);
    const e = s.offsets[t];
    const d = Math.max(Math.abs(p[0] - e[0]), Math.abs(p[1] - e[1]));
    if (p[2] !== e[2]) diffAtEos++;
    if (d > 2e-2 && firstBad < 0) firstBad = t;
    worst = Math.max(worst, d);
    if (t < (s.trace?.length ?? 0)) {
      const tr = s.trace[t];
      worstTrace = Math.max(worstTrace, maxDiff(run.phi, tr.phi), maxDiff(run.kappa, tr.kappa), maxDiff(run.mix.pi, tr.pi),
        maxDiff(run.h1.subarray(0, 8), tr.h1_head), maxDiff(run.h3.subarray(0, 8), tr.h3_head), Math.abs(run.last.pEos - tr.p_eos));
      check(run.last.component === tr.component, `component at step ${t} of ${JSON.stringify(s.text)}`);
    }
    steps++;
  }
  check(run.steps === s.offsets.length, `${JSON.stringify(s.text)}: ${run.steps} steps, expected ${s.offsets.length}`);
  check(firstBad < 0, `${JSON.stringify(s.text)}: offsets diverge from step ${firstBad}`);
  check(diffAtEos === 0, `${JSON.stringify(s.text)}: ${diffAtEos} pen-lift decisions differ`);
  check(run.finished === s.finished, `${JSON.stringify(s.text)}: finished flag`);
  check(run.tailStep === s.tail_step, `${JSON.stringify(s.text)}: tail step ${run.tailStep} vs ${s.tail_step}`);
  check(maxDiff(run.peak, s.char_peak) < 2e-2, `${JSON.stringify(s.text)}: attention peaks`);
  const fin = run.finish();
  check(fin.count === s.finish.points.length, `${JSON.stringify(s.text)}: finish keeps ${fin.count} points, expected ${s.finish.points.length}`);
  check(fin.ok === s.finish.ok && JSON.stringify(fin.problems) === JSON.stringify(s.finish.problems), `${JSON.stringify(s.text)}: verdict`);
  check(maxDiff(fin.points, s.finish.points.flat()) < 3.0, `${JSON.stringify(s.text)}: final positions (model units)`);
}
const ms = performance.now() - t0;
check(worstTrace < 2e-4, `internal quantities of the first steps differ by ${worstTrace}`);

// 3. free-running generation works and finishes
const free = writePiece(model, 'Guten Morgen!', { bias: 0.8, random: makeRandom(7) });
check(free.count > 50 && free.finished, `free run: ${free.count} points, finished=${free.finished}`);

console.log(JSON.stringify({ pieces: all.length, steps, max_offset_diff: +worst.toExponential(2), max_trace_diff: +worstTrace.toExponential(2),
  steps_per_second: Math.round(steps / (ms / 1000)), free_run_points: free.count, failures }));
process.exit(failures ? 1 : 0);
