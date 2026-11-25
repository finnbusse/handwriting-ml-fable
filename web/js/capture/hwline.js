// Build and validate an hwline/v1 record (docs/schema/hwline_v1.schema.json).
import { rateHz, countDtOver } from './qa.js';

const nfc = (s) => String(s).normalize('NFC');
const r4 = (v) => Math.round(v * 1e4) / 1e4;

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export { uuid };

/** Timestamp grid: 0.1 ms in Chrome (0.005 when cross-origin isolated). */
function resolutionMs(strokes) {
  const ts = [];
  for (const s of strokes) for (const t of s.t) ts.push(t);
  if (!ts.length) return null;
  const on = (g) => ts.every((t) => Math.abs(t / g - Math.round(t / g)) < 1e-6);
  if (on(1)) return 1;
  if (on(0.1)) return 0.1;
  return 0.01;
}

export function displayMode() {
  for (const m of ['fullscreen', 'standalone', 'minimal-ui']) {
    if (matchMedia(`(display-mode: ${m})`).matches) return m;
  }
  return 'browser';
}

/**
 * ctx: {
 *   cfg, sessionId, seq, prompt:{id,set,text,lang}, status, flags, attempt, edits,
 *   rec (recorder), canvasCss:[w,h], canvasPx:[w,h], dpr, guides, uaData, layoutInfo
 * }
 */
export function buildRecord(ctx) {
  const rec = ctx.rec;
  const strokes = rec.strokes.map((s) => {
    const o = { x: s.x.slice(), y: s.y.slice(), t: s.t.slice(), p: s.p.slice(),
                tiltX: s.tiltX.slice(), tiltY: s.tiltY.slice(), buttons: s.buttons,
                end: s.end || 'unknown', up: s.up || null };
    return o;
  });
  const types = {};
  for (const s of rec.strokes) types[s.pointerType] = (types[s.pointerType] || 0) + 1;
  const ptype = Object.keys(types).sort((a, b) => types[b] - types[a])[0] || 'pen';
  const pressures = new Set();
  for (const s of strokes) for (const p of s.p) pressures.add(p);
  const vv = window.visualViewport;
  const so = screen.orientation || {};
  const a = rec.anomalies;
  const rate = rateHz(strokes);
  const api = rec.rawSamples > 0 ? 'pointerrawupdate'
    : (rec.caps.getCoalescedEvents ? 'pointermove+coalesced' : 'pointermove');
  return {
    schema: 'hwline/v1',
    id: ctx.id || uuid(),
    session_id: ctx.sessionId,
    seq: ctx.seq,
    writer_id: ctx.cfg.writerId,
    created_at: new Date().toISOString(),
    tz_offset_min: -new Date().getTimezoneOffset(),
    app: { name: ctx.cfg.appName, version: ctx.cfg.version },
    prompt: { id: ctx.prompt.id, set: ctx.prompt.set, text: nfc(ctx.prompt.text), lang: ctx.prompt.lang || 'de' },
    text: nfc(ctx.prompt.text),
    status: ctx.flags.length ? 'flagged' : 'accepted',
    attempt: ctx.attempt,
    edits: { undo: ctx.edits.undo, clear: ctx.edits.clear },
    flags: ctx.flags.slice(),
    time: { unit: 'ms', base: 'first_pen_down', t0_epoch_ms: r4(performance.timeOrigin + rec.timeBase),
            source: 'event.timeStamp', resolution_ms: resolutionMs(strokes) },
    coord: { unit: 'css_px', origin: 'canvas_top_left', y_down: true,
             canvas_css: ctx.canvasCss, canvas_px: ctx.canvasPx,
             canvas_client_rect: (rec.firstRect || [0, 0, ctx.canvasCss[0], ctx.canvasCss[1]]).map(r4),
             dpr: ctx.dpr, visual_viewport_scale: vv ? vv.scale : 1,
             mm_per_unit: null, mm_source: null },
    guides: ctx.guides,
    screen: { screen_css: [screen.width, screen.height], inner_css: [innerWidth, innerHeight],
              orientation: so.type || (innerWidth >= innerHeight ? 'landscape' : 'portrait'),
              angle: typeof so.angle === 'number' ? so.angle : 0,
              fullscreen: !!document.fullscreenElement, display_mode: displayMode() },
    device: { ua: navigator.userAgent, ua_data: ctx.uaData || null,
              max_touch_points: navigator.maxTouchPoints || 0, language: navigator.language },
    // rate_hz is left out when it cannot be measured (only taps): the schema has no null for it.
    pointer: Object.assign({ type: ptype, api, pen_only: rec.penOnly }, rate === null ? {} : { rate_hz: rate },
                           { pressure_levels_seen: pressures.size }),
    strokes,
    // cancelled / button_strokes come from the strokes actually stored (undo removes their share).
    anomalies: { cancelled: rec.strokes.filter((s) => s.end === 'cancel').length,
                 touch_ignored: a.touch_ignored, non_monotonic: a.non_monotonic,
                 same_t_dropped: a.same_t_dropped || 0,
                 dt_gt_10ms: countDtOver(strokes, 10),
                 button_strokes: rec.strokes.filter((s) => s.button).length },
  };
}

/** Structural check of the fields the schema requires. Returns a list of errors. */
export function validate(r) {
  const err = [];
  const need = (cond, msg) => { if (!cond) err.push(msg); };
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  need(isObj(r), 'record is not an object');
  if (!isObj(r)) return err;
  need(r.schema === 'hwline/v1', 'schema');
  for (const k of ['id', 'session_id', 'created_at', 'text']) need(typeof r[k] === 'string' && r[k], k);
  need(isObj(r.app) && typeof r.app.name === 'string' && typeof r.app.version === 'string', 'app');
  need(isObj(r.prompt) && typeof r.prompt.id === 'string' && typeof r.prompt.text === 'string', 'prompt');
  need(r.status === 'accepted' || r.status === 'flagged', 'status');
  need(isObj(r.time) && r.time.unit === 'ms' && r.time.base === 'first_pen_down' && isNum(r.time.t0_epoch_ms), 'time');
  const c = r.coord;
  need(isObj(c) && ['css_px', 'device_px'].includes(c.unit) && c.origin === 'canvas_top_left' && c.y_down === true
       && Array.isArray(c.canvas_css) && c.canvas_css.length === 2 && isNum(c.dpr), 'coord');
  need(r.guides === null || isObj(r.guides), 'guides');
  need(isObj(r.screen), 'screen');
  need(isObj(r.device) && typeof r.device.ua === 'string', 'device');
  need(isObj(r.pointer) && ['pen', 'touch', 'mouse'].includes(r.pointer.type)
       && ['pointerrawupdate', 'pointermove+coalesced', 'pointermove'].includes(r.pointer.api), 'pointer');
  need(Array.isArray(r.strokes) && r.strokes.length >= 1, 'strokes');
  let last = -Infinity;
  (r.strokes || []).forEach((s, i) => {
    const n = s && s.x ? s.x.length : -1;
    need(n >= 1 && ['y', 't', 'p'].every((k) => Array.isArray(s[k]) && s[k].length === n), `strokes[${i}] arrays`);
    for (const k of ['x', 'y', 't', 'p', 'tiltX', 'tiltY']) {
      if (s[k] !== undefined) need(s[k].every(isNum), `strokes[${i}].${k} numbers`);
    }
    for (const t of s.t || []) { if (!(t > last)) { err.push(`strokes[${i}].t not strictly increasing`); break; } last = t; }
  });
  return err;
}
