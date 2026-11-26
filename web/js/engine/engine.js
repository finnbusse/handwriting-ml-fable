// The handwriting network in plain JavaScript.
//
// A faithful port of hw/reference.py (the normative description of one writing
// step) and of Synthesizer._finish in hw/sampling.py (trimming and judging a
// finished sample).  tests/engine/engine.test.mjs checks it number by number
// against reference results produced in Python.
//
// No dependencies, works in a page, a Web Worker and Node.

export const SENTINEL_FALLBACK = '  ';

// No stop before this many steps per character of the text (hw/model.py:
// MIN_STEPS_PER_CHAR).  A text of three characters or fewer otherwise ends
// after its first point: the window starts with most of its weight on the sentinel.
export const MIN_STEPS_PER_CHAR = 8;

// A character counts as skipped when its strongest attention stays below
// SKIP_RATIO x the piece's strongest, or below SKIP_WEAK while the window sat on
// it for SKIP_DWELL x the median number of points per letter of the piece
// (hw/sampling.py: skipped_chars, where the numbers behind them are).
export const SKIP_RATIO = 0.10;
export const SKIP_WEAK = 0.15;
export const SKIP_DWELL = 1.8;

/** Indices of the characters of `norm` the network skipped (hw/sampling.py:
 *  skipped_chars).  peak[u]: strongest attention on character u; where[i]: the
 *  character the window sat on at point i. */
export function skippedChars(norm, peak, where) {
  const chars = [...norm], n = chars.length;
  let peakMax = 0;
  for (let u = 0; u < n; u++) if (peak[u] > peakMax) peakMax = peak[u];
  if (!n || !(peakMax > 0)) return [];
  const dwell = new Array(n).fill(0);
  if (where) for (const u of where) if (u < n) dwell[u]++;
  const counts = [];
  chars.forEach((c, u) => { if (c !== ' ') counts.push(dwell[u]); });
  counts.sort((a, b) => a - b);
  const m = counts.length >> 1;
  const typical = !counts.length ? 0 : counts.length % 2 ? counts[m] : (counts[m - 1] + counts[m]) / 2;
  const out = [];
  for (let u = 0; u < n; u++) {
    const ratio = peak[u] / peakMax;
    if (ratio < SKIP_RATIO || (ratio < SKIP_WEAK && dwell[u] > 0 && dwell[u] >= SKIP_DWELL * typical)) out.push(u);
  }
  return out;
}

// Typographic variants that are written the same way by hand (hw/charset.py).
const FOLD = {
  '„': '"', '“': '"', '”': '"', '«': '"', '»': '"',
  '‘': "'", '’': "'", '‚': ',', '´': "'", '`': "'",
  '–': '-', '—': '-', '−': '-', '…': '...',
  ' ': ' ', '\t': ' ', '\n': ' ', '{': '(', '}': ')', '<': '(', '>': ')',
  'ẞ': 'ß', '|': '/', '\\': '/', '~': '-', '^': "'", '$': 'S',
};
const SPACE = /\s/u;

function halfToFloat(h) {
  const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * f * 5.960464477539063e-8;             // subnormal: f * 2^-24
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * Math.pow(2, e - 15);
}

/** model.bin (ArrayBuffer) + manifest -> { name: Float32Array } */
export function decodeWeights(manifest, buffer) {
  const out = {};
  const view = new DataView(buffer);
  const table = manifest.dtype === 'float16' ? new Float32Array(65536) : null;
  if (table) for (let i = 0; i < 65536; i++) table[i] = halfToFloat(i);
  for (const t of manifest.tensors) {
    const a = new Float32Array(t.length);
    if (table) for (let i = 0, o = t.offset; i < t.length; i++, o += 2) a[i] = table[view.getUint16(o, true)];
    else for (let i = 0, o = t.offset; i < t.length; i++, o += 4) a[i] = view.getFloat32(o, true);
    out[t.name] = a;
  }
  return out;
}

const sigmoid = (v) => 1 / (1 + Math.exp(-v));

// z += v * W[row, :]   (W is row-major with `n` columns)
function axpyRow(z, W, row, v, n) {
  let o = row * n, j = 0;
  const m = n - (n % 4);
  for (; j < m; j += 4, o += 4) {
    z[j] += v * W[o];
    z[j + 1] += v * W[o + 1];
    z[j + 2] += v * W[o + 2];
    z[j + 3] += v * W[o + 3];
  }
  for (; j < n; j++, o++) z[j] += v * W[o];
}

// out[k] = b[k] + sum_j W[k, j] * x[j]   (W is (rows, cols) row-major)
function linear(out, W, b, x, rows, cols, xOff = 0) {
  for (let k = 0, o = 0; k < rows; k++) {
    let s = b[k];
    for (let j = 0; j < cols; j++, o++) s += W[o] * x[xOff + j];
    out[k] = s;
  }
}

export class HandwritingModel {
  constructor(manifest, buffer) {
    if (manifest.format !== 1) throw new Error(`unsupported model format ${manifest.format}`);
    this.manifest = manifest;
    this.w = decodeWeights(manifest, buffer);
    this.H = manifest.hidden;
    this.K = manifest.window_components;
    this.M = manifest.mixtures;
    this.V = manifest.alphabet;
    this.charset = manifest.charset;
    this.sentinel = manifest.sentinel ?? SENTINEL_FALLBACK;
    this.mu = manifest.mu;
    this.std = manifest.std;
    this.xhModel = manifest.xh_model ?? 100;
    this.gapXh = manifest.gap_xh ?? [2.9, 0.8];
    this.index = new Map();
    let i = 1;
    for (const ch of this.charset) this.index.set(ch, i++);
    if (i !== this.V) throw new Error('charset does not match the alphabet size');
  }

  /** Map text onto characters the model knows (hw/charset.py: Charset.normalize). */
  normalize(text) {
    const out = [];
    for (const ch0 of text.normalize('NFC')) {
      if (this.index.has(ch0)) { out.push(ch0); continue; }
      if (SPACE.test(ch0)) { out.push(' '); continue; }
      const ch = FOLD[ch0] ?? ch0;
      if ([...ch].every((c) => this.index.has(c))) { out.push(ch); continue; }
      const base = [...ch.normalize('NFD')][0];
      if (base !== undefined && this.index.has(base)) out.push(base);
    }
    return out.join('').split(/\s+/u).filter(Boolean).join(' ');
  }

  /** Characters of `text` that normalize() cannot express at all. */
  unsupported(text) {
    const bad = [];
    for (const ch0 of text.normalize('NFC')) {
      if (SPACE.test(ch0) || this.index.has(ch0)) continue;
      const ch = FOLD[ch0] ?? ch0;
      if ([...ch].every((c) => this.index.has(c))) continue;
      const base = [...ch0.normalize('NFD')][0];
      if (base !== undefined && this.index.has(base)) continue;
      bad.push(ch0);
    }
    return bad;
  }

  encode(text) {
    return [...text].map((ch) => this.index.get(ch) ?? 0);
  }

  /** Start writing `text` (already a single piece, see layout.js for pages). */
  begin(text, { bias = 0.8 } = {}) {
    const norm = this.normalize(text);
    return new Run(this, text, norm, this.encode(norm + this.sentinel), [...this.sentinel].length, bias);
  }
}

/** The text normalizer without the weights: for code that only has the charset
 *  (the page, while the network runs in a worker).  Same results as the methods
 *  of HandwritingModel. */
export function createNormalizer(charset) {
  const index = new Map();
  let i = 1;
  for (const ch of charset) index.set(ch, i++);
  const self = { index };
  return {
    normalize: (text) => HandwritingModel.prototype.normalize.call(self, text),
    unsupported: (text) => HandwritingModel.prototype.unsupported.call(self, text),
  };
}

export class Run {
  constructor(model, text, norm, tokens, nTail, bias) {
    const { H, K, V } = model;
    this.model = model; this.text = text; this.norm = norm; this.tokens = tokens;
    this.U = tokens.length; this.nTail = nTail; this.bias = bias;
    this.h1 = new Float32Array(H); this.c1 = new Float32Array(H);
    this.h2 = new Float32Array(H); this.c2 = new Float32Array(H);
    this.h3 = new Float32Array(H); this.c3 = new Float32Array(H);
    this.kappa = new Float32Array(K);
    this.win = new Float32Array(V);
    this.phi = new Float32Array(this.U);
    this.peak = new Float32Array(this.U);
    this.z = new Float32Array(4 * H);
    this.tmpK = new Float32Array(K);
    this.alpha = new Float32Array(K); this.beta = new Float32Array(K);
    this.hcat = new Float32Array(3 * H);
    this.mix = { pi: new Float64Array(model.M), mu: new Float32Array(2 * model.M),
                 sd: new Float32Array(2 * model.M), ro: new Float32Array(model.M), eos: new Float32Array(1) };
    this.x = [0, 0, 0];
    this.offsets = [];           // flat: dx, dy, eos (normalised units)
    this.whereAt = [];          // per point: the character the window sat on
    this.steps = 0;
    this.done = false;
    this.finished = false;       // the stop rule fired (as opposed to running out of steps)
    this.tailStep = -1;
    this.maxSteps = 60 * this.U + 100;
    this.minSteps = MIN_STEPS_PER_CHAR * Math.max(this.U - nTail, 0);
    this.last = null;            // diagnostics of the latest step
  }

  _cell(W, p, h, c) {
    // z holds the gate pre-activations; update h and c in place
    const H = this.model.H, z = this.z, w = this.model.w;
    const Wci = w[`${p}.W_ci`], Wcf = w[`${p}.W_cf`], Wco = w[`${p}.W_co`];
    const bi = w[`${p}.b_i`], bf = w[`${p}.b_f`], bc = w[`${p}.b_c`], bo = w[`${p}.b_o`];
    for (let j = 0; j < H; j++) {
      const cPrev = c[j];
      const i = sigmoid(z[j] + cPrev * Wci[j] + bi[j]);
      const f = sigmoid(z[H + j] + cPrev * Wcf[j] + bf[j]);
      const cNew = f * cPrev + i * Math.tanh(z[2 * H + j] + bc[j]);
      const o = sigmoid(z[3 * H + j] + cNew * Wco[j] + bo[j]);
      c[j] = cNew;
      h[j] = o * Math.tanh(cNew);
    }
  }

  _rows(W, rowStart, vec, n, skipTiny) {
    const z = this.z, cols = 4 * this.model.H;
    for (let i = 0; i < n; i++) {
      const v = vec[i];
      if (v === 0 || (skipTiny && v > -1e-12 && v < 1e-12)) continue;
      axpyRow(z, W, rowStart + i, v, cols);
    }
  }

  /** One point.  Draws: uComp, uEos uniform in [0,1); n1, n2 standard normal.
   *  Returns [dx, dy, eos] in normalised units (also appended to this.offsets). */
  step(uComp, n1, n2, uEos) {
    if (this.done) return null;
    const m = this.model, w = m.w, { H, K, M, V } = m, U = this.U, x = this.x, z = this.z;

    // layer 1: input [x, window], recurrent h1
    z.fill(0);
    let W = w['lstm1.W_xh'];
    this._rows(W, 0, x, 3, false);
    this._rows(W, 3, this.win, V, true);
    this._rows(W, 3 + V, this.h1, H, false);
    this._cell(W, 'lstm1', this.h1, this.c1);

    // attention window over the text
    linear(this.tmpK, w['window.alpha.weight'], w['window.alpha.bias'], this.h1, K, H);
    for (let k = 0; k < K; k++) this.alpha[k] = Math.exp(this.tmpK[k]);
    linear(this.tmpK, w['window.beta.weight'], w['window.beta.bias'], this.h1, K, H);
    for (let k = 0; k < K; k++) this.beta[k] = Math.exp(this.tmpK[k]);
    linear(this.tmpK, w['window.k.weight'], w['window.k.bias'], this.h1, K, H);
    for (let k = 0; k < K; k++) this.kappa[k] += Math.exp(this.tmpK[k]);
    this.win.fill(0);
    let where = 0, best = -Infinity;
    for (let u = 0; u < U; u++) {
      let s = 0;
      for (let k = 0; k < K; k++) { const d = this.kappa[k] - u; s += this.alpha[k] * Math.exp(-this.beta[k] * d * d); }
      const v = Math.fround(s);
      this.phi[u] = v;
      this.win[this.tokens[u]] += v;
      if (v > best) { best = v; where = u; }
      if (v > this.peak[u]) this.peak[u] = v;
    }

    // layer 2: input [x, h1, window], recurrent h2
    z.fill(0);
    W = w['lstm2.W_xh'];
    this._rows(W, 0, x, 3, false);
    this._rows(W, 3, this.h1, H, false);
    this._rows(W, 3 + H, this.win, V, true);
    this._rows(W, 3 + H + V, this.h2, H, false);
    this._cell(W, 'lstm2', this.h2, this.c2);

    // layer 3: input [x, h2, window], recurrent h3
    z.fill(0);
    W = w['lstm3.W_xh'];
    this._rows(W, 0, x, 3, false);
    this._rows(W, 3, this.h2, H, false);
    this._rows(W, 3 + H, this.win, V, true);
    this._rows(W, 3 + H + V, this.h3, H, false);
    this._cell(W, 'lstm3', this.h3, this.c3);

    // mixture density output
    const hc = this.hcat;
    hc.set(this.h1, 0); hc.set(this.h2, H); hc.set(this.h3, 2 * H);
    const mx = this.mix, bias = this.bias;
    linear(mx.ro, w['mixture.pi.weight'], w['mixture.pi.bias'], hc, M, 3 * H);   // pi logits (borrow ro)
    let top = -Infinity;
    for (let j = 0; j < M; j++) { mx.pi[j] = mx.ro[j] * (1 + bias); if (mx.pi[j] > top) top = mx.pi[j]; }
    let sum = 0;
    for (let j = 0; j < M; j++) { mx.pi[j] = Math.exp(mx.pi[j] - top); sum += mx.pi[j]; }
    let comp = M - 1, cum = 0;
    for (let j = 0; j < M; j++) { mx.pi[j] /= sum; }
    for (let j = 0; j < M; j++) { cum += mx.pi[j]; if (cum > uComp) { comp = j; break; } }
    linear(mx.mu, w['mixture.mu.weight'], w['mixture.mu.bias'], hc, 2 * M, 3 * H);
    linear(mx.sd, w['mixture.sd.weight'], w['mixture.sd.bias'], hc, 2 * M, 3 * H);
    linear(mx.ro, w['mixture.ro.weight'], w['mixture.ro.bias'], hc, M, 3 * H);
    linear(mx.eos, w['mixture.eos.weight'], w['mixture.eos.bias'], hc, 1, 3 * H);
    const rho = Math.tanh(mx.ro[comp]);
    const sd1 = Math.exp(mx.sd[comp] - bias), sd2 = Math.exp(mx.sd[comp + M] - bias);
    const dx = mx.mu[comp] + sd1 * n1;
    const dy = mx.mu[comp + M] + sd2 * (rho * n1 + Math.sqrt(Math.max(1 - rho * rho, 0)) * n2);
    const pEos = sigmoid(mx.eos[0]);
    let eos = uEos < pEos ? 1 : 0;

    const stop = this.steps >= this.minSteps && (this.phi[U - 1] > 0.8 || (where === U - 1 && eos === 1));
    if (stop) eos = 1;
    if (this.nTail > 0 && this.tailStep < 0 && where >= U - this.nTail) this.tailStep = this.steps;
    this.last = { component: comp, pEos, where };
    x[0] = Math.fround(dx); x[1] = Math.fround(dy); x[2] = eos;
    this.offsets.push(x[0], x[1], eos);
    this.whereAt.push(where);
    this.steps++;
    if (stop) { this.done = true; this.finished = true; }
    else if (this.steps >= this.maxSteps) this.done = true;
    return [x[0], x[1], eos];
  }

  /** Absolute positions in model units of everything written so far: Float32Array [x, y, eos, ...]. */
  points() {
    const n = this.steps, o = this.offsets, { mu, std } = this.model;
    const p = new Float32Array(3 * n);
    let x = 0, y = 0;
    for (let i = 0; i < n; i++) {
      x += o[3 * i] * std[0] + mu[0];
      y += o[3 * i + 1] * std[1] + mu[1];
      p[3 * i] = x; p[3 * i + 1] = y; p[3 * i + 2] = o[3 * i + 2];
    }
    return p;
  }

  /** Trim what was written past the end of the text and judge the sample
   *  (hw/sampling.py: Synthesizer._finish).  The checks that need the baseline
   *  (missing dots, drift) follow in generate/layout.js: judgePiece. */
  finish() {
    let p = this.points();
    let n = this.steps;
    let cut = n;
    if (this.tailStep > 0) {
      let bodyRight = -Infinity;
      for (let i = 0; i < this.tailStep; i++) if (p[3 * i] > bodyRight) bodyRight = p[3 * i];
      const margin = 0.6 * this.model.xhModel;
      const ends = [];
      for (let i = 0; i < n; i++) if (p[3 * i + 2] > 0.5) ends.push(i);
      for (let k = ends.length - 1; k >= 0; k--) {
        const s = k === 0 ? 0 : ends[k - 1] + 1, e = ends[k];
        let minX = Infinity;
        for (let i = s; i <= e; i++) if (p[3 * i] < minX) minX = p[3 * i];
        if (s >= this.tailStep && minX > bodyRight + margin) cut = s; else break;
      }
    }
    n = Math.max(cut, 1);
    p = p.slice(0, 3 * n);
    p[3 * (n - 1) + 2] = 1;
    const where = Uint16Array.from(this.whereAt.slice(0, n));
    const skipped = skippedChars(this.norm, this.peak, where).length;
    const letters = Math.max([...this.text.replaceAll(' ', '')].length, 1);
    const ppc = n / letters;
    const problems = [];
    if (!this.finished) problems.push('unfinished');
    if (skipped) problems.push(`skipped ${skipped}`);
    if (!(ppc >= 8 && ppc <= 70)) problems.push(`points/char ${ppc.toFixed(0)}`);
    return { text: this.text, points: p, count: n, finished: this.finished, ok: problems.length === 0, problems,
             where };
  }
}

/** Small seedable generator (mulberry32) with a normal-distribution helper. */
export function makeRandom(seed = (Math.random() * 2 ** 32) >>> 0) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  const normal = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0, v = 0, r = 0;
    do { u = 2 * uniform() - 1; v = 2 * uniform() - 1; r = u * u + v * v; } while (r >= 1 || r === 0);
    const f = Math.sqrt(-2 * Math.log(r) / r);
    spare = v * f;
    return u * f;
  };
  return { uniform, normal };
}

/** Write one piece to the end; `onPoint(run)` is called after every point. */
export function writePiece(model, text, { bias = 0.8, random = makeRandom(), onPoint = null } = {}) {
  const run = model.begin(text, { bias });
  while (!run.done) {
    run.step(random.uniform(), random.normal(), random.normal(), random.uniform());
    if (onPoint) onPoint(run);
  }
  return run.finish();
}
