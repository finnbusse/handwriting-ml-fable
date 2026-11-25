// "Stift & Papier": the choice buttons and the live sample, used in the capture panel
// and in Einstellungen. Buttons only (no text inputs on the capture screen).
import { WIDTHS, normalize, computeGuides, schemeColors, drawPaper, createInk } from './ink.js';

const GROUPS = [
  { key: 'pen', label: 'Stift', options: [
    { v: 'fineliner', text: 'Fineliner' }, { v: 'fueller', text: 'Füller' }, { v: 'bleistift', text: 'Bleistift' }] },
  { key: 'width', label: 'Strichstärke', options: WIDTHS.map((v, i) => (
    { v, text: ['Sehr fein', 'Fein', 'Mittel', 'Kräftig', 'Dick'][i] })) },
  { key: 'paper', label: 'Papier', options: [
    { v: 'linie', text: 'Eine Linie' }, { v: 'liniert', text: 'Liniert' }, { v: 'kariert', text: 'Kariert' }] },
  { key: 'scheme', label: 'Farben', options: [
    { v: 'dark_on_light', text: 'Dunkel auf hell' }, { v: 'light_on_dark', text: 'Hell auf dunkel' }] },
];

let uid = 0;

/**
 * Build the controls into `root`.
 * get(): current options; set(options): apply + remember; wrap(handler): optional click guard.
 */
export function createLookControls(root, { get, set, wrap = (fn) => fn }) {
  const id = `look${++uid}`;
  root.classList.add('look');
  root.innerHTML = '';
  const preview = document.createElement('div');
  preview.className = 'look-preview';
  const cv = document.createElement('canvas');
  cv.setAttribute('aria-hidden', 'true');
  preview.append(cv);
  const groups = document.createElement('div');
  groups.className = 'look-groups';
  for (const g of GROUPS) {
    const box = document.createElement('div');
    box.className = `look-group look-${g.key}`;
    const lab = document.createElement('p');
    lab.className = 'look-label'; lab.id = `${id}-${g.key}`; lab.textContent = g.label;
    const segs = document.createElement('div');
    segs.className = 'segs'; segs.setAttribute('role', 'radiogroup'); segs.setAttribute('aria-labelledby', lab.id);
    for (const o of g.options) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'seg'; b.setAttribute('role', 'radio');
      b.dataset.k = g.key; b.dataset.v = String(o.v);
      if (g.key === 'width') {
        const line = document.createElement('span');
        line.className = 'wline'; line.style.height = `${o.v}px`;
        b.append(line);
      } else if (g.key === 'paper' || g.key === 'scheme') {
        const sw = document.createElement('span');
        sw.className = `swatch sw-${o.v}`; sw.setAttribute('aria-hidden', 'true');
        b.append(sw);
      }
      const t = document.createElement('span');
      t.className = 'seg-text'; t.textContent = o.text;
      b.append(t);
      segs.append(b);
    }
    box.append(lab, segs);
    groups.append(box);
  }
  root.append(preview, groups);

  root.addEventListener('click', wrap((e) => {
    const b = e.target.closest && e.target.closest('button.seg');
    if (!b || !root.contains(b)) return;
    const cur = normalize(get());
    const v = b.dataset.k === 'width' ? Number(b.dataset.v) : b.dataset.v;
    if (cur[b.dataset.k] === v) return;
    const next = Object.assign({}, cur, { [b.dataset.k]: v });
    return Promise.resolve(set(next)).then(render);
  }));

  let ink = null;
  function drawPreview(d) {
    const box = preview.getBoundingClientRect();
    if (box.width < 2) return;
    const w = Math.floor(box.width), h = 96, dpr = devicePixelRatio || 1;
    cv.style.width = `${w}px`; cv.style.height = `${h}px`;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const c = cv.getContext('2d');
    if (!ink) ink = createInk(c);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const colors = schemeColors(d.scheme);
    const guides = computeGuides(w, h, d);
    drawPaper(c, w, h, guides, colors, 1);
    ink.configure(d, colors, dpr);
    for (const s of sampleStrokes(guides.x_start + 8, guides.baseline_y, Math.min(w - guides.x_start - 16, 420))) ink.draw(s, 0);
  }

  function render() {
    const d = normalize(get());
    for (const b of root.querySelectorAll('button.seg')) {
      const v = b.dataset.k === 'width' ? Number(b.dataset.v) : b.dataset.v;
      b.setAttribute('aria-checked', d[b.dataset.k] === v ? 'true' : 'false');
    }
    preview.dataset.scheme = d.scheme;
    drawPreview(d);
  }

  return { render, get canvas() { return cv; } };
}

/** A few joined-up "words" of small writing (x-height ~8 px) with natural pressure. */
export function sampleStrokes(x0, base, maxW) {
  const words = [[1, 0, 1, 1, 0], [0, 1, 0, 0, 1, 0], [1, 0, 0, 1]];   // 1 = letter with an ascender
  const unit = 9, out = [];
  let x = x0, t = 0;
  for (const wd of words) {
    if (x - x0 + wd.length * unit > maxW) break;
    const s = { x: [], y: [], t: [], p: [], tiltX: [], tiltY: [] };
    const steps = wd.length * 14;
    for (let i = 0; i <= steps; i++) {
      const u = i / 14;
      const a = u * Math.PI * 2;
      const tall = wd[Math.min(wd.length - 1, Math.floor(u))] ? 2.3 : 1;
      const ramp = Math.min(1, i / 6, (steps - i) / 5 + 0.3);
      s.x.push(x + u * unit + Math.sin(a) * unit * 0.34);
      s.y.push(base - (1 - Math.cos(a)) * unit * 0.45 * tall);
      s.t.push(t); t += 2.1;
      s.p.push((0.18 + 0.5 * (0.5 + 0.5 * Math.sin(a * 0.5 + 0.6))) * ramp);
      s.tiltX.push(0); s.tiltY.push(0);
    }
    out.push(s);
    x += (wd.length + 1.1) * unit;
    t += 120;
  }
  return out;
}
