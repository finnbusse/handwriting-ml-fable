// hwsyn_common.mjs -- shared, dependency-free helpers for the Graves synthesis network
// (3 x peephole LSTM(400) + soft window(10) + MDN(20) head), layout of the
// X-rayLaser/pytorch-handwriting-synthesis-toolkit state_dict.
//
// Packed model (all Float32Array, built once at load time):
//   W1 : (3+V+H)   x 4H  input-major  rows = [x(3) | w(V) | h1(H)]          (== lstm1.W_xh as stored)
//   W2 : (3+H+V+H) x 4H  input-major  rows = [x(3) | h1(H) | w(V) | h2(H)]  (== lstm2.W_xh)
//   W3 : (3+H+V+H) x 4H  input-major  rows = [x(3) | h2(H) | w(V) | h3(H)]  (== lstm3.W_xh)
//   B1..B3 : 4H   = [b_i | b_f | b_c | b_o]
//   P1..P3 : 3H   = [W_ci | W_cf | W_co]   (peepholes)
//   WW : 3K x H   rows = [alpha(K) | beta(K) | kappa(K)],  WB : 3K
//   WM : (6M+1) x 3H rows = [pi(M) | mu(2M) | sd(2M) | ro(M) | eos(1)], BM : 6M+1
export const H = 400, G = 1600, K = 10, M = 20, NOUT = 6 * M + 1;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cat(arrs) {
  let n = 0; for (const a of arrs) n += a.length;
  const out = new Float32Array(n); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// tensors: { 'lstm1.W_xh': Float32Array, ... } (state_dict names), V = alphabet size
export function packModel(t, V, extra = {}) {
  const lstm = (p) => ({
    W: t[p + '.W_xh'],
    B: cat([t[p + '.b_i'], t[p + '.b_f'], t[p + '.b_c'], t[p + '.b_o']]),
    P: cat([t[p + '.W_ci'], t[p + '.W_cf'], t[p + '.W_co']]),
  });
  const l1 = lstm('lstm1'), l2 = lstm('lstm2'), l3 = lstm('lstm3');
  if (l1.W.length !== (3 + V + H) * G || l2.W.length !== (3 + H + V + H) * G) throw new Error('shape mismatch');
  return {
    V, H, G, K, M, NOUT,
    W1: l1.W, B1: l1.B, P1: l1.P, W2: l2.W, B2: l2.B, P2: l2.P, W3: l3.W, B3: l3.B, P3: l3.P,
    WW: cat([t['window.alpha.weight'], t['window.beta.weight'], t['window.k.weight']]),
    WB: cat([t['window.alpha.bias'], t['window.beta.bias'], t['window.k.bias']]),
    WM: cat([t['mixture.pi.weight'], t['mixture.mu.weight'], t['mixture.sd.weight'], t['mixture.ro.weight'], t['mixture.eos.weight']]),
    BM: cat([t['mixture.pi.bias'], t['mixture.mu.bias'], t['mixture.sd.bias'], t['mixture.ro.bias'], t['mixture.eos.bias']]),
    ...extra,
  };
}

// manifest = parsed weights.json, buf = ArrayBuffer of weights_f32.bin
export function modelFromBlob(manifest, buf) {
  const all = new Float32Array(buf, 0, manifest.total_floats);
  const t = {};
  for (const e of manifest.tensors) t[e.name] = all.subarray(e.offset, e.offset + e.length);
  return packModel(t, manifest.V, { charset: manifest.charset, mu: manifest.mu, std: manifest.std });
}

// random weights of the right shapes (uniform +-1/sqrt(H) like the toolkit's init);
// the window kappa bias is set so that the window advances ~0.03 char/step (keeps phi alive).
export function randomModel(V, seed = 1) {
  const rnd = mulberry32(seed), s = 1 / Math.sqrt(H);
  const u = (n, sc = s) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = (rnd() * 2 - 1) * sc; return a; };
  const t = {};
  for (const [p, nin] of [['lstm1', 3 + V + H], ['lstm2', 3 + H + V + H], ['lstm3', 3 + H + V + H]]) {
    for (const k of ['W_ci', 'b_i', 'W_cf', 'b_f', 'b_c', 'W_co', 'b_o']) t[`${p}.${k}`] = u(H);
    t[`${p}.W_xh`] = u(nin * G);
  }
  for (const k of ['alpha', 'beta', 'k']) { t[`window.${k}.weight`] = u(K * H, 0.01); t[`window.${k}.bias`] = u(K, 0.1); }
  for (let i = 0; i < K; i++) { t['window.k.bias'][i] += Math.log(0.03); t['window.beta.bias'][i] += Math.log(0.5); }
  for (const [k, n] of [['pi', M], ['mu', 2 * M], ['sd', 2 * M], ['ro', M], ['eos', 1]]) { t[`mixture.${k}.weight`] = u(n * 3 * H); t[`mixture.${k}.bias`] = u(n); }
  for (let i = 0; i < 2 * M; i++) t['mixture.sd.bias'][i] -= 2; // small sigmas -> inputs stay O(1)
  return packModel(t, V);
}

export function encodeText(text, charset) {
  const codes = new Int32Array(text.length);
  for (let i = 0; i < text.length; i++) { const k = charset.indexOf(text[i]); codes[i] = k < 0 ? 0 : k + 1; }
  return codes;
}

// Sample one point from engine.out = [pi(M) | mu1(M) mu2(M) | sd1(M) sd2(M) | ro(M) | eos]; res = Float64Array(3)
// eosMode 0: threshold at 0.5 (toolkit behaviour), 1: Bernoulli (Graves).
export function samplePoint(out, rnd, res, eosMode = 0) {
  let r = rnd(), k = 0;
  for (; k < M - 1; k++) { r -= out[k]; if (r <= 0) break; }
  const mu1 = out[M + k], mu2 = out[2 * M + k], s1 = out[3 * M + k], s2 = out[4 * M + k], ro = out[5 * M + k];
  const u1 = 1 - rnd(), u2 = rnd();
  const rad = Math.sqrt(-2 * Math.log(u1)), z1 = rad * Math.cos(6.283185307179586 * u2), z2 = rad * Math.sin(6.283185307179586 * u2);
  res[0] = mu1 + s1 * z1;
  res[1] = mu2 + s2 * (ro * z1 + Math.sqrt(Math.max(0, 1 - ro * ro)) * z2);
  const e = out[6 * M];
  res[2] = eosMode ? (rnd() < e ? 1 : 0) : (e > 0.5 ? 1 : 0);
  return res;
}
