// Raw pointer capture (SPEC 2.2/2.3). No rendering, no policy beyond pen-only.
// Records RAW samples only; the caller draws via the onSamples callback.
// Coordinates: CSS px relative to the canvas' top-left at pointerdown (clientX - rect.left).
// Time: ms relative to the first pen-down of the line (event.timeStamp domain),
// strictly increasing over the WHOLE line (not only within a stroke).
// The pointerup/pointercancel sample is kept outside the arrays (stroke.up).
// Predicted events are never read.

export function capabilities() {
  const PE = typeof PointerEvent !== 'undefined' ? PointerEvent.prototype : {};
  return {
    secureContext: !!window.isSecureContext,
    pointerrawupdate: 'onpointerrawupdate' in window,
    getCoalescedEvents: 'getCoalescedEvents' in PE,
    altitudeAngle: 'altitudeAngle' in PE,
  };
}

export function createRecorder(canvas, opts = {}) {
  let penOnly = opts.penOnly !== false;
  const onSamples = opts.onSamples || (() => {});
  const onStrokeStart = opts.onStrokeStart || (() => {});
  const onStrokeEnd = opts.onStrokeEnd || (() => {});
  const onIgnored = opts.onIgnored || (() => {});
  const caps = capabilities();

  let timeBase = null;     // event.timeStamp of the first pen-down of this line
  let firstRect = null;    // canvas client rect at first pen-down
  let strokes = [];
  let cur = null;
  let rect = null;
  let lastT = -Infinity;   // last stored (rounded) t, over the whole line
  let lastDropKey = '';    // last sample counted in same_t_dropped
  let rawSamples = 0;      // samples that arrived first through pointerrawupdate
  let types = {};
  let anomalies;
  // cancelled and button_strokes are derived from the stored strokes in hwline.js,
  // so undo cannot leave them out of step; these are the counters only the recorder sees.
  const freshAnomalies = () => ({ cancelled: 0, touch_ignored: 0, non_monotonic: 0, same_t_dropped: 0,
    button_strokes: 0, multi_pointer: 0, empty_strokes: 0 });
  anomalies = freshAnomalies();
  let paused = false;

  const r4 = (v) => Math.round(v * 1e4) / 1e4;
  const r2 = (v) => Math.round(v * 1e2) / 1e2;

  function push(e, viaRaw) {
    const t = r2(e.timeStamp - timeBase);
    if (!(t > lastT)) {               // de-dup rawupdate vs pointermove; drop stale samples
      if (t < lastT) anomalies.non_monotonic++;
      else if (sameTimeDifferent(e)) {           // a distinct sample at an equal t
        // pointerrawupdate and pointermove deliver the same sample twice: count it once.
        const key = `${t}|${e.clientX}|${e.clientY}|${e.pressure}`;
        if (key !== lastDropKey) { anomalies.same_t_dropped++; lastDropKey = key; }
      }
      return false;
    }
    lastT = t;
    cur.x.push(r4(e.clientX - rect.left));
    cur.y.push(r4(e.clientY - rect.top));
    cur.t.push(t);
    cur.p.push(r4(e.pressure));         // 0 is a legal value: never `|| default`
    cur.tiltX.push(e.tiltX);            // 0 is a legal value
    cur.tiltY.push(e.tiltY);
    if (e.buttons & ~1) cur._btn = true;
    if (viaRaw) rawSamples++;
    return true;
  }

  /** True when e differs from the last stored sample (so dropping it loses data). */
  function sameTimeDifferent(e) {
    const n = cur.x.length;
    if (!n) return true;
    return cur.x[n - 1] !== r4(e.clientX - rect.left) || cur.y[n - 1] !== r4(e.clientY - rect.top)
      || cur.p[n - 1] !== r4(e.pressure);
  }

  function accepts(e) {
    return e.pointerType === 'pen' || (!penOnly && (e.pointerType === 'touch' || e.pointerType === 'mouse'));
  }

  function down(e) {
    if (e.target !== canvas) return;
    e.preventDefault();
    if (paused) return;
    if (!accepts(e)) { anomalies.touch_ignored++; onIgnored(e); return; }
    if (cur) {
      anomalies.multi_pointer++;
      // Finger mode: a resting palm must not take the stroke from the pen.
      if (!(cur.pointerType !== 'pen' && e.pointerType === 'pen')) return;
      try { canvas.releasePointerCapture(cur.pointerId); } catch (_) {}
      cur = null;
      if (!strokes.length) { timeBase = null; firstRect = null; lastT = -Infinity; rawSamples = 0; }
    }
    rect = canvas.getBoundingClientRect();   // once per stroke; layout must not move during a line
    if (timeBase === null) {
      timeBase = e.timeStamp;
      firstRect = [rect.left, rect.top, rect.width, rect.height];
    }
    cur = { pointerId: e.pointerId, pointerType: e.pointerType, buttons: e.buttons,
            x: [], y: [], t: [], p: [], tiltX: [], tiltY: [], end: null, up: null, _btn: false };
    if (e.button !== 0 || (e.buttons & ~1)) cur._btn = true;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    push(e, false);
    onStrokeStart(cur);
    onSamples(cur, 0);
  }

  function makeMove(viaRaw) {
    return (e) => {
      if (!cur || e.pointerId !== cur.pointerId) return;
      const from = cur.x.length;
      const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (list.length) { for (const ce of list) push(ce, viaRaw); } else push(e, viaRaw);
      if (cur.x.length > from) onSamples(cur, from);
    };
  }

  function makeEnd(kind) {
    return (e) => {
      if (!cur || e.pointerId !== cur.pointerId) return;
      // Coalesced samples that arrived only with the up event (not the up position itself).
      if (kind === 'up' && e.getCoalescedEvents) {
        const from = cur.x.length;
        for (const ce of e.getCoalescedEvents()) {
          if (ce.timeStamp < e.timeStamp) push(ce, false);
        }
        if (cur.x.length > from) onSamples(cur, from);
      }
      cur.end = kind;
      const n = cur.x.length;
      if (kind === 'up') cur.up = { t: r2(e.timeStamp - timeBase), x: r4(e.clientX - rect.left), y: r4(e.clientY - rect.top) };
      // A cancel event's coordinates are not trustworthy (synthetic ones carry 0,0):
      // keep the last real position with the cancel time.
      else cur.up = n ? { t: Math.max(r2(e.timeStamp - timeBase), cur.t[n - 1]), x: cur.x[n - 1], y: cur.y[n - 1] } : null;
      if (kind === 'cancel') anomalies.cancelled++;
      if (cur._btn) anomalies.button_strokes++;
      const s = cur; cur = null;
      if (!s.x.length) { anomalies.empty_strokes++; return; }   // every sample was stale: nothing to keep
      types[s.pointerType] = (types[s.pointerType] || 0) + 1;
      delete s.pointerId;
      s.button = s._btn; delete s._btn;
      strokes.push(s);
      onStrokeEnd(s);
    };
  }

  const rawH = makeMove(true), moveH = makeMove(false);
  const upH = makeEnd('up'), cancelH = makeEnd('cancel');
  const ctx = (e) => e.preventDefault();
  canvas.addEventListener('pointerdown', down);
  if (caps.pointerrawupdate) canvas.addEventListener('pointerrawupdate', rawH);
  canvas.addEventListener('pointermove', moveH);
  canvas.addEventListener('pointerup', upH);
  canvas.addEventListener('pointercancel', cancelH);
  canvas.addEventListener('lostpointercapture', cancelH);
  canvas.addEventListener('contextmenu', ctx);

  return {
    caps, get anomalies() { return anomalies; },
    get strokes() { return strokes; },
    get timeBase() { return timeBase; },
    get firstRect() { return firstRect; },
    get active() { return !!cur; },
    get rawSamples() { return rawSamples; },
    get pointerTypes() { return Object.assign({}, types); },
    set penOnly(v) { penOnly = !!v; },
    get penOnly() { return penOnly; },
    set paused(v) { paused = !!v; if (paused) cur = null; },
    /** Take every stroke out (for "Löschen") and return them so restore() can bring them back. */
    stash() {
      const s = { strokes, timeBase, firstRect, lastT, rawSamples, types, anomalies };
      strokes = []; cur = null; timeBase = null; firstRect = null; lastT = -Infinity;
      rawSamples = 0; types = {}; anomalies = freshAnomalies();
      return s;
    },
    restore(s) {
      ({ strokes, timeBase, firstRect, lastT, rawSamples, types, anomalies } = s);
      cur = null;
    },
    undo() {
      const s = strokes.pop();
      // With no stroke left the line starts over, so t = 0 is again the first pen-down.
      if (!strokes.length) { timeBase = null; firstRect = null; lastT = -Infinity; rawSamples = 0; types = {}; }
      return s;
    },
    reset() {
      strokes = []; cur = null; timeBase = null; firstRect = null; lastT = -Infinity;
      rawSamples = 0; types = {}; anomalies = freshAnomalies();
    },
    destroy() {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointerrawupdate', rawH);
      canvas.removeEventListener('pointermove', moveH);
      canvas.removeEventListener('pointerup', upH);
      canvas.removeEventListener('pointercancel', cancelH);
      canvas.removeEventListener('lostpointercapture', cancelH);
      canvas.removeEventListener('contextmenu', ctx);
    },
  };
}
