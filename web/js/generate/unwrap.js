// Text copied from a web page, a PDF or an e-mail often carries the line breaks of its
// source: every line ends where the source's column was full (a law from
// gesetze-im-internet.de: 70 characters).  A page row of this hand holds about 55
// characters, so each such line ran over by a word or two that then stood alone on a
// row.  unwrapLines finds such a text and joins its lines again; the line breaks a
// person typed on purpose stay.

// A column narrower than this is somebody's own short lines: a poem, an address, a list.
export const MIN_WIDTH = 40;
// Fewer filled lines than this prove nothing.
export const MIN_JOINS = 3;
// Of the lines at least half the column wide that have a line after them, this share must
// be full.  In a wrapped text nearly all of them are; in lines of similar length typed on
// purpose (sentences one per line) about half are.
export const FULL_SHARE = 2 / 3;
// A source set in a proportional font (a PDF, a web page) wraps by width, not by count:
// its full lines differ in their number of characters (50 to 64 in a column of 64).  A
// line whose successor's first word would have passed this share of the column counts
// as full too, unless it ends a sentence (then it may end a paragraph).
export const NEAR_FULL = 0.8;

const len = (s) => [...s].length;
// A line that starts something of its own and so never continues the line before it:
// a heading, a list item, a quote, a table row, a code fence, an alignment mark or an
// enumerator like "(1)" or "a)".  Not "§ 3" or "z. B.": in running text a wrapped line
// often starts with them.  (A LaTeX text is not given to unwrapLines: there a line
// break is a space already, and a comment ends at one.)
const STARTS = /^\s*(?:#{1,6}\s|[-*+]\s|\d{1,3}[.)]\s|[A-Za-z]\)\s|>|\||```|~~~|\{(?:mitte|rechts|links|[sS]eite)\}|\(\w{1,3}\)\s)/u;
const RULE = /^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,}|={3,})$/u;
// A line that is complete in itself: nothing is joined onto it.
const ALONE = /^\s*(?:#{1,6}\s|\||```|~~~)/u;
// A break the text asks for itself: two spaces or a backslash at the end, <br>.
const KEEPS = /(?: {2,}|\\|<br\s*\/?>)$/iu;
const SENTENCE_END = /[.!?:…]["'“”«»)\]]*$/u;

/** { text, joined }: the text with the line breaks of a narrower source column taken out
 *  (each replaced by one space), and how many were; the text itself when it has none. */
export function unwrapLines(text) {
  const src = String(text);
  const lines = src.split('\n');
  if (lines.length < MIN_JOINS + 1) return { text: src, joined: 0 };
  let fence = false;
  // can line k be continued by line k + 1?
  const open = lines.map((line, k) => {
    const cut = line.trimEnd();
    if (/^\s*(?:```|~~~)/u.test(line)) { fence = !fence; return false; }
    if (fence || !cut.trim() || k + 1 >= lines.length) return false;
    const next = lines[k + 1];
    if (!next.trim() || ALONE.test(cut) || RULE.test(cut) || KEEPS.test(line) || STARTS.test(next) || RULE.test(next)) return false;
    return true;
  });
  const sizes = lines.map((l) => len(l.trimEnd()));
  const having = sizes.filter((_, k) => open[k]).sort((a, b) => a - b);
  if (having.length < MIN_JOINS) return { text: src, joined: 0 };
  // The column: where the longest of the lines that go on end.  The ninth decile, not the
  // maximum: one line that was never wrapped (a link, a paragraph typed in one go) must
  // not make every other line look short.
  const width = having[Math.min(having.length - 1, Math.floor(0.9 * having.length))];
  if (width < MIN_WIDTH) return { text: src, joined: 0 };
  // Most lines ending a sentence: somebody wrote one sentence a line.  (In a wrapped text
  // a line ends a sentence by chance, about one in eight.)
  const ends = lines.map((line, k) => open[k] && SENTENCE_END.test(line.trimEnd()));
  if (2 * ends.filter(Boolean).length > having.length) return { text: src, joined: 0 };
  // A line is full when the first word of the next one would not have fitted behind it:
  // not into the column, or not into most of it when the line does not end a sentence.
  const first = (k) => lines[k + 1].trim().split(/\s+/u)[0];
  const full = lines.map((_, k) => {
    if (!open[k]) return false;
    const reach = sizes[k] + 1 + len(first(k));
    return reach > width || (reach > NEAR_FULL * width && !ends[k]);
  });
  // Running text goes on in the middle of a sentence, so some line after a full one
  // starts with a small letter; titles or entries written one a line do not.
  if (!lines.some((_, k) => full[k] && /^\p{Ll}/u.test(first(k)))) return { text: src, joined: 0 };
  const wide = lines.filter((_, k) => open[k] && sizes[k] >= width / 2).length;
  const joins = full.filter(Boolean).length;
  if (joins < MIN_JOINS || joins < FULL_SHARE * wide) return { text: src, joined: 0 };
  let out = '';
  lines.forEach((line, k) => {
    const part = k && full[k - 1] ? line.trimStart() : line;      // goes on behind the line before
    out += full[k] ? `${part.trimEnd()} ` : part + (k + 1 < lines.length ? '\n' : '');
  });
  return { text: out, joined: joins };
}
