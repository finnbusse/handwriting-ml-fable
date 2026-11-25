// hwsyn_js.mjs -- dependency-free plain-JS engines (one generation step) for the synthesis network.
// createJsEngine(model, variant) -> { setText(codes), reset(), step(x0,x1,x2,bias), out, phi, U }
//   out = Float32Array(121) = [pi (softmax) | mu(40) | sd(40) | ro(20) | eos], phi = Float32Array(U)
// Variants (all compute the same function):
//   'naive'   : out-major weights, dense input vector incl. dense soft window, 1 accumulator
//   'dot4'    : same, 4 accumulators (unroll by 4)
//   'dot4s'   : dot4 for the dense h blocks, x(3)/window handled as (sparse) row adds
//   'dot2x4s' : as dot4s but two output rows per pass (shares x loads)
//   'axpy1'   : input-major (as stored), z += x_j * W[j,:], one row at a time, zero rows skipped
//   'axpy4'   : input-major, 4 input rows per pass, window sparse
//   'axpy8'   : input-major, 8 input rows per pass, window sparse
// opts.f64 = true keeps the big matrices in Float64Array (2x memory, no f32->f64 conversion per load).
import { H, G, K, M, NOUT } from './hwsyn_common.mjs';

const PHI_EPS = 1e-12; // window weights below this are skipped (also avoids denormals)

function transpose(W, nin) { // input-major (nin x G) -> out-major (G x nin)
  const T = new Float32Array(W.length);
  for (let j = 0; j < nin; j++) { const r = j * G; for (let i = 0; i < G; i++) T[i * nin + j] = W[r + i]; }
  return T;
}

function gates(z, c, h, hoff, P) {
  for (let n = 0; n < H; n++) {
    const cp = c[n];
    const ig = 1 / (1 + Math.exp(-(z[n] + cp * P[n])));
    const fg = 1 / (1 + Math.exp(-(z[H + n] + cp * P[H + n])));
    const cn = fg * cp + ig * Math.tanh(z[2 * H + n]);
    const og = 1 / (1 + Math.exp(-(z[3 * H + n] + cn * P[2 * H + n])));
    c[n] = cn;
    h[hoff + n] = og * Math.tanh(cn);
  }
}

// ---- dense kernels ---------------------------------------------------------------------------
function dot1(z, Wt, nin, x) {
  for (let i = 0, p = 0; i < G; i++, p += nin) {
    let s = 0;
    for (let j = 0; j < nin; j++) s += Wt[p + j] * x[j];
    z[i] += s;
  }
}
// out-major block: columns [c0, c0+n) of Wt (row length nin) times x[xo .. xo+n)
function dot4(z, Wt, nin, c0, n, x, xo) {
  const n4 = n & ~3;
  for (let i = 0, p = c0; i < G; i++, p += nin) {
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, j = 0;
    for (; j < n4; j += 4) {
      s0 += Wt[p + j] * x[xo + j];
      s1 += Wt[p + j + 1] * x[xo + j + 1];
      s2 += Wt[p + j + 2] * x[xo + j + 2];
      s3 += Wt[p + j + 3] * x[xo + j + 3];
    }
    for (; j < n; j++) s0 += Wt[p + j] * x[xo + j];
    z[i] += (s0 + s1) + (s2 + s3);
  }
}
function dot2x4(z, Wt, nin, c0, n, x, xo) {
  const n4 = n & ~3;
  for (let i = 0, p = c0; i < G; i += 2, p += 2 * nin) {
    const q = p + nin;
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, t0 = 0, t1 = 0, t2 = 0, t3 = 0, j = 0;
    for (; j < n4; j += 4) {
      const a = x[xo + j], b = x[xo + j + 1], c = x[xo + j + 2], d = x[xo + j + 3];
      s0 += Wt[p + j] * a; s1 += Wt[p + j + 1] * b; s2 += Wt[p + j + 2] * c; s3 += Wt[p + j + 3] * d;
      t0 += Wt[q + j] * a; t1 += Wt[q + j + 1] * b; t2 += Wt[q + j + 2] * c; t3 += Wt[q + j + 3] * d;
    }
    for (; j < n; j++) { s0 += Wt[p + j] * x[xo + j]; t0 += Wt[q + j] * x[xo + j]; }
    z[i] += (s0 + s1) + (s2 + s3);
    z[i + 1] += (t0 + t1) + (t2 + t3);
  }
}
// input-major: z += a * W[row,:]
function addRow(z, W, row, a) {
  const p = row * G;
  for (let i = 0; i < G; i += 4) {
    z[i] += a * W[p + i]; z[i + 1] += a * W[p + i + 1]; z[i + 2] += a * W[p + i + 2]; z[i + 3] += a * W[p + i + 3];
  }
}
function axpy1(z, W, r0, n, x, xo) {
  for (let j = 0; j < n; j++) { const a = x[xo + j]; if (a !== 0) addRow(z, W, r0 + j, a); }
}
function axpy4(z, W, r0, n, x, xo) {
  let j = 0;
  for (; j + 4 <= n; j += 4) {
    const a = x[xo + j], b = x[xo + j + 1], c = x[xo + j + 2], d = x[xo + j + 3];
    const p = (r0 + j) * G, q = p + G, r = q + G, s = r + G;
    for (let i = 0; i < G; i++) z[i] += (a * W[p + i] + b * W[q + i]) + (c * W[r + i] + d * W[s + i]);
  }
  for (; j < n; j++) addRow(z, W, r0 + j, x[xo + j]);
}
function axpy8(z, W, r0, n, x, xo) {
  let j = 0;
  for (; j + 8 <= n; j += 8) {
    const a = x[xo + j], b = x[xo + j + 1], c = x[xo + j + 2], d = x[xo + j + 3];
    const e = x[xo + j + 4], f = x[xo + j + 5], g = x[xo + j + 6], h = x[xo + j + 7];
    const p0 = (r0 + j) * G, p1 = p0 + G, p2 = p1 + G, p3 = p2 + G, p4 = p3 + G, p5 = p4 + G, p6 = p5 + G, p7 = p6 + G;
    for (let i = 0; i < G; i++) {
      z[i] += ((a * W[p0 + i] + b * W[p1 + i]) + (c * W[p2 + i] + d * W[p3 + i])) +
              ((e * W[p4 + i] + f * W[p5 + i]) + (g * W[p6 + i] + h * W[p7 + i]));
    }
  }
  if (j < n) axpy4(z, W, r0 + j, n - j, x, xo + j);
}
function addWindowRows(z, W, r0, w, V) { // sparse soft window: only non-negligible characters
  for (let v = 0; v < V; v++) { const a = w[v]; if (a > PHI_EPS) addRow(z, W, r0 + v, a); }
}

export function createJsEngine(model, variant = 'axpy4', opts = {}) {
  const V = model.V;
  const n1 = 3 + V + H, n2 = 3 + H + V + H;
  const big = (a) => (opts.f64 ? Float64Array.from(a) : a);
  const outMajor = variant.startsWith('dot') || variant === 'naive';
  const W1 = big(outMajor ? transpose(model.W1, n1) : model.W1);
  const W2 = big(outMajor ? transpose(model.W2, n2) : model.W2);
  const W3 = big(outMajor ? transpose(model.W3, n3()) : model.W3);
  function n3() { return n2; }
  // input-major copies of the x/window rows for the sparse variants of the out-major layouts
  const R1 = model.W1, R2 = model.W2, R3 = model.W3;
  const { B1, B2, B3, P1, P2, P3, WW, WB, WM, BM } = model;
  const z = new Float64Array(G);
  const hh = new Float64Array(3 * H);            // [h1 | h2 | h3] contiguous = head input
  const c1 = new Float64Array(H), c2 = new Float64Array(H), c3 = new Float64Array(H);
  const kappa = new Float64Array(K), w = new Float64Array(V), xv = new Float64Array(3);
  const xin1 = new Float64Array(n1), xin2 = new Float64Array(n2);
  const out = new Float32Array(NOUT), y = new Float64Array(NOUT), win = new Float64Array(3 * K);
  let codes = new Int32Array(0), U = 0, phi = new Float32Array(0);

  function lstmZ(layer, below /* offset in hh of the layer below, or -1 */, own /* offset in hh */) {
    const W = layer === 1 ? W1 : layer === 2 ? W2 : W3, R = layer === 1 ? R1 : layer === 2 ? R2 : R3;
    const B = layer === 1 ? B1 : layer === 2 ? B2 : B3, nin = layer === 1 ? n1 : n2;
    for (let i = 0; i < G; i++) z[i] = B[i];
    const wRow = layer === 1 ? 3 : 3 + H, ownRow = layer === 1 ? 3 + V : 3 + H + V;
    switch (variant) {
      case 'naive': case 'dot4': { // dense concatenated input
        const xin = layer === 1 ? xin1 : xin2;
        xin[0] = xv[0]; xin[1] = xv[1]; xin[2] = xv[2];
        if (layer !== 1) for (let j = 0; j < H; j++) xin[3 + j] = hh[below + j];
        for (let v = 0; v < V; v++) xin[wRow + v] = w[v];
        for (let j = 0; j < H; j++) xin[ownRow + j] = hh[own + j];
        if (variant === 'naive') dot1(z, W, nin, xin); else dot4(z, W, nin, 0, nin, xin, 0);
        break;
      }
      case 'dot4s': case 'dot2x4s': {
        const f = variant === 'dot4s' ? dot4 : dot2x4;
        addRow(z, R, 0, xv[0]); addRow(z, R, 1, xv[1]); addRow(z, R, 2, xv[2]);
        addWindowRows(z, R, wRow, w, V);
        if (layer !== 1) f(z, W, nin, 3, H, hh, below);
        f(z, W, nin, ownRow, H, hh, own);
        break;
      }
      default: {
        const f = variant === 'axpy1' ? axpy1 : variant === 'axpy8' ? axpy8 : axpy4;
        addRow(z, W, 0, xv[0]); addRow(z, W, 1, xv[1]); addRow(z, W, 2, xv[2]);
        if (variant === 'axpy1') axpy1(z, W, wRow, V, w, 0); else addWindowRows(z, W, wRow, w, V);
        if (layer !== 1) f(z, W, 3, H, hh, below);
        f(z, W, ownRow, H, hh, own);
      }
    }
  }

  function step(x0, x1, x2, bias) {
    xv[0] = x0; xv[1] = x1; xv[2] = x2;
    // LSTM 1 (uses the window vector of the previous step)
    lstmZ(1, -1, 0); gates(z, c1, hh, 0, P1);
    // soft window
    for (let r = 0, p = 0; r < 3 * K; r++, p += H) {
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let j = 0; j < H; j += 4) { s0 += WW[p + j] * hh[j]; s1 += WW[p + j + 1] * hh[j + 1]; s2 += WW[p + j + 2] * hh[j + 2]; s3 += WW[p + j + 3] * hh[j + 3]; }
      win[r] = Math.exp(WB[r] + (s0 + s1) + (s2 + s3));
    }
    for (let k = 0; k < K; k++) kappa[k] += win[2 * K + k];
    w.fill(0);
    for (let u = 0; u < U; u++) {
      let s = 0;
      for (let k = 0; k < K; k++) { const d = kappa[k] - u; s += win[k] * Math.exp(-win[K + k] * d * d); }
      phi[u] = s; w[codes[u]] += s;
    }
    // LSTM 2, 3
    lstmZ(2, 0, H); gates(z, c2, hh, H, P2);
    lstmZ(3, H, 2 * H); gates(z, c3, hh, 2 * H, P3);
    // mixture head
    for (let r = 0, p = 0; r < NOUT; r++, p += 3 * H) {
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let j = 0; j < 3 * H; j += 4) { s0 += WM[p + j] * hh[j]; s1 += WM[p + j + 1] * hh[j + 1]; s2 += WM[p + j + 2] * hh[j + 2]; s3 += WM[p + j + 3] * hh[j + 3]; }
      y[r] = BM[r] + (s0 + s1) + (s2 + s3);
    }
    let mx = -Infinity, sum = 0;
    for (let k = 0; k < M; k++) { y[k] *= 1 + bias; if (y[k] > mx) mx = y[k]; }
    for (let k = 0; k < M; k++) { y[k] = Math.exp(y[k] - mx); sum += y[k]; }
    for (let k = 0; k < M; k++) out[k] = y[k] / sum;
    for (let k = M; k < 3 * M; k++) out[k] = y[k];
    for (let k = 3 * M; k < 5 * M; k++) out[k] = Math.exp(y[k] - bias);
    for (let k = 5 * M; k < 6 * M; k++) out[k] = Math.tanh(y[k]);
    out[6 * M] = 1 / (1 + Math.exp(-y[6 * M]));
  }

  return {
    name: 'js-' + variant + (opts.f64 ? '-f64' : ''), out, step,
    get phi() { return phi; }, get U() { return U; }, kappa,
    setText(c, keepState = false) { codes = Int32Array.from(c); U = codes.length; phi = new Float32Array(U); if (!keepState) this.reset(); },
    reset() { hh.fill(0); c1.fill(0); c2.fill(0); c3.fill(0); kappa.fill(0); w.fill(0); },
    getState: () => ({ hh: hh.slice(), c1: c1.slice(), c2: c2.slice(), c3: c3.slice(), kappa: kappa.slice(), w: w.slice() }),
    setState(s) { hh.set(s.hh); c1.set(s.c1); c2.set(s.c2); c3.set(s.c3); kappa.set(s.kappa); w.set(s.w); },
  };
}
