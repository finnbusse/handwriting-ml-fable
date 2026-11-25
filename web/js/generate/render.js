// Drawing and exporting handwriting.  A page is what layout.js produces:
// { strokes: Float32Array[] ([x, y, eos, ...] in xh units), width, height }.

/** Split a point array into strokes: arrays of [x, y]. */
export function toPolylines(points) {
  const out = [];
  let cur = [];
  for (let i = 0; i < points.length; i += 3) {
    cur.push([points[i], points[i + 1]]);
    if (points[i + 2] > 0.5) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Trace one stroke as a smooth curve through the midpoints of its segments. */
function trace(ctx, line, scale, ox, oy) {
  const px = (p) => p[0] * scale + ox, py = (p) => p[1] * scale + oy;
  if (line.length === 1) {
    ctx.moveTo(px(line[0]), py(line[0]));
    ctx.lineTo(px(line[0]) + 0.01, py(line[0]));
    return;
  }
  ctx.moveTo(px(line[0]), py(line[0]));
  for (let i = 1; i < line.length - 1; i++) {
    const mx = (px(line[i]) + px(line[i + 1])) / 2, my = (py(line[i]) + py(line[i + 1])) / 2;
    ctx.quadraticCurveTo(px(line[i]), py(line[i]), mx, my);
  }
  const last = line[line.length - 1];
  ctx.lineTo(px(last), py(last));
}

/** Draw word arrays (as in page.strokes) onto a 2D context. `scale` = pixels per x-height. */
export function drawStrokes(ctx, wordArrays, { scale, offsetX = 0, offsetY = 0, color = '#1b2a49', lineWidth = 0.16 } = {}) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(lineWidth * scale, 0.6);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (const points of wordArrays) for (const line of toPolylines(points)) trace(ctx, line, scale, offsetX, offsetY);
  ctx.stroke();
  ctx.restore();
}

/** Draw only the first `count` points of a word array (for the writing animation). */
export function drawPartial(ctx, points, count, options) {
  const n = Math.min(count, points.length / 3);
  if (n <= 0) return;
  const part = points.slice(0, 3 * n);
  part[3 * (n - 1) + 2] = 1;
  drawStrokes(ctx, [part], options);
}

const fmt = (v) => (Math.round(v * 100) / 100).toString();

/** The page as a standalone SVG document (smooth paths, real vectors). */
export function toSVG(page, { scale = 12, color = '#1b2a49', lineWidth = 0.16, background = null } = {}) {
  const w = page.width * scale, h = page.height * scale;
  const paths = [];
  for (const points of page.strokes) {
    let d = '';
    for (const line of toPolylines(points)) {
      const p = line.map(([x, y]) => [x * scale, y * scale]);
      d += `M${fmt(p[0][0])} ${fmt(p[0][1])}`;
      if (p.length === 1) { d += 'l0.01 0'; continue; }
      for (let i = 1; i < p.length - 1; i++) {
        d += `Q${fmt(p[i][0])} ${fmt(p[i][1])} ${fmt((p[i][0] + p[i + 1][0]) / 2)} ${fmt((p[i][1] + p[i + 1][1]) / 2)}`;
      }
      d += `L${fmt(p[p.length - 1][0])} ${fmt(p[p.length - 1][1])}`;
    }
    paths.push(`<path d="${d}"/>`);
  }
  const bg = background ? `<rect width="100%" height="100%" fill="${background}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(w)} ${fmt(h)}" width="${fmt(w)}" height="${fmt(h)}">${bg}` +
    `<g fill="none" stroke="${color}" stroke-width="${fmt(lineWidth * scale)}" stroke-linecap="round" stroke-linejoin="round">${paths.join('')}</g></svg>\n`;
}

/** Render the page into a new canvas (for PNG export). */
export function toCanvas(page, { scale = 24, color = '#1b2a49', lineWidth = 0.16, background = '#ffffff', createCanvas } = {}) {
  const make = createCanvas || ((w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }));
  const canvas = make(Math.ceil(page.width * scale), Math.ceil(page.height * scale));
  const ctx = canvas.getContext('2d');
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  drawStrokes(ctx, page.strokes, { scale, color, lineWidth });
  return canvas;
}
