// The page mode of the web app (web/js/generate/document.js, pdf.js) for the server:
// the same planning, preparation, layout and PDF, so that a page from the server is
// the page the app would make.  One JSON request on stdin, one JSON answer on stdout.
//
//   node server/pages.mjs < {"cmd": "plan", "text": "...", "charset": "..."}
//     -> {"paragraphs": [[0, 1], ...], "pieces": [{"text", "typed"}], "unsupported": ["😀"]}
//   node server/pages.mjs < {"cmd": "flags", "xhModel": 93.5, "inks": [ink, ...]}
//     -> {"flags": [0, 2, ...]}                      what the layout sees wrong per piece
//   node server/pages.mjs < {"cmd": "pdf", "out": "/path.pdf", "plan", "inks": [[ink] | [ink, again]],
//                            "xhModel", "gapXh", "sizeByBias", "settings", "look", "title"}
//     -> {"pages": 2, "placed": 80, "kept": 3}       the PDF is written to `out`
//
// ink = {"text": normalized piece text, "points": [x, y, eos, ...] in model units, "ok", "problems"}
import fs from 'node:fs';
import { createNormalizer } from '../web/js/engine/engine.js';
import { planDocument, preparePiece, layoutDocument } from '../web/js/generate/document.js';
import { pdfBytes } from '../web/js/generate/pdf.js';

const prepare = (ink, xhModel) => preparePiece({ ...ink, points: Float32Array.from(ink.points) }, xhModel);

function plan({ text, charset }) {
  const n = createNormalizer(charset);
  const p = planDocument(text, n.normalize);
  return { paragraphs: p.paragraphs, pieces: p.pieces.map(({ text: t, typed }) => ({ text: t, typed })), unsupported: [...new Set(n.unsupported(text))] };
}

function flags({ inks, xhModel }) {
  return { flags: inks.map((ink) => prepare(ink, xhModel).flags.length) };
}

async function pdf(o) {
  const plan = { paragraphs: o.plan.paragraphs, pieces: o.plan.pieces.map((p, index) => ({ ...p, index })) };
  let kept = 0;
  // A second attempt replaces the first only with fewer flags (page-view.js: writeChecked).
  const written = o.inks.map((tries) => {
    const [first, again] = tries.map((ink) => prepare(ink, o.xhModel));
    if (again && again.flags.length < first.flags.length) { kept++; return again; }
    return first;
  });
  const doc = layoutDocument(plan, written, o.settings, { gapXh: o.gapXh, sizeByBias: o.sizeByBias });
  const bytes = await pdfBytes(doc, { look: o.look, title: o.title, date: new Date(), textLayer: true });
  fs.writeFileSync(o.out, bytes);
  return { pages: doc.pages.length, placed: doc.placed, kept };
}

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const req = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const run = { plan, flags, pdf }[req.cmd];
if (!run) { process.stderr.write(`unknown cmd ${req.cmd}\n`); process.exit(2); }
process.stdout.write(JSON.stringify(await run(req)));
