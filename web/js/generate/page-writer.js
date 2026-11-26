// Writes a whole text: splits it into pieces, has each piece written by the
// engine (through `writePiece`, normally a Web Worker), and lays the finished
// pieces out as a page.  No DOM in here; the view draws what onPiece reports.
import { makeRandom } from '../engine/engine.js';
import { splitPieces, straighten, layoutPage, toXh, sizeScale, MAX_PIECE_CHARS } from './layout.js';

/**
 * @param {object} o
 * @param {(text:string)=>string} o.normalize       model.normalize
 * @param {(job:{text:string,bias:number,seed:number,tries:number})=>Promise<object>} o.writePiece
 * @param {number} o.xhModel  model units per x-height
 * @param {[number,number]} o.gapXh  the writer's word gap (mean, sd) in x-heights
 * @param {{bias:number[],xh:number[]}|null} [o.sizeByBias]  model.json's size_by_bias: measured letter size per bias
 */
export function createPageWriter({ normalize, writePiece, xhModel, gapXh, sizeByBias = null }) {
  let token = 0;
  let lastLayout = null;   // re-lays out the pieces of the latest write()

  /** Returns the finished page, or null if a newer write() or cancel() superseded this one. */
  async function write(text, { bias = 0.8, width = 84, lineHeight = 6.5, margin = 3, top = 5, seed, onPiece, onProgress } = {}) {
    const mine = ++token;
    const random = makeRandom(seed);
    const clean = text.split('\n').map((line) => normalize(line)).join('\n');
    const paragraphs = splitPieces(clean, MAX_PIECE_CHARS);
    const total = paragraphs.reduce((n, p) => n + p.length, 0);
    // One fixed spacing draw per piece: words already on the page never move
    // when later pieces arrive.
    const gapDraws = [];
    const rows = paragraphs.map(() => []);
    const scale = sizeScale(sizeByBias, bias);     // letters back to the writer's size at this setting
    const relayout = (over = {}) => {
      let cursor = 0;
      const normal = () => {
        while (gapDraws.length <= cursor) gapDraws.push(random.normal());
        return gapDraws[cursor++];
      };
      return layoutPage(rows, { width: over.width ?? width, lineHeight: over.lineHeight ?? lineHeight, gap: gapXh, margin, top, normal, scale });
    };
    lastLayout = relayout;
    let page = relayout(), done = 0, drawn = 0;
    for (let k = 0; k < paragraphs.length; k++) {
      for (const pieceText of paragraphs[k]) {
        const result = await writePiece({ text: pieceText, bias, seed: (random.uniform() * 2 ** 32) >>> 0, tries: 3 });
        if (mine !== token) return null;
        rows[k].push(straighten(toXh(result, xhModel)));
        page = relayout();
        done++;
        const fresh = page.strokes.slice(drawn);
        drawn = page.strokes.length;
        if (onPiece) onPiece({ page, fresh, done, total, problems: result.ok ? [] : result.problems });
        if (onProgress) onProgress(done, total);
      }
    }
    return page;
  }

  /** The pieces written so far by the latest write(), laid out again with another
   *  width / line height (no new writing); null before the first write(). */
  const relayout = (over) => (lastLayout ? lastLayout(over) : null);

  return { write, relayout, cancel() { token++; } };
}
