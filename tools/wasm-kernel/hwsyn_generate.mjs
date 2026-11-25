// hwsyn_generate.mjs -- engine-independent generation loop (sampling + stop rule + denormalisation).
import { samplePoint, mulberry32 } from './hwsyn_common.mjs';

// returns { points: [[x, y, penUp], ...] absolute coords (toolkit units), steps, finished }
export function generate(engine, model, codes, { bias = 0.5, seed = 1, maxSteps = 0, eosMode = 0, onPoint = null } = {}) {
  const rnd = mulberry32(seed), p = new Float64Array(3), U = codes.length;
  const mu = model.mu || [0, 0, 0], sd = model.std || [1, 1, 1];
  engine.setText(codes);
  const limit = maxSteps || 60 * U + 200;
  let x0 = 0, x1 = 0, x2 = 0, X = 0, Y = 0, finished = false, t = 0;
  const points = [];
  for (; t < limit; t++) {
    engine.step(x0, x1, x2, bias);
    samplePoint(engine.out, rnd, p, eosMode);
    x0 = p[0]; x1 = p[1]; x2 = p[2];
    X += x0 * sd[0] + mu[0]; Y += x1 * sd[1] + mu[1];
    // toolkit stop rule: window sits on the last character
    const phi = engine.phi; let am = 0;
    for (let u = 1; u < U; u++) if (phi[u] > phi[am]) am = u;
    if (U >= 6 && (phi[U - 1] > 0.8 || (am === U - 1 && x2 > 0.5))) { points.push([X, Y, 1]); finished = true; t++; break; }
    points.push([X, Y, x2]);
    if (onPoint) onPoint(X, Y, x2, am);
  }
  return { points, steps: t, finished };
}

export function toSvgPath(points) {
  let d = '', pen = false;
  for (const [x, y, up] of points) { d += (pen ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1); pen = !up; }
  return d;
}
export function bbox(points) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of points) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
  return [a, b, c, d];
}
