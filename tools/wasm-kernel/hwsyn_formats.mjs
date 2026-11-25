// hwsyn_formats.mjs -- weight (de)quantisation helpers: float16, per-row int16 / int8.
import { G, packModel } from './hwsyn_common.mjs';
export { quantizeRows, dequantizeRows } from './hwsyn_wasm.mjs';

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
export function f32ToF16Bits(v) { // round-to-nearest-even
  f32[0] = v; const x = u32[0], sign = (x >>> 16) & 0x8000; let exp = (x >>> 23) & 0xff, man = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (man ? 0x200 : 0);
  exp = exp - 127 + 15;
  if (exp >= 0x1f) return sign | 0x7c00;
  if (exp <= 0) {
    if (exp < -10) return sign;
    man |= 0x800000; const shift = 14 - exp; let h = man >>> shift; const rem = man & ((1 << shift) - 1), half = 1 << (shift - 1);
    if (rem > half || (rem === half && (h & 1))) h++;
    return sign | h;
  }
  let h = (exp << 10) | (man >>> 13); const rem = man & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (h & 1))) h++;
  return sign | h;
}
let LUT = null;
export function f16Table() { // 65536-entry table: half bits -> float32 (256 KB, built once in <1 ms)
  if (LUT) return LUT;
  LUT = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    LUT[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return LUT;
}
export function f16Encode(a) { const o = new Uint16Array(a.length); for (let i = 0; i < a.length; i++) o[i] = f32ToF16Bits(a[i]); return o; }
export function f16Decode(h, out = new Float32Array(h.length)) { // table decode (works everywhere)
  const t = f16Table(); for (let i = 0; i < h.length; i++) out[i] = t[h[i]]; return out;
}
export function f16DecodeNative(buf, byteOffset, length) { // Float16Array (Chrome 135+, Firefox 129+, Safari 18.2+)
  return new Float32Array(new Float16Array(buf, byteOffset, length));
}

// int8 with per-OUTPUT-column scale (alternative), and two-sided (row x column) scaling; return dequantised f32
export function fakeQuantCols(W, bits) {
  const rows = W.length / G, qmax = bits === 8 ? 127 : 32767, out = new Float32Array(W.length);
  for (let i = 0; i < G; i++) {
    let mx = 0; for (let j = 0; j < rows; j++) { const a = Math.abs(W[j * G + i]); if (a > mx) mx = a; }
    const s = mx > 0 ? mx / qmax : 1; for (let j = 0; j < rows; j++) out[j * G + i] = Math.round(W[j * G + i] / s) * s;
  }
  return out;
}
export function fakeQuantTwoSided(W, bits, iters = 8) { // W[j][i] ~= r[j] * c[i] * q, q in [-qmax, qmax]
  const rows = W.length / G, qmax = bits === 8 ? 127 : 32767, r = new Float64Array(rows).fill(1), c = new Float64Array(G).fill(1);
  for (let it = 0; it < iters; it++) {
    for (let j = 0; j < rows; j++) { let mx = 0; for (let i = 0; i < G; i++) { const a = Math.abs(W[j * G + i]) / c[i]; if (a > mx) mx = a; } r[j] = mx || 1; }
    for (let i = 0; i < G; i++) { let mx = 0; for (let j = 0; j < rows; j++) { const a = Math.abs(W[j * G + i]) / r[j]; if (a > mx) mx = a; } c[i] = mx || 1; }
  }
  const out = new Float32Array(W.length);
  for (let j = 0; j < rows; j++) for (let i = 0; i < G; i++) { const s = r[j] * c[i] / qmax; out[j * G + i] = Math.round(Math.max(-qmax, Math.min(qmax, W[j * G + i] / s))) * s; }
  return out;
}

// ---- ".hws" weight file (written by export_hws.py) ---------------------------------------------------
// parseHws(ArrayBuffer) -> { header, tensors: {name: Float32Array}, quant: {name: {q, scale, bits}} }
// f32 tensors are zero-copy views; f16 uses the native Float16Array when available, else a 64K table.
export function parseHws(buf) {
  const u8 = new Uint8Array(buf);
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'HWS1') throw new Error('not a HWS1 file');
  const n = new DataView(buf).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + n)));
  const base = 8 + n, tensors = {}, quant = {};
  for (const e of header.tensors) {
    const o = base + e.offset;
    if (e.dtype === 'f32') tensors[e.name] = new Float32Array(buf, o, e.length);
    else if (e.dtype === 'f16') tensors[e.name] = typeof Float16Array !== 'undefined' ? new Float32Array(new Float16Array(buf, o, e.length)) : f16Decode(new Uint16Array(buf, o, e.length));
    else {
      const bits = e.dtype === 'i16r' ? 16 : 8, rows = e.shape[0], cols = e.length / rows;
      const q = bits === 16 ? new Int16Array(buf, o, e.length) : new Int8Array(buf, o, e.length);
      const scale = new Float32Array(buf, base + e.scale_offset, rows), W = new Float32Array(e.length);
      for (let j = 0; j < rows; j++) { const s = scale[j], p = j * cols; for (let i = 0; i < cols; i++) W[p + i] = q[p + i] * s; }
      tensors[e.name] = W; quant[e.name] = { q, scale, bits };
    }
  }
  return { header, tensors, quant };
}

// ArrayBuffer of a .hws file -> packed model for createJsEngine / createWasmEngine
export function modelFromHws(buf) {
  const { header, tensors, quant } = parseHws(buf);
  return packModel(tensors, header.V, { charset: header.charset, mu: header.mu, std: header.std,
    quant: { W1: quant['lstm1.W_xh'], W2: quant['lstm2.W_xh'], W3: quant['lstm3.W_xh'] } });
}
