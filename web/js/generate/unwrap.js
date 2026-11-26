// Text copied from a web page, a PDF or an e-mail often carries the line breaks of its
// source: every line ends where the source's column was full (a law from
// gesetze-im-internet.de: 70 characters).  A page row of this hand holds about 55
// characters, so each such line ran over by a word or two that then stood alone on a
// row.  unwrapLines finds such a text and joins its lines again; the line breaks a
// person typed on purpose stay.  A break typed on purpose weighs more than a copied one:
// where the two look alike, the break stays.
//
// The rules, in the order they act:
//   own line     a heading, list item, table row, fence, rule, alignment mark or a
//                change of quote marks starts a line of its own; a numbered line only
//                as "1." or after N-1; an entry ("Lisa: ", "18:02 Max: ", "– ") next to
//                another.
//   kept break   two spaces, a backslash or <br> at the end; a line indented deeper than
//                the text of the line before (code, verse set in), or more than the
//                line after unless it begins its block (a first-line indent).
//   column       the source's column, from the lines of at least MIN_WIDTH characters
//                near their median length.
//   never wrapped  a line much longer than the column was typed in one go.
//   one a line   most lines ending a sentence: somebody wrote one sentence a line.
//   full         the next line's first word would not have fitted behind the line (in a
//                column of NEAR_MIN or more: nearly); a word split by a hyphen goes on.
//   opener       a line that does not end a sentence, before a line that starts one
//                ("Die ...", "The ..."), is a heading or an entry: kept.
//   greeting     "Liebe Anna, ...," as the first line of a block: kept.
//   paragraph end  a line that ends a sentence goes on into a line starting with a
//                capital or digit only if that line goes on itself.
//   running text the text as a whole: wide enough, enough full lines, and some line
//                after a full one starts with a small letter.
//   evidence     every run of lines to be joined holds a sentence end inside a line,
//                ends with one or is a list item; a poem, list or table typed one a line
//                mostly has none of these.
//   typed pair   two lines to be joined next to a line typed in one go stay: the block
//                was typed line by line (a stanza, a salutation).

// A column narrower than this is somebody's own short lines: a poem, an address, a list.
// (A PDF column of 38 is joined; at 30 a short vocabulary list was.)
export const MIN_WIDTH = 35;
// Fewer filled lines than this prove nothing.  (At 2, 5 of 12 three-line texts typed so,
// notes, poems, a to-do list, code, were joined.)
export const MIN_JOINS = 3;
// Of the lines at least half the column wide that have a line after them, this share must
// be full.  In a wrapped text nearly all of them are; in lines of similar length typed on
// purpose (sentences one per line) about half are.
export const FULL_SHARE = 2 / 3;
// A source set in a proportional font (a PDF, a web page) wraps by width, not by count:
// its full lines differ in their number of characters (50 to 64 in a column of 64).  A
// line whose successor's first word would have passed this share of the column counts
// as full too, unless it ends a sentence (then it may end a paragraph).  (Of the 13,464
// breaks of 1,470 random proportional texts, 456 stay at 0.8 and 6,475 at 1.0.)
export const NEAR_FULL = 0.8;
// ... but only in a column this wide.  Verse runs 35 to 46 characters a line, and with a
// line of 37 before a word of 3, 0.8 of a column of 45 is passed (Rilke's "Der Panther",
// "Herbsttag", Hamlet's soliloquy were joined).  A narrower line fits a page row of 55
// anyway, so a break left there leaves no word alone on a row: the 625 more breaks this
// leaves in 3,000 random texts all end a line of at most 55 characters.
export const NEAR_MIN = 50;
// The column is taken from the lines no longer than this times their median, so that one
// paragraph typed in one go (177 characters among lines of 70) does not hide it; short
// lines (a list of ingredients above a wrapped paragraph) do not count either ...
export const NEAR_MEDIAN = 1.35;
// ... and a line longer than this times the column was never wrapped by it: it is not
// full and does not count for the sentence ends.
export const OVERLONG = 1.2;

const len = (s) => [...s].length;
const OWN_LINE = /^\s*(?:#{1,6}\s|[-*+]\s|[A-Za-z]\)\s|\||```|~~~|\{(?:mitte|rechts|links|[sS]eite)\}|\(\w{1,3}\)\s)/u;
// "3. Oktober 1990" or "2. Vorsitzende" at a line start is running text (CommonMark: a
// numbered line interrupts a paragraph only as 1.).
const NUMBERED = /^\s*(\d{1,3})[.)]\s/u;
// An entry of a chat, a form or a dialogue: "Lisa: ...", "[18:02] Max: ...", "Telefon: ...",
// "– Kommst du?"; an own line only next to another, since a wrapped line may start with
// "Ergebnisse: " or "– so hieß es –" by chance.
const ENTRY = /^\s*(?:[–—•]\s|(?:\[?\d{1,2}:\d{2}\]?\s+)?\p{Lu}[\p{L}\d.-]{0,20}(?: [\p{L}\d.-]{1,20})?:\s)/u;
const QUOTE = /^(?:[ \t]*>)+[ \t]?/u;
const RULE = /^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,}|={3,})$/u;
const FENCE = /^\s*(?:```|~~~)/u;
// A line that is complete in itself: nothing is joined onto it.
const ALONE = /^\s*(?:#{1,6}\s|\||```|~~~)/u;
// Two spaces, not " {2,}": that backtracks quadratically on a long run of spaces.
const KEEPS = /(?: {2}|\\|<br\s*\/?>)$/iu;
// Where the text of a line starts, behind its list marker: a wrapped item's next line is
// indented that far.  An item goes on up to the next marker.
const CONTENT = /^\s*(?:(?:[-*+•–]|\d{1,3}[.)]|[A-Za-z]\)|\(\w{1,3}\))\s+)?/u;
const ITEM = /^\s*(?:[-*+]|\d{1,3}[.)])\s/u;
const SENTENCE_END = /[.!?:…]["'“”«»)\]]*$/u;
// A sentence end inside a line; not behind a number ("3. Mai"), a title ("Dr. Müller"), a
// single letter ("z. Hd.", "Franklin D.") or another dot (dot leaders of a contents list).
const INNER_END = /(?<!(?:^|[\s(])(?:Dr|Prof|Nr|Str|St|Abs|Art|Bd|Hr|Fr|Tel|ca|bzw|vgl|ggf|usw|etc|Mr|Mrs|Ms|Dipl|Ing|Mio|Mrd|Hd|\p{L})|\d|\.)[.!?…]["'“”«»)\]]*\s+["„“'(]?[\p{Lu}\d]/u;
// Words that start a sentence when capitalised; in German and English never capitalised
// inside one (not "Sie", "Ihr", "I": those are).  Anchored at both ends, so that a long
// word with punctuation cannot make it backtrack.
const OPENER = /^(?:Der|Die|Das|Den|Dem|Des|Ein|Eine|Einen|Einem|Einer|Eines|Es|Er|Wir|Ich|Du|Man|Wer|Was|Wie|Wo|Wann|Warum|Dies|Diese|Dieser|Dieses|Diesen|Jeder|Jede|Jedes|Alle|Viele|Im|In|Am|An|Auf|Bei|Mit|Nach|Seit|Von|Vor|Zu|Zum|Zur|Für|Über|Unter|Um|Durch|Ohne|Und|Oder|Aber|Doch|Denn|Wenn|Als|Weil|Dass|Obwohl|Damit|Da|Dann|So|Auch|Nur|Noch|Schon|Heute|Gestern|Hier|Dort|Jetzt|Nun|The|This|These|That|Those|It|We|He|She|They|You|My|Our|On|At|For|With|From|By|After|Before|When|If|But|And|Or|There|Here)[,.;:!?]*$/u;
const GREETING = /^\s*(?:Liebe[rs]?|Hallo|Hi|Hey|Moin|Servus|Sehr geehrte[rs]?|Guten (?:Tag|Morgen|Abend)|Dear|Hello)\b.*,$/u;
// "Haus- und Gartenarbeit": the hyphen stays, and so does the space.
const LINKS = /^(?:und|oder|bis|sowie|bzw\.|u\.|noch|wie)$/u;

// How a line ending in `cut` goes on into `word` when joined: ' ' with a space; '-' as one
// word without the hyphen ("veran-" "kert"); '' as one word with it ("E-" "Mail", "US-"
// "amerikanisch", "e-" "mail": hyphenation never leaves one letter).  A compound split at
// its own hyphen after two small letters loses it ("well-" "known": "wellknown").
function seam(cut, word) {
  if (!/\p{L}-$/u.test(cut) || LINKS.test(word)) return ' ';
  return /\p{Ll}-$/u.test(cut) && /^\p{Ll}/u.test(word) && !/(?<!\p{L})\p{L}-$/u.test(cut) ? '-' : '';
}

/** { text, joined }: the text with the line breaks of a narrower source column taken out
 *  and how many were; the text itself when it has none.  A joined break becomes one
 *  space; a word split by a hyphen is joined whole ("veran-\nkert": "verankert",
 *  "E-\nMail": "E-Mail"); a quote mark (">") that begins the joined line goes with it. */
export function unwrapLines(text) {
  // Joining can make a line full that was not (a short last line becomes part of a long
  // one), so the text is joined until nothing changes and a second call changes nothing.
  // Real texts need one round; of 100,000 random strings of marks and words, 181 need 2
  // and 14 need 3 or 4.  At most 8, so that no input keeps it going.
  let out = { text: String(text), joined: 0 };
  for (let round = 0; round < 8; round++) {
    const r = once(out.text);
    if (!r.joined) break;
    out = { text: r.text, joined: out.joined + r.joined };
  }
  return out;
}

function once(src) {
  const lines = src.split('\n');
  if (lines.length < MIN_JOINS + 1) return { text: src, joined: 0 };
  // quoted lines are judged by their text behind the marks; a change of marks is an own line
  const marks = lines.map((l) => QUOTE.exec(l)?.[0] ?? '');
  const level = marks.map((q) => q.replace(/\s/gu, ''));
  const body = lines.map((l, k) => l.slice(marks[k].length));
  const entry = body.map((b) => ENTRY.test(b));
  let num = null;
  const own = lines.map((l, k) => {
    if (!l.trim()) { num = null; return false; }
    if (k && level[k] !== level[k - 1]) return true;
    if (OWN_LINE.test(body[k]) || (entry[k] && (entry[k - 1] || entry[k + 1]))) return true;
    const m = NUMBERED.exec(body[k]);
    if (!m || (+m[1] !== 1 && num !== +m[1] - 1)) return false;
    num = +m[1];
    return true;
  });
  let fence = false;
  // can line k be continued by line k + 1?
  const open = lines.map((line, k) => {
    const cut = body[k].trimEnd();
    if (FENCE.test(line)) { fence = !fence; return false; }
    if (fence || !cut.trim() || k + 1 >= lines.length) return false;
    const next = body[k + 1];
    if (!next.trim() || ALONE.test(cut) || RULE.test(cut) || KEEPS.test(line) || own[k + 1] || RULE.test(next)) return false;
    const lead = (i) => len(/^\s*/u.exec(body[i])[0]);
    if (k && lines[k - 1].trim() && lead(k) > lead(k + 1)) return false;        // the end of a block set in
    return lead(k + 1) <= len(CONTENT.exec(body[k])[0]);
  });
  const sizes = lines.map((l) => len(l.trimEnd()));
  const having = sizes.filter((_, k) => open[k]).sort((a, b) => a - b);
  if (having.length < MIN_JOINS) return { text: src, joined: 0 };
  // column: where the longest of the usual lines end (the ninth decile, not the maximum)
  const long = having.filter((n) => n >= MIN_WIDTH);
  if (long.length < MIN_JOINS) return { text: src, joined: 0 };
  const median = long[Math.floor(long.length / 2)];
  const usual = long.filter((n) => n <= NEAR_MEDIAN * median);
  const width = usual[Math.min(usual.length - 1, Math.floor(0.9 * usual.length))];
  if (width < MIN_WIDTH) return { text: src, joined: 0 };
  const typed = (k) => k >= 0 && k < lines.length && sizes[k] > OVERLONG * width;
  const wrapped = lines.map((_, k) => open[k] && !typed(k));                 // never wrapped
  // one a line.  (In a wrapped text a line ends a sentence by chance, about one in eight.)
  const ends = lines.map((line, k) => wrapped[k] && SENTENCE_END.test(line.trimEnd()));
  if (2 * ends.filter(Boolean).length > wrapped.filter(Boolean).length) return { text: src, joined: 0 };
  const first = (k) => body[k + 1].trim().split(/\s+/u)[0];
  const near = width >= NEAR_MIN ? NEAR_FULL * width : width;
  const full = lines.map((line, k) => {
    if (!wrapped[k]) return false;
    const cut = line.trimEnd(), word = first(k);
    if (seam(cut, word) === '-') return true;                                          // split word
    if (!ends[k] && OPENER.test(word)) return false;                                     // opener
    if ((!k || !lines[k - 1].trim()) && GREETING.test(cut)) return false;                // greeting
    const reach = sizes[k] + 1 + len(word);
    return reach > width || (reach > near && !ends[k]);
  });
  // paragraph end, from the last line up, so that "goes on itself" is the final answer
  for (let k = lines.length - 2; k >= 0; k--) if (full[k] && ends[k] && !full[k + 1] && /^[\p{Lu}\d„"(]/u.test(first(k))) full[k] = false;
  // running text goes on in the middle of a sentence, so some line after a full one
  // starts with a small letter; titles or entries written one a line do not
  if (!lines.some((_, k) => full[k] && /^\p{Ll}/u.test(first(k)))) return { text: src, joined: 0 };
  const wide = lines.filter((_, k) => wrapped[k] && sizes[k] >= width / 2).length;
  const count = full.filter(Boolean).length;
  if (count < MIN_JOINS || count < FULL_SHARE * wide) return { text: src, joined: 0 };
  // evidence and typed pair, run by run
  for (let k = 0; k < lines.length; k++) {
    if (!full[k]) continue;
    let e = k;
    while (full[e]) e++;                                          // lines k..e become one
    const item = own[k] && ITEM.test(body[k]);
    const evident = item || lines.slice(k, e + 1).some((l) => INNER_END.test(l.trimEnd())) || SENTENCE_END.test(lines[e].trimEnd());
    const pair = !item && e === k + 1 && (typed(k - 1) || typed(e + 1));
    if (!evident || pair) full.fill(false, k, e);
    k = e;
  }
  const joined = full.filter(Boolean).length;
  if (!joined) return { text: src, joined: 0 };
  let out = '';
  lines.forEach((line, k) => {
    const part = k && full[k - 1] ? body[k].trimStart() : line;   // goes on behind the line before
    if (!full[k]) { out += part + (k + 1 < lines.length ? '\n' : ''); return; }
    const cut = part.trimEnd(), s = seam(cut, first(k));
    out += s === '-' ? cut.slice(0, -1) : cut + s;
  });
  return { text: out, joined };
}
