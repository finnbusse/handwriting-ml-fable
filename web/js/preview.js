// Dataset Viewer preview of uploaded lines, written by the app itself (SPEC 2.1):
//
//   preview/<writer>/<session>/<prompt>__<id>.png     the line as an image
//   preview/<writer>/<session>/metadata.jsonl         one row per line of that session, sorted by date
//
// scripts/rebuild_preview.py produces exactly the same from Python: keep the two in sync
// (COLUMNS, the row values and the look of the image).
// Everything is made from the stored record; nothing depends on what is on screen.

/** Columns of metadata.jsonl, in this order (same list as COLUMNS in rebuild_preview.py). */
export const COLUMNS = ['file_name', 'text', 'writer', 'date', 'prompt', 'status', 'notes', 'strokes', 'points',
  'seconds', 'pen_rate_hz', 'pen', 'paper'];
/** Columns written as floats with one decimal (Python writes round(x, 1), e.g. 3.0). */
const FLOAT1 = new Set(['seconds', 'pen_rate_hz']);

export const HEIGHT_PX = 150;
export const MIN_W = 300;
export const MAX_W = 2400;
export const INK = '#16233f';
// matplotlib at 100 dpi: lw 1.3 pt -> 1.8 px; an 'o' marker of 2.4 pt is a dot of about 1.7 px radius.
const LINE_W = 1.3 * 100 / 72;
const DOT_R = 2.4 * 100 / 72 / 2;
// A full stop or an i-dot is often a tap that hardly moves; as a line it would be
// invisible. Strokes smaller than this (canvas px of the recording) are drawn as dots.
const DOT_PX = 1.5;

const inked = (record) => (record.strokes || []).filter((s) => s && s.x && s.x.length);

/** Does the record have ink to show? (Python skips lines without.) */
export const hasInk = (record) => record && record.schema === 'hwline/v1' && inked(record).length > 0;

export const folder = (record) => `preview/${record.writer_id}/${record.session_id}`;
export const pngName = (record) => `${record.prompt.id}__${record.id}.png`;
export const pngPath = (record) => `${folder(record)}/${pngName(record)}`;
export const metadataPath = (record) => `${folder(record)}/metadata.jsonl`;

/** Python's round(x, 1): round half to even on the exact binary value. */
function round1(x) {
  const s = x * 10;
  const f = Math.floor(s);
  if (s - f === 0.5 && (f + 0.5) / 10 === x) return (f % 2 === 0 ? f : f + 1) / 10;
  return Number(x.toFixed(1));
}

/** One metadata row (all columns, always the same types). */
export function metaRow(record) {
  const strokes = inked(record);
  const guides = record.guides || {};
  const pointer = record.pointer || {};
  const t0 = strokes.length ? strokes[0].t[0] : 0;
  const last = strokes.length ? strokes[strokes.length - 1].t : [0];
  return {
    file_name: pngName(record),
    text: String(record.text || ''),
    writer: String(record.writer_name || record.writer_id || ''),
    date: String(record.created_at || '').slice(0, 19).replace('T', ' '),
    prompt: String((record.prompt && record.prompt.id) || ''),
    status: String(record.status || ''),
    notes: (record.flags || []).join(', '),
    strokes: strokes.length,
    points: strokes.reduce((n, s) => n + s.x.length, 0),
    seconds: round1((last[last.length - 1] - t0) / 1000),
    pen_rate_hz: round1(Number(pointer.rate_hz) || 0),
    pen: String(guides.pen || ''),
    paper: String(guides.paper || ''),
  };
}

/** A row as one JSON line, formatted like Python's json.dumps(..., ensure_ascii=False). */
export function rowJson(row) {
  const val = (k) => {
    const v = row[k];
    if (FLOAT1.has(k)) return Number.isInteger(v) ? v.toFixed(1) : String(v);
    return JSON.stringify(v);
  };
  return '{' + COLUMNS.map((k) => `${JSON.stringify(k)}: ${val(k)}`).join(', ') + '}';
}

/** metadata.jsonl of one session from its records (those without ink are left out). */
export function metadataJsonl(records) {
  const rows = records.filter(hasInk)
    .slice().sort((a, b) => (pngName(a) < pngName(b) ? -1 : pngName(a) > pngName(b) ? 1 : 0))
    .map(metaRow);
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));   // stable, like Python
  return rows.map((r) => rowJson(r) + '\n').join('');
}

/** Size of the image and the mapping from record coordinates to image pixels. */
export function layout(record) {
  const strokes = inked(record);
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const s of strokes) {
    for (let i = 0; i < s.x.length; i++) {
      const x = s.x[i]; const y = s.y[i];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  const w = Math.max(x1 - x0, 1); const h = Math.max(y1 - y0, 1);
  const pad = 0.35 * h + 4;
  // Figure size from w/h (at least 1), axis limits from the real ink box plus pad,
  // equal aspect, centred: what matplotlib does in rebuild_preview.py.
  const width = Math.round(Math.min(Math.max(HEIGHT_PX * ((w + 2 * pad) / (h + 2 * pad)), MIN_W), MAX_W));
  const bw = (x1 - x0) + 2 * pad; const bh = (y1 - y0) + 2 * pad;
  const scale = Math.min(width / bw, HEIGHT_PX / bh);
  const ox = (width - bw * scale) / 2 + (pad - x0) * scale;
  const oy = (HEIGHT_PX - bh * scale) / 2 + (pad - y0) * scale;
  return { width, height: HEIGHT_PX, scale, ox, oy };
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

async function toPngBytes(canvas) {
  let blob;
  if (canvas.convertToBlob) blob = await canvas.convertToBlob({ type: 'image/png' });
  else blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/** The line as a PNG: dark ink on white, cropped to the ink, 150 px high. */
export async function renderPng(record) {
  const strokes = inked(record);
  if (!strokes.length) throw new Error('no ink');
  const L = layout(record);
  const c = makeCanvas(L.width, L.height);
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, L.width, L.height);
  g.strokeStyle = INK; g.fillStyle = INK;
  g.lineWidth = LINE_W; g.lineCap = 'round'; g.lineJoin = 'round';
  const X = (x) => L.ox + x * L.scale;
  const Y = (y) => L.oy + y * L.scale;
  for (const s of strokes) {
    const span = (v) => Math.max(...v) - Math.min(...v);
    if (s.x.length === 1 || Math.max(span(s.x), span(s.y)) < DOT_PX) {
      const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
      g.beginPath(); g.arc(X(mean(s.x)), Y(mean(s.y)), DOT_R, 0, Math.PI * 2); g.fill();
      continue;
    }
    g.beginPath();
    g.moveTo(X(s.x[0]), Y(s.y[0]));
    for (let i = 1; i < s.x.length; i++) g.lineTo(X(s.x[i]), Y(s.y[i]));
    g.stroke();
  }
  return toPngBytes(c);
}

export function base64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Files of one preview commit.
 * batch: the entries whose image goes up now; sessionEntries(writerId, sessionId) gives
 * every entry of that session that belongs in its metadata.jsonl (the caller decides:
 * uploaded lines whose image exists or is in this batch).
 * Returns {files, skipped}: skipped = ids of entries without ink (no image possible).
 */
export async function buildFiles(batch, sessionEntries) {
  const files = [];
  const skipped = [];
  const sessions = new Map();
  for (const e of batch) {
    if (!hasInk(e.record)) { skipped.push(e.id); continue; }
    files.push({ path: pngPath(e.record), base64: base64(await renderPng(e.record)) });
    sessions.set(`${e.record.writer_id}/${e.record.session_id}`, e.record);
  }
  for (const rec of sessions.values()) {
    const entries = await sessionEntries(rec.writer_id, rec.session_id);
    files.push({ path: metadataPath(rec), text: metadataJsonl(entries.map((x) => x.record)) });
  }
  return { files, skipped };
}

/**
 * A session's metadata.jsonl with the row of one line replaced (record given) or left
 * out (record null). Every other row stays byte for byte as it was, so rows written by
 * another device or by rebuild_preview.py are kept. Returns {text, changed}; changed is
 * false when the file has no row for that line (then it need not be committed).
 */
export function editMetadata(text, fileName, record) {
  const lines = String(text || '').split('\n');
  const out = [];
  let changed = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    let row = null;
    try { row = JSON.parse(line); } catch (_) { row = null; }
    if (row && row.file_name === fileName) {
      changed = true;
      if (record) out.push(rowJson(metaRow(record)));
      continue;
    }
    out.push(line);
  }
  return { text: out.map((l) => l + '\n').join(''), changed };
}
