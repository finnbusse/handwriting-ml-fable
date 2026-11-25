// hwsyn_wasm.mjs -- JS wrapper around hwsyn_kernel.c (WASM SIMD). Same interface as createJsEngine():
//   engine.setText(Int32Array codes); engine.reset(); engine.step(dx, dy, penUp, bias);
//   engine.out = Float32Array(121) [pi | mu1 mu2 | sd1 sd2 | rho | eos], engine.phi = Float32Array(U)
// The kernel build decides the in-memory weight type of the dense blocks (f32 / int16 / int8); this wrapper
// (re)packs the standard f32 model accordingly (per-row max-abs quantisation + row-pair interleaving).
import { G, H, K, NOUT } from './hwsyn_common.mjs';

// per-input-row symmetric linear quantisation: W[j,:] ~= scale[j] * q[j,:]
export function quantizeRows(W, bits) {
  const rows = W.length / G, qmax = bits === 8 ? 127 : 32767;
  const q = bits === 8 ? new Int8Array(W.length) : new Int16Array(W.length), scale = new Float32Array(rows);
  for (let j = 0; j < rows; j++) {
    let mx = 0; const p = j * G;
    for (let i = 0; i < G; i++) { const a = Math.abs(W[p + i]); if (a > mx) mx = a; }
    const s = mx > 0 ? Math.fround(mx / qmax) : 1; scale[j] = s; const inv = 1 / s;
    for (let i = 0; i < G; i++) q[p + i] = Math.max(-qmax, Math.min(qmax, Math.round(W[p + i] * inv)));
  }
  return { q, scale };
}
export function dequantizeRows({ q, scale }) {
  const W = new Float32Array(q.length);
  for (let j = 0; j < scale.length; j++) { const p = j * G, s = scale[j]; for (let i = 0; i < G; i++) W[p + i] = q[p + i] * s; }
  return W;
}

export function wasmSimdSupported() { // validates a module whose only function is: i32.const 0; i8x16.splat; i8x16.popcnt
  try {
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch (e) { return false; }
}

export async function createWasmEngine(wasm, model) {
  const module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
  const inst = await WebAssembly.instantiate(module, {});
  const ex = inst.exports, V = model.V;
  const infoPtr = ex.hw_init(V);
  if (!infoPtr) throw new Error('hw_init failed (alphabet too large or out of memory)');
  const mem = () => ex.memory.buffer;
  const [WQ, , pR1, pR2, pR3, pD1, pD2, pD3, pS1, pS2, pS3, pB1, pB2, pB3, pP1, pP2, pP3, pWW, pWB, pWM, pBM, pText, pOut, pPhi, pKappa, pState, UMAX, STATE_N] =
    Array.from(new Uint32Array(mem(), infoPtr, 28));
  const f32 = (ptr, src) => new Float32Array(mem(), ptr, src.length).set(src);
  const rows = (W, r0, n) => W.subarray(r0 * G, (r0 + n) * G);
  // dense rows: f32 -> plain copy; int -> quantise per row, interleave row pairs
  // parts: [W (f32 rows), pre = optional {q, scale} for the same rows taken verbatim from an int weight file]
  const dense = (pD, pS, parts) => {
    let off = 0;
    for (const [W, pre] of parts) {
      const n = W.length / G;
      if (WQ === 0) { new Float32Array(mem(), pD + off * G * 4, W.length).set(W); off += n; continue; }
      const { q, scale } = pre || quantizeRows(W, WQ);
      const dst = WQ === 8 ? new Int8Array(mem(), pD + off * G, W.length) : new Int16Array(mem(), pD + off * G * 2, W.length);
      for (let p = 0; p < n; p += 2) {
        const a = p * G, b = a + G; let o = p * G;
        for (let i = 0; i < G; i++) { dst[o++] = q[a + i]; dst[o++] = q[b + i]; }
      }
      new Float32Array(mem(), pS + off * 4, n).set(scale);
      off += n;
    }
  };
  const side = (pR, parts) => { let off = 0; for (const W of parts) { f32(pR + off * 4, W); off += W.length; } };
  // W1 rows [x(3) | w(V) | h1(H)],  W2/W3 rows [x(3) | below(H) | w(V) | own(H)]
  const pre = (key, r0, n) => { // reuse the file's own quantisation when it matches the kernel's weight type
    const qz = model.quant && model.quant[key];
    return qz && qz.bits === WQ ? { q: qz.q.subarray(r0 * G, (r0 + n) * G), scale: qz.scale.subarray(r0, r0 + n) } : null;
  };
  side(pR1, [rows(model.W1, 0, 3 + V)]);
  dense(pD1, pS1, [[rows(model.W1, 3 + V, H), pre('W1', 3 + V, H)]]);
  for (const [key, pR, pD, pS] of [['W2', pR2, pD2, pS2], ['W3', pR3, pD3, pS3]]) {
    const W = model[key];
    side(pR, [rows(W, 0, 3), rows(W, 3 + H, V)]);
    dense(pD, pS, [[rows(W, 3, H), pre(key, 3, H)], [rows(W, 3 + H + V, H), pre(key, 3 + H + V, H)]]);
  }
  f32(pB1, model.B1); f32(pB2, model.B2); f32(pB3, model.B3);
  f32(pP1, model.P1); f32(pP2, model.P2); f32(pP3, model.P3);
  f32(pWW, model.WW); f32(pWB, model.WB); f32(pWM, model.WM); f32(pBM, model.BM);
  let U = 0;
  const eng = {
    name: 'wasm-simd-' + (WQ === 0 ? 'f32' : 'i' + WQ), module, weightBits: WQ || 32,
    out: new Float32Array(mem(), pOut, NOUT), phi: new Float32Array(mem(), pPhi, 0), kappa: new Float32Array(mem(), pKappa, K),
    get U() { return U; },
    step: ex.hw_step,
    reset: ex.hw_reset,
    memoryBytes: () => mem().byteLength,
    // keepState = true: replace/extend the text without resetting the recurrent state (after priming)
    setText(codes, keepState = false) {
      if (codes.length > UMAX) throw new Error('text too long (max ' + UMAX + ' characters)');
      new Int32Array(mem(), pText, codes.length).set(codes);
      U = codes.length; ex.hw_set_text(U, keepState ? 1 : 0);
      eng.phi = new Float32Array(mem(), pPhi, U);
    },
    getState: () => new Float32Array(mem(), pState, STATE_N).slice(),     // snapshot (LSTM h/c, kappa, window)
    setState: (s) => new Float32Array(mem(), pState, STATE_N).set(s),
  };
  return eng;
}
