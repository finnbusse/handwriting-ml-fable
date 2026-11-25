// hwsyn_kernel.c -- freestanding WebAssembly SIMD128 kernel: one generation step of the Graves handwriting
// synthesis network (3 x peephole LSTM(400), soft window(10 Gaussians), 20-component MDN head).
// No libc, no imports, baseline wasm SIMD only (no relaxed-simd, no threads). Build: see build.sh
//   clang --target=wasm32 -O3 -msimd128 -mbulk-memory -ffreestanding -nostdlib -fno-builtin \
//         -DWQ=16 -Wl,--no-entry -Wl,--strip-all -o hwsyn_i16.wasm hwsyn_kernel.c
//
// The recurrent/"below" weights (97% of all multiply-adds) live in the dense blocks D1..D3:
//   WQ = 0   float32, input-major rows of 1600                         z += x_j * W[j,:]        (15 MB / step)
//   WQ = 16  int16, per-input-row scale, row pairs interleaved         pmaddwd-style i32x4.dot_i16x8_s
//   WQ = 8   int8,  per-input-row scale, row pairs interleaved         i16x8.load8x8_s + i32x4.dot_i16x8_s
// For WQ != 0 the activations h_j*scale_j are re-quantised every step to int16 fixed point (dynamic range),
// products are exact integers; accumulation is float (WQ=16) or int32 (WQ=8).
// The 3 pen-input rows and the V soft-window rows of every LSTM stay float32 ("side rows" R1..R3) and are
// applied sparsely (only characters with window weight > PHI_EPS).
#include <wasm_simd128.h>
#include <stdint.h>
#include <stddef.h>

#ifndef WQ
#define WQ 16
#endif
#define H 400
#define G 1600
#define K 10
#define KP 12
#define M 20
#define NOUT 121
#define UMAX 512
#define VMAX 256
#define PHI_EPS 1e-12f
#define EXPORT(name) __attribute__((export_name(#name)))

#if WQ == 0
typedef float wt;
#elif WQ == 16
typedef int16_t wt;
#define QM 32767.0f
#else
typedef int8_t wt;
#define QM 16383.0f   /* 800 rows * 16383 * 127 < 2^31 : int32 accumulation cannot overflow */
#endif

extern unsigned char __heap_base;
static uintptr_t brk_ = 0;
EXPORT(hw_alloc) void* hw_alloc(uint32_t bytes) {
  if (!brk_) brk_ = ((uintptr_t)&__heap_base + 63) & ~(uintptr_t)63;
  uintptr_t p = brk_;
  brk_ = (brk_ + bytes + 63) & ~(uintptr_t)63;
  uintptr_t have = (uintptr_t)__builtin_wasm_memory_size(0) << 16;
  if (brk_ > have && __builtin_wasm_memory_grow(0, (brk_ - have + 65535) >> 16) == (size_t)-1) return 0;
  return (void*)p;
}

static int V;
static float *R1, *R2, *R3;              // side rows: (3 + V) x G float32  = [x(3) | w(V)]
static wt *D1, *D2, *D3;                 // dense rows: D1 = [h1] (400), D2 = [h1 | h2] (800), D3 = [h2 | h3] (800)
static float S1[H], S2[2 * H], S3[2 * H];// per-row scales of the dense rows (WQ != 0)
static float B1[G], B2[G], B3[G];        // [b_i | b_f | b_c | b_o]
static float P1[3 * H], P2[3 * H], P3[3 * H]; // peepholes [W_ci | W_cf | W_co]
static float WW[3 * K * H], WB[3 * K + 2];    // window: rows [alpha(K) | beta(K) | kappa(K)]
static float WM[NOUT * 3 * H], BM[NOUT + 3];  // head: rows [pi(M) | mu(2M) | sd(2M) | ro(M) | eos]
// recurrent state in one block so that JS can snapshot/restore it (e.g. after style priming):
// [h1 h2 h3 | c1 | c2 | c3 | kappa(12) | window vector(VMAX)]
#define STATE_N (6 * H + KP + VMAX)
static float st[STATE_N] __attribute__((aligned(16)));
#define hh st
#define c1 (st + 3 * H)
#define c2 (st + 4 * H)
#define c3 (st + 5 * H)
#define kappa (st + 6 * H)
#define wv (st + 6 * H + KP)
static float z[G] __attribute__((aligned(16)));
static float out[NOUT + 3], phi[UMAX];
static int32_t text[UMAX];
static int U;
static uint32_t info[32];

#define F4 wasm_f32x4_splat
#define LD wasm_v128_load
#define ST wasm_v128_store
#define ADD wasm_f32x4_add
#define MUL wasm_f32x4_mul
#define SUB wasm_f32x4_sub
#define DIV wasm_f32x4_div

// Cephes-style expf (~1 ulp); argument clamped so that the result is always a normal float (no denormals).
static inline v128_t exp_ps(v128_t x) {
  x = wasm_f32x4_pmin(x, F4(88.3762626647949f));
  x = wasm_f32x4_pmax(x, F4(-87.33654f));
  v128_t fx = wasm_f32x4_nearest(MUL(x, F4(1.44269504088896341f)));
  x = SUB(x, MUL(fx, F4(0.693359375f)));
  x = SUB(x, MUL(fx, F4(-2.12194440e-4f)));
  v128_t x2 = MUL(x, x);
  v128_t y = F4(1.9875691500E-4f);
  y = ADD(MUL(y, x), F4(1.3981999507E-3f));
  y = ADD(MUL(y, x), F4(8.3334519073E-3f));
  y = ADD(MUL(y, x), F4(4.1665795894E-2f));
  y = ADD(MUL(y, x), F4(1.6666665459E-1f));
  y = ADD(MUL(y, x), F4(5.0000001201E-1f));
  y = ADD(ADD(MUL(y, x2), x), F4(1.0f));
  v128_t n = wasm_i32x4_shl(wasm_i32x4_add(wasm_i32x4_trunc_sat_f32x4(fx), wasm_i32x4_splat(127)), 23);
  return MUL(y, n);
}
static inline v128_t sigmoid_ps(v128_t x) { return DIV(F4(1.0f), ADD(F4(1.0f), exp_ps(wasm_f32x4_neg(x)))); }
static inline v128_t tanh_ps(v128_t x) { return SUB(DIV(F4(2.0f), ADD(F4(1.0f), exp_ps(MUL(x, F4(-2.0f))))), F4(1.0f)); }
static inline float hsum(v128_t s) {
  return (wasm_f32x4_extract_lane(s, 0) + wasm_f32x4_extract_lane(s, 1)) + (wasm_f32x4_extract_lane(s, 2) + wasm_f32x4_extract_lane(s, 3));
}

// z += a * row   (float32 side rows)
static inline void add_row(const float* restrict w, float a) {
  v128_t x0 = F4(a);
  for (int i = 0; i < G; i += 4) ST(z + i, ADD(LD(z + i), MUL(x0, LD(w + i))));
}
static inline void side_rows(const float* restrict R, float x0, float x1, float x2) {
  v128_t a = F4(x0), b = F4(x1), c = F4(x2);
  for (int i = 0; i < G; i += 4)
    ST(z + i, ADD(ADD(LD(z + i), MUL(a, LD(R + i))), ADD(MUL(b, LD(R + G + i)), MUL(c, LD(R + 2 * G + i)))));
  for (int v = 0; v < V; v++) if (wv[v] > PHI_EPS) add_row(R + (size_t)(3 + v) * G, wv[v]);
}

// z += sum_{j<n} x[j] * D[j,:]      (n = 400 or 800, multiple of 8)
#if WQ == 0
#define TERM(xr, r) MUL(xr, LD(w + (size_t)(r) * G + i))
static void dense(const float* restrict D, const float* restrict S, const float* restrict x, int n) {
  (void)S;
  for (int j = 0; j < n; j += 8) {
#ifdef CACHETEST /* diagnostic: reuse the same 8 rows (51 KB, cache resident) -> compute-bound speed */
    const float* w = D;
#else
    const float* w = D + (size_t)j * G;
#endif
    v128_t x0 = F4(x[j]), x1 = F4(x[j + 1]), x2 = F4(x[j + 2]), x3 = F4(x[j + 3]);
    v128_t x4 = F4(x[j + 4]), x5 = F4(x[j + 5]), x6 = F4(x[j + 6]), x7 = F4(x[j + 7]);
    for (int i = 0; i < G; i += 4) {
      v128_t s0 = ADD(TERM(x0, 0), TERM(x1, 1)), s1 = ADD(TERM(x2, 2), TERM(x3, 3));
      v128_t s2 = ADD(TERM(x4, 4), TERM(x5, 5)), s3 = ADD(TERM(x6, 6), TERM(x7, 7));
      ST(z + i, ADD(LD(z + i), ADD(ADD(s0, s1), ADD(s2, s3))));
    }
  }
}
#else
static int16_t mq[2 * H] __attribute__((aligned(16)));
static float mf[2 * H] __attribute__((aligned(16)));
#if WQ == 16
static float acc[G] __attribute__((aligned(16)));
#else
static int32_t acc[G] __attribute__((aligned(16)));
#endif
// D holds row pairs interleaved: pair p = rows (2p, 2p+1) -> [q(2p,0), q(2p+1,0), q(2p,1), q(2p+1,1), ...]
static void dense(const wt* restrict D, const float* restrict S, const float* restrict x, int n) {
  // multipliers m_j = x_j * scale_j, re-quantised to int16 with a per-call step delta = max|m| / QM
  v128_t mx = F4(0);
  for (int j = 0; j < n; j += 4) { v128_t m = MUL(LD(x + j), LD(S + j)); ST(mf + j, m); mx = wasm_f32x4_pmax(wasm_f32x4_abs(m), mx); }
  float m1 = wasm_f32x4_extract_lane(mx, 0), m2 = wasm_f32x4_extract_lane(mx, 1), m3 = wasm_f32x4_extract_lane(mx, 2), m4 = wasm_f32x4_extract_lane(mx, 3);
  float mmax = m1; if (m2 > mmax) mmax = m2; if (m3 > mmax) mmax = m3; if (m4 > mmax) mmax = m4;
  if (!(mmax > 1e-30f)) return;
  float delta = mmax / QM;
  v128_t inv = F4(QM / mmax);
  for (int j = 0; j < n; j += 8) {
    v128_t a = wasm_i32x4_trunc_sat_f32x4(wasm_f32x4_nearest(MUL(LD(mf + j), inv)));
    v128_t b = wasm_i32x4_trunc_sat_f32x4(wasm_f32x4_nearest(MUL(LD(mf + j + 4), inv)));
    ST(mq + j, wasm_i16x8_narrow_i32x4(a, b));
  }
#if WQ == 16
  for (int i = 0; i < G; i += 4) ST(acc + i, F4(0));
#else
  for (int i = 0; i < G; i += 4) ST(acc + i, wasm_i32x4_splat(0));
#endif
  const int32_t* mp = (const int32_t*)mq;          // one int32 = (m[2p+1] << 16) | m[2p]  -> [m_a, m_b] x 4 when splatted
  for (int p = 0; p < n / 2; p += 4) {
    const wt* w = D + (size_t)p * 2 * G;
    v128_t k0 = wasm_i32x4_splat(mp[p]), k1 = wasm_i32x4_splat(mp[p + 1]), k2 = wasm_i32x4_splat(mp[p + 2]), k3 = wasm_i32x4_splat(mp[p + 3]);
#if WQ == 16
    for (int i = 0; i < G; i += 4) {
      v128_t d0 = wasm_i32x4_dot_i16x8(LD(w + 2 * i), k0), d1 = wasm_i32x4_dot_i16x8(LD(w + 2 * G + 2 * i), k1);
      v128_t d2 = wasm_i32x4_dot_i16x8(LD(w + 4 * G + 2 * i), k2), d3 = wasm_i32x4_dot_i16x8(LD(w + 6 * G + 2 * i), k3);
      v128_t f = ADD(ADD(wasm_f32x4_convert_i32x4(d0), wasm_f32x4_convert_i32x4(d1)), ADD(wasm_f32x4_convert_i32x4(d2), wasm_f32x4_convert_i32x4(d3)));
      ST(acc + i, ADD(LD(acc + i), f));
    }
#else
    for (int i = 0; i < G; i += 4) {
      v128_t d0 = wasm_i32x4_dot_i16x8(wasm_i16x8_load8x8(w + 2 * i), k0), d1 = wasm_i32x4_dot_i16x8(wasm_i16x8_load8x8(w + 2 * G + 2 * i), k1);
      v128_t d2 = wasm_i32x4_dot_i16x8(wasm_i16x8_load8x8(w + 4 * G + 2 * i), k2), d3 = wasm_i32x4_dot_i16x8(wasm_i16x8_load8x8(w + 6 * G + 2 * i), k3);
      ST(acc + i, wasm_i32x4_add(LD(acc + i), wasm_i32x4_add(wasm_i32x4_add(d0, d1), wasm_i32x4_add(d2, d3))));
    }
#endif
  }
  v128_t dl = F4(delta);
#if WQ == 16
  for (int i = 0; i < G; i += 4) ST(z + i, ADD(LD(z + i), MUL(dl, LD(acc + i))));
#else
  for (int i = 0; i < G; i += 4) ST(z + i, ADD(LD(z + i), MUL(dl, wasm_f32x4_convert_i32x4(LD(acc + i)))));
#endif
}
#endif

static inline float dot(const float* restrict a, const float* restrict b, int n) { // n % 16 == 0
  v128_t s0 = F4(0), s1 = F4(0), s2 = F4(0), s3 = F4(0);
  for (int j = 0; j < n; j += 16) {
    s0 = ADD(s0, MUL(LD(a + j), LD(b + j)));
    s1 = ADD(s1, MUL(LD(a + j + 4), LD(b + j + 4)));
    s2 = ADD(s2, MUL(LD(a + j + 8), LD(b + j + 8)));
    s3 = ADD(s3, MUL(LD(a + j + 12), LD(b + j + 12)));
  }
  return hsum(ADD(ADD(s0, s1), ADD(s2, s3)));
}

static void gates(float* restrict c, float* restrict h, const float* restrict P) {
  for (int n = 0; n < H; n += 4) {
    v128_t cp = LD(c + n);
    v128_t ig = sigmoid_ps(ADD(LD(z + n), MUL(cp, LD(P + n))));
    v128_t fg = sigmoid_ps(ADD(LD(z + H + n), MUL(cp, LD(P + H + n))));
    v128_t cn = ADD(MUL(fg, cp), MUL(ig, tanh_ps(LD(z + 2 * H + n))));
    v128_t og = sigmoid_ps(ADD(LD(z + 3 * H + n), MUL(cn, LD(P + 2 * H + n))));
    ST(c + n, cn);
    ST(h + n, MUL(og, tanh_ps(cn)));
  }
}
static inline void copy(float* restrict d, const float* restrict s, int n) { for (int i = 0; i < n; i += 4) ST(d + i, LD(s + i)); }

EXPORT(hw_reset) void hw_reset(void) { for (int i = 0; i < STATE_N; i++) st[i] = 0; }
// text codes are written by JS into text[]; keep != 0 keeps the recurrent state (text extended after priming)
EXPORT(hw_set_text) void hw_set_text(int u, int keep) { U = u > UMAX ? UMAX : u; if (!keep) hw_reset(); }

// returns a uint32 table: [WQ, V, R1,R2,R3, D1,D2,D3, S1,S2,S3, B1,B2,B3, P1,P2,P3, WW,WB, WM,BM, text,out,phi,kappa, state, UMAX, STATE_N]
EXPORT(hw_init) uint32_t* hw_init(int v) {
  if (v < 1 || v > VMAX) return 0;
  V = v;
  R1 = hw_alloc((uint32_t)(3 + V) * G * 4); R2 = hw_alloc((uint32_t)(3 + V) * G * 4); R3 = hw_alloc((uint32_t)(3 + V) * G * 4);
  D1 = hw_alloc((uint32_t)H * G * sizeof(wt)); D2 = hw_alloc((uint32_t)2 * H * G * sizeof(wt)); D3 = hw_alloc((uint32_t)2 * H * G * sizeof(wt));
  if (!R1 || !R2 || !R3 || !D1 || !D2 || !D3) return 0;
  uint32_t t[] = {WQ, (uint32_t)V, (uint32_t)R1, (uint32_t)R2, (uint32_t)R3, (uint32_t)D1, (uint32_t)D2, (uint32_t)D3,
                  (uint32_t)S1, (uint32_t)S2, (uint32_t)S3, (uint32_t)B1, (uint32_t)B2, (uint32_t)B3,
                  (uint32_t)P1, (uint32_t)P2, (uint32_t)P3, (uint32_t)WW, (uint32_t)WB, (uint32_t)WM, (uint32_t)BM,
                  (uint32_t)text, (uint32_t)out, (uint32_t)phi, (uint32_t)kappa, (uint32_t)st, UMAX, STATE_N};
  for (unsigned i = 0; i < sizeof(t) / 4; i++) info[i] = t[i];
  hw_reset();
  return info;
}

// One generation step. Input: previous point (normalised dx, dy, pen-up) and the sampling bias.
// Output buffer: [pi(20) softmaxed | mu1(20) mu2(20) | sd1(20) sd2(20) | rho(20) | eos], phi[0..U)
EXPORT(hw_step) void hw_step(float x0, float x1, float x2, float bias) {
  // ---- LSTM 1 (window vector of the previous step)
  copy(z, B1, G);
  side_rows(R1, x0, x1, x2);
  dense(D1, S1, hh, H);
  gates(c1, hh, P1);
  // ---- soft window: phi_u = sum_k exp(a_k - b_k (kappa_k - u)^2)
  float pre[3 * KP];
  for (int r = 0; r < 3 * K; r++) pre[(r / K) * KP + (r % K)] = dot(WW + r * H, hh, H) + WB[r];
  pre[K] = pre[K + 1] = -1e30f;                 // padding lanes: exp() -> ~1e-38
  pre[KP + K] = pre[KP + K + 1] = 0; pre[2 * KP + K] = pre[2 * KP + K + 1] = 0;
  v128_t ah[3], be[3], ka[3];
  for (int q = 0; q < 3; q++) {
    ah[q] = LD(pre + 4 * q);
    be[q] = exp_ps(LD(pre + KP + 4 * q));
    ka[q] = ADD(LD(kappa + 4 * q), exp_ps(LD(pre + 2 * KP + 4 * q)));
    ST(kappa + 4 * q, ka[q]);
  }
  for (int v = 0; v < V; v++) wv[v] = 0;
  for (int u = 0; u < U; u++) {
    v128_t uu = F4((float)u), s = F4(0);
    for (int q = 0; q < 3; q++) { v128_t d = SUB(ka[q], uu); s = ADD(s, exp_ps(SUB(ah[q], MUL(be[q], MUL(d, d))))); }
    float p = hsum(s);
    phi[u] = p;
    wv[text[u]] += p;
  }
  // ---- LSTM 2: dense input [h1 | h2] = hh[0..800)
  copy(z, B2, G);
  side_rows(R2, x0, x1, x2);
  dense(D2, S2, hh, 2 * H);
  gates(c2, hh + H, P2);
  // ---- LSTM 3: dense input [h2 | h3] = hh[400..1200)
  copy(z, B3, G);
  side_rows(R3, x0, x1, x2);
  dense(D3, S3, hh + H, 2 * H);
  gates(c3, hh + 2 * H, P3);
  // ---- mixture head on [h1 | h2 | h3]
  float y[NOUT + 3];
  for (int r = 0; r < NOUT; r++) y[r] = dot(WM + r * 3 * H, hh, 3 * H) + BM[r];
  y[NOUT] = y[NOUT + 1] = y[NOUT + 2] = 0;
  float mx = -1e30f, b1 = 1.0f + bias, sum = 0;
  for (int k = 0; k < M; k++) { y[k] *= b1; if (y[k] > mx) mx = y[k]; }
  for (int k = 0; k < M; k += 4) ST(out + k, exp_ps(SUB(LD(y + k), F4(mx))));
  for (int k = 0; k < M; k++) sum += out[k];
  float inv = 1.0f / sum;
  for (int k = 0; k < M; k++) out[k] *= inv;
  for (int k = M; k < 3 * M; k++) out[k] = y[k];
  for (int k = 3 * M; k < 5 * M; k += 4) ST(out + k, exp_ps(SUB(LD(y + k), F4(bias))));
  for (int k = 5 * M; k < 6 * M; k += 4) ST(out + k, tanh_ps(LD(y + k)));
  float eo[4]; ST(eo, sigmoid_ps(F4(y[6 * M])));
  out[6 * M] = eo[0];
}
