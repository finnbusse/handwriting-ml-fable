// The small curve of the held-out score per round, as inline SVG (no library).
// It is stretched to the width of its box; vector-effect keeps the line width,
// and the round caps of zero-length lines draw the dots.
const NS = 'http://www.w3.org/2000/svg';
const W = 300, H = 100, PAD = 8;

/** scores: index = round (0 = before training), null = not measured; best: round with the best score. */
export function drawCurve(svg, scores, best) {
  while (svg.firstChild) svg.firstChild.remove();
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const pts = (scores || []).map((s, i) => [i, s]).filter(([, s]) => Number.isFinite(s));
  if (pts.length < 2) return false;
  const lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
  const span = hi - lo || 1;
  const n = Math.max(1, (scores.length - 1));
  const x = (i) => PAD + ((W - 2 * PAD) * i) / n;
  const y = (s) => H - PAD - ((H - 2 * PAD) * (s - lo)) / span;   // lower score = lower on the screen
  const el = (name, attrs) => {
    const e = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    svg.append(e);
    return e;
  };
  for (const f of [0, 0.5, 1]) el('line', { x1: 0, x2: W, y1: PAD + f * (H - 2 * PAD), y2: PAD + f * (H - 2 * PAD), class: 'grid' });
  el('polyline', { points: pts.map(([i, s]) => `${x(i).toFixed(1)},${y(s).toFixed(1)}`).join(' '), class: 'line' });
  for (const [i, s] of pts) {
    const isBest = i === best;
    el('line', { x1: x(i), x2: x(i), y1: y(s), y2: y(s), class: isBest ? 'dot best' : 'dot' });
  }
  return true;
}
