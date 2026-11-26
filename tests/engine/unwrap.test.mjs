// Joining the lines of a text that carries the line breaks of a narrower source column
// (web/js/generate/unwrap.js).  No model needed.
import { unwrapLines, MIN_WIDTH } from '../../web/js/generate/unwrap.js';
import { DELIBERATE, ADJACENT_EXCEPT, STILL_JOINED, FLOWING, FLOWING_EXCEPT, MIXED, MIXED_EXCEPT, SENTENCES, SHORT_LINES, wrap, prop, score } from './unwrap.corpus.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log('FAIL', msg); } };
const same = (got, want, msg) => check(got === want, `${msg}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`);
const kept = (text, msg) => { const r = unwrapLines(text); check(r.joined === 0 && r.text === text, `${msg}: left as it is (joined ${r.joined})`); };
// 1. the text this was built for: a law copied from a web page, 70 characters a line
const law = `Art 1

(1) Die Würde des Menschen ist unantastbar. Sie zu achten und zu schützen ist Verpflichtung aller staatlichen Gewalt.

(2) Das Deutsche Volk bekennt sich darum zu unverletzlichen und unveräußerlichen Menschenrechten als Grundlage jeder menschlichen Gemeinschaft, des Friedens und der Gerechtigkeit in der Welt.

(3) Die nachfolgenden Grundrechte binden Gesetzgebung, vollziehende Gewalt und Rechtsprechung als unmittelbar geltendes Recht.

Art 2

(1) Jeder hat das Recht auf die freie Entfaltung seiner Persönlichkeit, soweit er nicht die Rechte anderer verletzt und nicht gegen die verfassungsmäßige Ordnung oder das Sittengesetz verstößt.`;
for (const width of [60, 70, 80, 100]) {
  const r = unwrapLines(wrap(law, width));
  same(r.text, law, `a law wrapped at ${width}: every paragraph one line again`);
  check(r.joined === wrap(law, width).split('\n').length - law.split('\n').length, `wrapped at ${width}: as many joins as breaks added (${r.joined})`);
}
// paragraphs with single line breaks between them (no empty lines) stay apart
{
  const flat = law.replace(/\n\n/g, '\n');
  const r = unwrapLines(wrap(flat, 70));
  const paras = r.text.split('\n');
  check(r.joined > 0 && paras.filter((p) => /^\(\d\)/.test(p)).length === 4 && paras.includes('Art 2'), `no empty lines: the numbered paragraphs and headings start their own lines (${paras.length} lines)`);
}

// 2. what must stay as typed
kept('Hallo Anna,\nvielen Dank für die Karte.\nBis bald\nTim', 'short lines of a note');
kept('Der Mond ist aufgegangen,\nDie goldnen Sternlein prangen\nAm Himmel hell und klar.\nDer Wald steht schwarz und schweiget,\nUnd aus den Wiesen steiget\nDer weiße Nebel wunderbar.', `a poem (narrower than ${MIN_WIDTH})`);
kept('Milch\nEier\nBrot\nButter\nKäse', 'a shopping list');
kept(law, 'paragraphs typed in one line each');
kept(['Erstens ist das Wetter in diesem Jahr deutlich wärmer als erwartet.', 'Zweitens hat es im Frühling nur sehr wenig geregnet.', 'Drittens sind die Preise für Obst und Gemüse deshalb stark gestiegen.', 'Viertens kaufen viele Leute nun weniger ein.', 'Fünftens merken das auch die Händler auf dem Markt.', 'Sechstens wird sich das so schnell nicht ändern.'].join('\n'), 'sentences one per line, of different lengths');
kept(['Die Preise für Obst und Gemüse sind in diesem Jahr stark gestiegen.', 'Viele Leute kaufen deshalb weniger ein und kochen häufiger selbst.', 'Auch die Händler auf dem Wochenmarkt merken das inzwischen deutlich.', 'Im nächsten Jahr soll die Ernte nach den Prognosen besser werden.', 'Bis dahin bleibt den meisten nichts übrig, als genauer zu rechnen.', 'Manche bauen sogar wieder eigenes Gemüse im Garten oder Hof an.'].join('\n'), 'sentences one per line, of the same length');
kept(['Projektplan für das dritte Quartal mit allen Meilensteinen und Terminen', 'Budgetübersicht der einzelnen Abteilungen inklusive aller Sonderposten', 'Liste der offenen Fragen an die Geschäftsführung und den Betriebsrat', 'Protokoll der letzten Sitzung vom Dienstag mit den Beschlüssen dazu', 'Einladung zur nächsten Besprechung im großen Raum im zweiten Stock'].join('\n'), 'long entries one per line, each starting with a capital');
kept('', 'an empty text');
kept('ein Wort', 'one line');
kept(wrap(law, 70).split('\n').slice(0, 3).join('\n'), 'too few lines to tell');

// 3. marks are respected: nothing is joined onto or into a block of its own
{
  const body = 'Die Fotosynthese ist der Vorgang, bei dem Pflanzen aus Licht, Wasser und Kohlendioxid Zucker und Sauerstoff bilden, und sie findet in den Chloroplasten der grünen Blätter statt.';
  const doc = `# Ein Titel, der ziemlich lang ist und fast die ganze Breite der Spalte füllt\n${body}\n- ein Punkt in einer Liste, der so lang ist, dass er in der Quelle umbrochen wurde, weil er nicht passt\n- zweiter Punkt\n> Merke: ohne Licht keine Fotosynthese, und ohne Wasser auch nicht, das gilt immer\n| Stoff | Menge | und noch eine Spalte, damit die Zeile lang genug wird |\n|---|---|---|\n${body}\n---\n{mitte} ${body}`;
  const r = unwrapLines(wrap(doc, 60));
  const lines = r.text.split('\n');
  check(r.joined > 0, 'a wrapped Markdown text is joined');
  check(lines.some((l) => l === body), 'its paragraph is one line again');
  check(lines.filter((l) => l.startsWith('- ')).length === 2 && lines.some((l) => l.startsWith('- ein Punkt') && l.endsWith('nicht passt')), 'list items start their own lines; a wrapped item is whole again');
  check(lines.some((l) => l.startsWith('> Merke')) && lines.includes('---') && lines.includes('|---|---|---|') && lines.some((l) => l.startsWith('{mitte} ')), 'quote, rule, table rows and alignment marks start their own lines');
  check(!lines.some((l) => /\S \| Stoff|\| \S.*\|---/.test(l)), 'nothing is joined onto or into a table row');
}
{
  const hard = wrap(law, 70).split('\n');
  hard[2] += '  ';                                    // a Markdown hard break
  const r = unwrapLines(hard.join('\n'));
  check(r.text.includes('Sie zu achten und zu  \nschützen'), 'two spaces at the end of a line keep its break');
}
{
  const code = '```\n' + wrap(law, 70) + '\n```';
  kept(code, 'a fenced block');
}

// 4. a line that was never wrapped does not hide the column
{
  const r = unwrapLines(`${wrap(law, 70)}\n\nhttps://www.gesetze-im-internet.de/gg/BJNR000010949.html#BJNR000010949BJNG000100314 und noch viel mehr Text in einer einzigen sehr langen Zeile, die nie umbrochen wurde`);
  check(r.joined === unwrapLines(wrap(law, 70)).joined && r.text.startsWith(law), `one very long line beside wrapped ones (${r.joined})`);
}

// 4b. a source set in a proportional font: lines wrapped by width, not by count
{
  const NARROW = new Set([...'iljtfrI1.,:;!| ()']), WIDE = new Set([...'mwMWGODÜÖ']);
  const wide = (s) => [...s].reduce((a, c) => a + (NARROW.has(c) ? 0.55 : WIDE.has(c) ? 1.5 : /\p{Lu}/u.test(c) ? 1.25 : 1), 0);
  const prop = (text, width) => text.split('\n').map((par) => {
    const out = [];
    let line = '';
    for (const w of par.split(' ')) { if (line && wide(`${line} ${w}`) > width) { out.push(line); line = w; } else line = line ? `${line} ${w}` : w; }
    return [...out, line].join('\n');
  }).join('\n');
  const long = [law, law.replace(/Art (\d)/g, 'Artikel $1')].join('\n\n');
  for (const width of [55, 70]) {
    const src = prop(long, width), r = unwrapLines(src);
    const added = src.split('\n').length - long.split('\n').length, left = r.text.split('\n').length - long.split('\n').length;
    const sizes = src.split('\n').filter((l) => [...l].length > width / 2).map((l) => [...l].length);
    // what stays is a break behind the end of a sentence (it could end a paragraph)
    const stay = r.text.split('\n').filter((l, k, all) => k + 1 < all.length && l && all[k + 1] && !long.split('\n').includes(l)).every((l) => /[.!?:]$/.test(l));
    check(left <= 0.2 * added && stay, `proportional source, width ${width}: lines of ${Math.min(...sizes)} to ${Math.max(...sizes)} characters; ${added - left} of ${added} breaks joined, the rest behind a sentence end (${stay})`);
  }
}

// 6. the owner's wishes, in their order of weight
// (b) a break typed on purpose stays: every deliberate text comes out as it went in
for (const c of DELIBERATE) kept(c.text, `deliberate: ${c.name}`);
for (const c of STILL_JOINED) console.log(`known: "${c.name}" is joined (${unwrapLines(c.text).joined}): ${c.why}`);
// ... and beside a wrapped paragraph, which sets the column and makes the text count as wrapped
{
  const paras = [SENTENCES.slice(0, 4).join(' '), SENTENCES.slice(-14, -10).join(' ')];
  for (const c of DELIBERATE) {
    let lost = 0;
    for (const width of [60, 72, 80]) for (const p of paras) for (const below of [false, true]) {
      const src = below ? `${wrap(p, width)}\n\n${c.text}` : `${c.text}\n\n${wrap(p, width)}`;
      if (!unwrapLines(src).text.includes(c.text)) lost++;
    }
    const want = ADJACENT_EXCEPT[c.name]?.lost ?? 0;
    check(lost === want, `deliberate beside a wrapped paragraph: ${c.name}: changed in ${lost} of 12 placements (want ${want})`);
  }
  for (const [name, e] of Object.entries(ADJACENT_EXCEPT)) console.log(`known: "${name}" beside a wrapped paragraph: changed in ${e.lost} of 12: ${e.why}`);
}
// ... and in a document of both, every break of the writer's own stays, the exceptions named
const lostWords = (c, s) => s.lost.map((b) => c.orig.split(/\s+/u).filter(Boolean).slice(b - 2, b + 2).join(' ')).join(' | ');
{
  let breaks = 0, lost = 0;
  for (const c of MIXED) {
    const s = score(c.orig, c.src, unwrapLines(c.src).text), want = MIXED_EXCEPT[c.name] ?? { missed: 0, destroyed: 0 };
    breaks += s.deliberate; lost += s.destroyed;
    check(s.destroyed === want.destroyed && s.missed === want.missed, `mixed: ${c.name}: ${s.destroyed} of ${s.deliberate} own breaks lost (want ${want.destroyed}${s.destroyed ? `: ${lostWords(c, s)}` : ''}), ${s.missed} of ${s.added} copied breaks left (want ${want.missed})`);
  }
  for (const [name, e] of Object.entries(MIXED_EXCEPT)) console.log(`known: mixed "${name}": ${e.destroyed} lost, ${e.missed} left: ${e.why}`);
  check(lost <= 1, `mixed documents: ${lost} of ${breaks} own breaks lost`);
}
// (a) a copied text flows
for (const c of FLOWING) {
  const r = unwrapLines(c.src);
  if (c.expect) { same(r.text, c.expect, `flowing: ${c.name}`); continue; }
  const s = score(c.orig, c.src, r.text), want = FLOWING_EXCEPT[c.name] ?? { missed: 0, destroyed: 0 };
  check(s.missed === want.missed && s.destroyed === want.destroyed, `flowing: ${c.name}: ${s.missed} of ${s.added} copied breaks left (want ${want.missed}), ${s.destroyed} of ${s.deliberate} own lost (want ${want.destroyed})`);
}
for (const [name, e] of Object.entries(FLOWING_EXCEPT)) console.log(`known: flowing "${name}": ${e.missed} left, ${e.destroyed} lost: ${e.why}`);
// random documents of those sentences: an own break is lost only behind a sentence end (a
// paragraph that ends on a full line, before one that goes on), and few copied ones stay
// (a 32-bit generator: the same formula in doubles loses bits and repeats its texts, 123
// distinct ones in 20,000)
let seed = 11;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) / 16777216; };
const docs = Array.from({ length: 3000 }, () => {
  const paras = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => SENTENCES[Math.floor(rnd() * SENTENCES.length)]).join(' '));
  const sep = rnd() < 0.5 ? '\n\n' : '\n';
  const orig = paras.flatMap((p) => (rnd() < 0.25 ? [SHORT_LINES[Math.floor(rnd() * SHORT_LINES.length)], p] : [p])).join(sep);
  const width = 45 + Math.floor(rnd() * 40);
  return { orig, src: (rnd() < 0.5 ? wrap : prop)(orig, width) };
});
{
  let added = 0, missed = 0, deliberate = 0, destroyed = 0, odd = 0;
  for (const c of docs) {
    const s = score(c.orig, c.src, unwrapLines(c.src).text), words = c.orig.split(/\s+/u).filter(Boolean);
    added += s.added; missed += s.missed; deliberate += s.deliberate; destroyed += s.destroyed;
    odd += s.lost.filter((b) => !/[.!?]$/u.test(words[b - 1])).length;
  }
  check(odd === 0, `3000 random documents: ${destroyed} of ${deliberate} own breaks lost, ${odd} of them not behind a sentence end`);
  check(missed <= 0.03 * added, `3000 random documents: ${missed} of ${added} copied breaks left`);
}

// 7. what changes: line breaks become spaces, a split word loses its hyphen, a joined
// quoted line its quote mark; nothing else.  Running it again changes nothing.
const onlyJoins = (src, out) => {
  const a = src.replace(/\s+/gu, ''), b = [...out.replace(/\s+/gu, '')];
  let j = 0;
  for (const ch of a) if (ch === b[j]) j++; else if (ch !== '-' && ch !== '>') return false;
  return j === b.length;
};
{
  const src = wrap(law, 70), r = unwrapLines(src);
  same(r.text.replace(/\s+/gu, ' '), src.replace(/\s+/gu, ' '), 'a law: only white space differs');
  same(unwrapLines(r.text).text, r.text, 'idempotent');
  let bad = 0, again = 0;
  for (const c of [...DELIBERATE.map((d) => d.text), ...FLOWING.map((f) => f.src), ...MIXED.map((m) => m.src), ...docs.map((d) => d.src)]) {
    const u = unwrapLines(c).text;
    if (!onlyJoins(c, u)) bad++;
    if (unwrapLines(u).text !== u) again++;
  }
  check(bad === 0 && again === 0, `all texts above: ${bad} changed more than their joins, ${again} changed by a second run`);
  seed = 1;
  const words = ['und', 'die', 'Gerechtigkeit', 'in', '(1)', '-', '#', '|', '>', 'Öl', 'z.', 'B.', '§', '3', '1.', 'a)', '---', '{mitte}', 'ist.', '```', '  ', '\\', 'Ende.', 'weil', 'Haus-', '<br>', '\t', '***', '===', 'Die', 'Liebe', 'Anna,', '    '];
  bad = 0; again = 0;
  for (let i = 0; i < 5000; i++) {
    const text = Array.from({ length: 1 + Math.floor(rnd() * 20) }, () => Array.from({ length: Math.floor(rnd() * 18) }, () => words[Math.floor(rnd() * words.length)]).join(' ')).join('\n');
    const u = unwrapLines(text);
    if (!onlyJoins(text, u.text) || (!u.joined && u.text !== text)) bad++;
    if (unwrapLines(u.text).text !== u.text) again++;
  }
  check(bad === 0 && again === 0, `5000 random texts of marks and words: ${bad} changed more than their joins, ${again} changed by a second run`);
}

// 8. time: a long text, and inputs that make a careless regular expression backtrack
{
  const t0 = performance.now();
  unwrapLines(wrap(Array(150).fill(law).join('\n\n'), 70));
  check(performance.now() - t0 < 200, `40 000 characters in ${(performance.now() - t0).toFixed(1)} ms`);
  const four = (line) => [line, line, line, line].join('\n');
  const hard = {
    'a run of 100 000 spaces before a letter': four(`a${' '.repeat(100000)}b`),
    'tabs and spaces alternating': four(`a${'\t '.repeat(100000)}b`),
    '"- " 25 000 times': four(`${'- '.repeat(25000)}x`),
    '"<br" before 50 000 spaces': four(`<br${' '.repeat(50000)}x`),
    'a full stop before 100 000 spaces': four(`Ende.${' '.repeat(100000)}a`),
    '". " 50 000 times': four(`${'. '.repeat(50000)}a`),
    'a greeting of 100 000 characters': four(`Liebe ${'a, '.repeat(33000)}x`),
    'hyphens 50 000 times': four(`${'Haus-'.repeat(50000)}`),
    'quote marks 50 000 deep': four(`${'> '.repeat(50000)}Text`),
    'a word of 100 000 dots before an opener': [...Array(3).fill(`a${'.'.repeat(100000)}b`), 'Die...'].join('\n'),
    'a word of 100 000 commas before an opener': [...Array(3).fill(`a${','.repeat(100000)}b`), 'Die,,,'].join('\n'),
    'an entry of 100 000 spaces': four(`Lisa${' '.repeat(100000)}x`),
  };
  for (const [name, text] of Object.entries(hard)) {
    const t1 = performance.now();
    unwrapLines(text);
    const ms = performance.now() - t1;
    check(ms < 200, `${name}: ${ms.toFixed(1)} ms`);
  }
}

console.log(JSON.stringify({ failures }));
process.exit(failures ? 1 : 0);
