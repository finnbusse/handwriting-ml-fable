// The mark-up parser (web/js/generate/markup.js): Markdown with additions and a
// LaTeX subset -> the document model the page mode lays out.  No model needed.
import { parseMarkup, detectFormat, plainText, CHEAT_SHEET } from '../../web/js/generate/markup.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log('FAIL', msg); } };
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const same = (got, want, msg) => check(canon(got) === canon(want), `${msg}\n   got  ${canon(got)}\n   want ${canon(want)}`);
const today = new Date(2026, 10, 26);
const md = (t) => parseMarkup(t, 'markdown', { today }).blocks;
const tex = (t) => parseMarkup(t, 'latex', { today });
const line = (t) => { const b = md(t); return b.length === 1 && b[0].lines.length === 1 ? b[0].lines[0] : b; };
const T = (text, props = {}) => ({ text, ...props });
const A = (arrow, props = {}) => ({ text: '', arrow, ...props });
const P = (...lines) => ({ type: 'paragraph', lines });
const blank = { type: 'blank', lines: [] };

// 1. every construct of the language
same(md('# Titel'), [{ type: 'heading', level: 1, lines: [[T('Titel')]] }], '# heading');
same(md('## Zwei\n### Drei\n#### Vier ##'), [2, 3, 3].map((level, i) => ({ type: 'heading', level, lines: [[T(['Zwei', 'Drei', 'Vier'][i])]] })), '## / ### / #### (level 3), closing #s dropped');
same(md('#hashtag\n# '), [P([T('#hashtag')], [T('#')])], 'no space after # or nothing after it: plain text');
same(md('- Punkt\n* Stern\n+ Plus'), ['Punkt', 'Stern', 'Plus'].map((t) => ({ type: 'item', level: 1, marker: 'bullet', lines: [[T(t)]] })), 'bullets - * +');
same(md('1. Eins\n2) Zwei\na) Klein\nB. Groß\niv. Römisch'), ['1. Eins', '2) Zwei', 'a) Klein', 'B. Groß', 'iv. Römisch'].map((t) => ({ type: 'item', level: 1, marker: 'number', lines: [[T(t)]] })), 'numbered items keep their label as the first word');
same(md('- [ ] Aufgabe\n- [x] erledigt\n* [X] auch'), [['check', 'Aufgabe'], ['checked', 'erledigt'], ['checked', 'auch']].map(([marker, t]) => ({ type: 'item', level: 1, marker, lines: [[T(t)]] })), 'check boxes');
same(md('> Merksatz\n> zweite Zeile\n\n> anderer Kasten'), [{ type: 'paragraph', box: 1, lines: [[T('Merksatz')], [T('zweite Zeile')]] }, blank, { type: 'paragraph', box: 2, lines: [[T('anderer Kasten')]] }], 'consecutive > lines: one box; an empty line ends it');
same(md('---\n***\n- - -\n___'), Array(4).fill({ type: 'rule', lines: [] }), 'rules');
same(md('===\n{seite}\n{Seite}\n====='), Array(4).fill({ type: 'pagebreak', lines: [] }), 'page breaks');
same(md('{mitte} Mitte\n{rechts} Rechts\n{mitte} # Titel\n# {rechts} Auch'), [
  { type: 'paragraph', align: 'center', lines: [[T('Mitte')]] }, { type: 'paragraph', align: 'right', lines: [[T('Rechts')]] },
  { type: 'heading', level: 1, align: 'center', lines: [[T('Titel')]] }, { type: 'heading', level: 1, align: 'right', lines: [[T('Auch')]] }], 'alignment marks');
same(md('{mitte} a\n{mitte} b\nc'), [{ type: 'paragraph', align: 'center', lines: [[T('a')], [T('b')]] }, P([T('c')])], 'lines with the same alignment form one paragraph; an unmarked line starts a left one');
same(line('**kräftig** und __auch__'), [T('kräftig', { bold: true }), T(' und '), T('auch', { bold: true })], 'bold');
same(line('*betont* und _auch_'), [T('betont', { underline: true }), T(' und '), T('auch', { underline: true })], 'underlined');
same(line('==markiert== ==g=={grün} ==r=={rosa} ==b=={blau} ==o=={orange} ==y=={yellow}'), [
  T('markiert', { mark: 'gelb' }), T(' '), T('g', { mark: 'gruen' }), T(' '), T('r', { mark: 'rosa' }), T(' '), T('b', { mark: 'blau' }), T(' '), T('o', { mark: 'orange' }), T(' '), T('y', { mark: 'gelb' })], 'highlighter and its colours');
same(line('==x=={lila}'), [T('x', { mark: 'gelb' }), T('{lila}')], 'a highlighter colour that does not exist stays as typed');
same(line('~~falsch~~'), [T('falsch', { strike: true })], 'struck through');
same(line('[a]{rot} [b]{blau} [c]{grün} [d]{schwarz} [e]{orange} [f]{lila} [g]{grau} [h]{Red} [i]{green}').filter((s) => s.text.trim()),
  [['a', 'rot'], ['b', 'blau'], ['c', 'gruen'], ['d', 'schwarz'], ['e', 'orange'], ['f', 'lila'], ['g', 'grau'], ['h', 'rot'], ['i', 'gruen']].map(([t, color]) => T(t, { color })), 'ink colours, German and English');
same(line('[Text]{gelb}'), [T('Text', { mark: 'gelb' })], '[…]{gelb}: a colour that is only a highlighter highlights');
same(line('[Text]{magenta} [x]'), [T('[Text]{magenta} [x]')], 'unknown colour and a bare [x] stay as typed');
same(line('a -> b => c <- d <-> e'), [T('a '), A('right'), T(' b '), A('double'), T(' c '), A('left'), T(' d '), A('both'), T(' e')], 'ASCII arrows');
same(line('a → b ⇒ c ← d ↔ e'), [T('a '), A('right'), T(' b '), A('double'), T(' c '), A('left'), T(' d '), A('both'), T(' e')], 'arrow characters');
same(line('a-->b'), [T('a'), A('right'), T('b')], '--> is an arrow too');

// 2. nesting
same(line('==**x**=='), [T('x', { mark: 'gelb', bold: true })], '==**x**==');
same(line('**fett *und betont* fett**'), [T('fett ', { bold: true }), T('und betont', { bold: true, underline: true }), T(' fett', { bold: true })], 'underline inside bold');
same(line('***beides***'), [T('beides', { bold: true, underline: true })], '***x***');
same(line('[**rot fett** -> weiter]{rot}'), [T('rot fett', { color: 'rot', bold: true }), T(' ', { color: 'rot' }), A('right', { color: 'rot' }), T(' weiter', { color: 'rot' })], 'styles inside a colour, a coloured arrow');
same(line('~~==a==~~'), [T('a', { strike: true, mark: 'gelb' })], 'highlighted and struck');

// 3. literal cases
for (const t of ['5 * 3 = 15', 'a_b_c', 'C++ ist == gleich', 'E-Mail an max_mustermann@web.de', 'snake_case_name und 2*3*4', 'a * allein', 'a ** b', 'x == y', '~~ nix', 'ein ~ Tilde', 'Preis: 5 € -- 10 €', 'a <= b >= c'])
  same(line(t), [T(t)], `literal: ${t}`);
same(md('E-Mail'), [P([T('E-Mail')])], '"E-Mail" is not a rule');
same(line('Siehe https://de.wikipedia.org/wiki/Max_Planck_(Physiker) und www.x.de/__init__ hier'), [T('Siehe https://de.wikipedia.org/wiki/Max_Planck_(Physiker) und www.x.de/__init__ hier')], 'URLs keep their underscores');
same(line('**fett** https://a.de/_b_'), [T('fett', { bold: true }), T(' https://a.de/_b_')], 'mark before a URL');
same(line('2 -> 3'), [T('2 '), A('right'), T(' 3')], '"2 -> 3" is an arrow');
same(line('**offen'), [T('**offen')], 'unclosed bold stays');
same(line('Wort**fett**'), [T('Wort**fett**')], 'a mark glued to the word before does not open');
same(line('`a_b*c*`'), [T('a_b*c*')], 'inline code: backticks go, content literal');
same(md('z. B. so\nd. h. das'), [P([T('z. B. so')], [T('d. h. das')])], '"z. B." and "d. h." at the start of a line are not labels');

// 4. lists
same(md('- a\n  - b\n    - c\n      - d\n  - e\n- f'), [[1, 'a'], [2, 'b'], [3, 'c'], [3, 'd'], [2, 'e'], [1, 'f']].map(([level, t]) => ({ type: 'item', level, marker: 'bullet', lines: [[T(t)]] })), 'nesting by two spaces, at most 3 levels');
same(md('- a\n    - b\n        - c\n    - d'), [[1, 'a'], [2, 'b'], [3, 'c'], [2, 'd']].map(([level, t]) => ({ type: 'item', level, marker: 'bullet', lines: [[T(t)]] })), 'nesting by four spaces (as language models write it)');
same(md('- a\n\t- b'), [{ type: 'item', level: 1, marker: 'bullet', lines: [[T('a')]] }, { type: 'item', level: 2, marker: 'bullet', lines: [[T('b')]] }], 'a tab indents');
same(md('1. Erstens\n   a) Unterpunkt\n   b) noch einer\n2. Zweitens'), [[1, '1. Erstens'], [2, 'a) Unterpunkt'], [2, 'b) noch einer'], [1, '2. Zweitens']].map(([level, t]) => ({ type: 'item', level, marker: 'number', lines: [[T(t)]] })), 'nested numbered labels');
same(md('1. **Begriff:** Erklärung'), [{ type: 'item', level: 1, marker: 'number', lines: [[T('1. '), T('Begriff:', { bold: true }), T(' Erklärung')]] }], 'label before a bold first word');
same(md('- Punkt\n  geht weiter\nneuer Absatz'), [{ type: 'item', level: 1, marker: 'bullet', lines: [[T('Punkt')], [T('geht weiter')]] }, P([T('neuer Absatz')])], 'an indented line continues the item');
same(md('- a\n\n- b'), [{ type: 'item', level: 1, marker: 'bullet', lines: [[T('a')]] }, blank, { type: 'item', level: 1, marker: 'bullet', lines: [[T('b')]] }], 'an empty line between items stays');
same(md('- [ ]'), [{ type: 'item', level: 1, marker: 'bullet', lines: [[T('[ ]')]] }], 'a box with nothing after it: a bullet with the box as text (a block is never empty)');

// 5. boxes over several lines, with structure inside
same(md('> # Merke\n> - eins\n> **zwei**\n>\n> drei'), [
  { type: 'heading', level: 1, box: 1, lines: [[T('Merke')]] }, { type: 'item', level: 1, marker: 'bullet', box: 1, lines: [[T('eins')]] },
  { type: 'paragraph', box: 1, lines: [[T('zwei', { bold: true })]] }, { type: 'blank', box: 1, lines: [] }, { type: 'paragraph', box: 1, lines: [[T('drei')]] }], 'a box holds headings, items and empty lines');
same(md('>ohne Leerzeichen\n> {mitte} mittig'), [{ type: 'paragraph', box: 1, lines: [[T('ohne Leerzeichen')]] }, { type: 'paragraph', align: 'center', box: 1, lines: [[T('mittig')]] }], '>text and alignment inside a box');

// 6. escapes
same(line('\\*kein\\* \\_auch\\_ \\==nicht\\== \\-> \\[x\\]{rot} \\\\'), [T('*kein* _auch_ ==nicht== -> [x]{rot} \\')], 'a backslash keeps a mark literal');
same(md('\\# kein Titel\n\\- kein Punkt\n1\\. Mai\n\\> kein Kasten\n\\---'), [P([T('# kein Titel')], [T('- kein Punkt')], [T('1. Mai')], [T('> kein Kasten')], [T('---')])], 'escaped block marks');
same(line('C:\\Users\\max'), [T('C:\\Users\\max')], 'a backslash before a letter stays');

// 7. text, line ends, robustness
same(md('A\nB\n\nC\n\n\n'), [P([T('A')], [T('B')]), blank, P([T('C')])], 'plain text: lines, an empty line, trailing empty lines dropped');
same(md('\n\nA'), [blank, blank, P([T('A')])], 'leading empty lines stay');
same(md('a\r\nb\rc\nd'), [P([T('a')], [T('b')], [T('c')], [T('d')])], 'Windows and old Mac line ends');
same(md('a\tb  c   '), [P([T('a b  c')])], 'tab -> space, line ends trimmed');
same(parseMarkup('# **x** -> y', 'text').blocks, [P([T('# **x** -> y')])], "'text' keeps everything literal");
same(parseMarkup('', 'auto').blocks, [], 'empty text');
same(parseMarkup(null).blocks, [], 'null');
same(md('```\n**nicht fett**\n  - kein Punkt\n```'), [P([T('**nicht fett**')], [T('- kein Punkt')])], 'a code block is written as typed');
check(parseMarkup('| a | b |\n| c | d |', 'markdown').notes.includes('Markdown: Tabellen werden als Text geschrieben'), 'pipe lines without a delimiter row get a note');
const link = parseMarkup('Siehe [die Quelle](https://x.de/a_b) und ![Bild](b.png).', 'markdown');
same(link.blocks, [P([T('Siehe die Quelle und .')])], 'links keep their text, images go');
check(link.notes.length === 2, `links and images are named in notes (${link.notes})`);

// 8. a school essay as a language model types it
const essay = `# Der Klimawandel – Ursachen und Folgen

## Einleitung

Der **Klimawandel** ist eine der größten Herausforderungen unserer Zeit.

## Ursachen

- **Treibhausgase:** Vor allem CO₂ aus fossilen Brennstoffen.
- **Abholzung:** Wälder speichern Kohlenstoff.
  - Regenwald im Amazonas
- **Landwirtschaft** (z. B. Methan)

## Folgen

1. Steigender Meeresspiegel
2. Häufigere *Extremwetter*-Ereignisse

> „Wir sind die erste Generation, die die Folgen spürt.“
> — Barack Obama

---

**Fazit:** Es braucht schnelles Handeln → jetzt!`;
const ed = parseMarkup(essay);
check(ed.format === 'markdown' && ed.notes.length === 0, 'essay: Markdown, no notes');
same(ed.blocks.map((b) => b.type + (b.level ? b.level : '') + (b.marker ? ':' + b.marker : '') + (b.box ? '#' + b.box : '')), [
  'heading1', 'blank', 'heading2', 'blank', 'paragraph', 'blank', 'heading2', 'blank', 'item1:bullet', 'item1:bullet', 'item2:bullet', 'item1:bullet', 'blank',
  'heading2', 'blank', 'item1:number', 'item1:number', 'blank', 'paragraph#1', 'blank', 'rule', 'blank', 'paragraph'], 'essay: block structure');
same(ed.blocks[8].lines, [[T('Treibhausgase:', { bold: true }), T(' Vor allem CO₂ aus fossilen Brennstoffen.')]], 'essay: bold term in a bullet');
same(ed.blocks[16].lines, [[T('2. Häufigere '), T('Extremwetter', { underline: true }), T('-Ereignisse')]], 'essay: underlined word before a hyphen');
same(ed.blocks[18].lines.length, 2, 'essay: the two quote lines share one box');
same(ed.blocks.at(-1).lines, [[T('Fazit:', { bold: true }), T(' Es braucht schnelles Handeln '), A('right'), T(' jetzt!')]], 'essay: last line');

// 9. LaTeX
const L = (t) => tex(t).blocks;
same(L('\\section{Eins}\\subsection{Zwei}\\subsubsection*{Drei}'), [1, 2, 3].map((level, i) => ({ type: 'heading', level, lines: [[T(['Eins', 'Zwei', 'Drei'][i])]] })), 'sections');
same(L('\\textbf{f} \\emph{e} \\textit{i} \\underline{u} \\hl{h} \\sout{s} \\st{t}')[0].lines[0].filter((s) => s.text.trim()), [
  T('f', { bold: true }), T('e', { underline: true }), T('i', { underline: true }), T('u', { underline: true }), T('h', { mark: 'gelb' }), T('s', { strike: true }), T('t', { strike: true })], 'text styles');
same(L('\\textcolor{red}{rot} {\\color{blue} blau \\textbf{fett}} schwarz')[0].lines[0], [T('rot', { color: 'rot' }), T(' '), T('blau ', { color: 'blau' }), T('fett', { color: 'blau', bold: true }), T(' schwarz')], '\\textcolor and {\\color …} for its group');
same(L('{\\bfseries fett} normal'), [P([T('fett', { bold: true }), T(' normal')])], 'a declaration lasts to the end of its group');
same(L('a \\rightarrow b \\to c \\leftarrow d \\Rightarrow e \\leftrightarrow f')[0].lines[0], [T('a '), A('right'), T(' b '), A('right'), T(' c '), A('left'), T(' d '), A('double'), T(' e '), A('both'), T(' f')], 'arrow commands');
same(L('A $\\Rightarrow$ B, $a^2 + b^2$'), [P([T('A '), A('double'), T(' B, a^2 + b^2')])], '$…$: content as plain text, arrows inside drawn');
same(L('Zeile eins\\\\Zeile zwei\\newline drei'), [P([T('Zeile eins')], [T('Zeile zwei')], [T('drei')])], '\\\\ and \\newline');
same(L('ein Satz\nüber zwei Zeilen\n\nneuer Absatz'), [P([T('ein Satz über zwei Zeilen')]), blank, P([T('neuer Absatz')])], 'TeX: a single newline is a space, an empty line separates paragraphs');
same(L('a\\newpage b\\clearpage c'), [P([T('a')]), { type: 'pagebreak', lines: [] }, P([T('b')]), { type: 'pagebreak', lines: [] }, P([T('c')])], '\\newpage \\clearpage');
same(L('a\n\\hrule\nb \\hline'), [P([T('a')]), { type: 'rule', lines: [] }, P([T('b')]), { type: 'rule', lines: [] }], '\\hrule \\hline');
same(L('\\today'), [P([T('26. November 2026')])], '\\today in German');
same(L('\\begin{itemize}\\item a \\begin{itemize} \\item b \\begin{enumerate}\\item c \\item d\\end{enumerate}\\end{itemize}\\item e\\end{itemize}'), [
  { type: 'item', level: 1, marker: 'bullet', lines: [[T('a')]] }, { type: 'item', level: 2, marker: 'bullet', lines: [[T('b')]] },
  { type: 'item', level: 3, marker: 'number', lines: [[T('1. c')]] }, { type: 'item', level: 3, marker: 'number', lines: [[T('2. d')]] }, { type: 'item', level: 1, marker: 'bullet', lines: [[T('e')]] }], 'nested itemize / enumerate');
same(L('\\begin{enumerate}\\item a\\begin{enumerate}\\item b\\item c\\end{enumerate}\\item d\\end{enumerate}').map((b) => b.lines[0][0].text), ['1. a', 'a) b', 'b) c', '2. d'], 'enumerate labels: 1. then a)');
same(L('\\begin{itemize}\\item[$\\square$] offen \\item[\\checkmark] fertig \\item[Q1] Frage\\end{itemize}').map((b) => [b.marker, b.lines[0][0].text]), [['check', 'offen'], ['checked', 'fertig'], ['number', 'Q1 Frage']], '\\item[…] labels');
same(L('\\begin{center}Mitte\\end{center}\\begin{flushright}Rechts\\end{flushright}{\\centering Auch\\par}danach'), [
  { type: 'paragraph', align: 'center', lines: [[T('Mitte')]] }, { type: 'paragraph', align: 'right', lines: [[T('Rechts')]] }, { type: 'paragraph', align: 'center', lines: [[T('Auch')]] }, blank, P([T('danach')])], 'center, flushright, \\centering');
same(L('\\fbox{Kasten} \n\n\\boxed{Zwei}\n\n\\begin{framed}a\\\\b\\end{framed}'), [
  { type: 'paragraph', box: 1, lines: [[T('Kasten')]] }, blank, { type: 'paragraph', box: 2, lines: [[T('Zwei')]] }, blank, { type: 'paragraph', box: 3, lines: [[T('a')], [T('b')]] }], '\\fbox \\boxed framed');
const unknown = tex('\\frac{1}{2} und \\foo{x} \\foo{y} \\alpha.');
same(unknown.blocks, [P([T('1 2 und x y alpha.')])], 'unknown commands go, the content of their braces stays; a Greek letter is written by its name');
same(unknown.notes, ['LaTeX: \\frac wird nicht unterstützt', 'LaTeX: \\foo wird nicht unterstützt'], 'each unknown command named once');
same(tex('$\\alpha + \\beta$ und $\\varphi$').blocks, [P([T('alpha + beta und phi')])], 'Greek letters in math by their names');
same(L('\\"a\\"o\\"u\\ss{} Stra\\ss e \\\'e \\c{c} 50\\,\\% \\& \\$ \\{x\\} -- ---'), [P([T('äöüß Straße é ç 50 % & $ {x} – —')])], 'accents, escapes, dashes');
same(L('% nur Kommentar\nText % am Ende\nweiter 100\\% sicher'), [P([T('Text weiter 100% sicher')])], 'comments');
same(L('\\begin{array}{cc} a & b \\\\ c & d\\end{array}'), [P([T('a b')], [T('c d')])], 'an array (mathematics) stays text');

const small = `\\documentclass[12pt,a4paper]{article}
\\usepackage[ngerman]{babel}
\\usepackage{xcolor}
\\newcommand{\\R}{\\mathbb{R}}
\\title{Die \\textbf{Photosynthese}}
\\author{Max Muster \\and Erika Beispiel}
\\date{\\today}
\\begin{document}
\\maketitle

\\section{Einleitung}
Pflanzen nutzen \\emph{Licht}. Das ist "uberall so.

\\subsection*{Ablauf}
\\begin{enumerate}
  \\item Licht wird aufgenommen
  \\begin{itemize}
    \\item im Chlorophyll % grün
    \\item[--] in den Chloroplasten
  \\end{itemize}
  \\item Wasser $\\rightarrow$ Sauerstoff \\cite{buch}
\\end{enumerate}

\\begin{center}
\\fbox{Merksatz: Licht $\\Rightarrow$ Zucker}
\\end{center}
\\includegraphics[width=5cm]{blatt.png}
\\unbekannt{bleibt}
\\end{document}
ignoriert`;
const sd = tex(small);
same(sd.blocks, [
  { type: 'heading', level: 1, lines: [[T('Die '), T('Photosynthese', { bold: true })]] },
  { type: 'paragraph', align: 'right', lines: [[T('Max Muster, Erika Beispiel, 26. November 2026')]] },
  blank,
  { type: 'heading', level: 1, lines: [[T('Einleitung')]] },
  P([T('Pflanzen nutzen '), T('Licht', { underline: true }), T('. Das ist überall so.')]),
  blank,
  { type: 'heading', level: 2, lines: [[T('Ablauf')]] },
  { type: 'item', level: 1, marker: 'number', lines: [[T('1. Licht wird aufgenommen')]] },
  { type: 'item', level: 2, marker: 'bullet', lines: [[T('im Chlorophyll')]] },
  { type: 'item', level: 2, marker: 'bullet', lines: [[T('in den Chloroplasten')]] },
  { type: 'item', level: 1, marker: 'number', lines: [[T('2. Wasser '), A('right'), T(' Sauerstoff')]] },
  blank,
  { type: 'paragraph', align: 'center', box: 1, lines: [[T('Merksatz: Licht '), A('double'), T(' Zucker')]] },
  P([T('bleibt')]),
], 'a complete small LaTeX document');
same(sd.notes, ['LaTeX: \\cite wird nicht unterstützt', 'LaTeX: \\includegraphics wird nicht unterstützt', 'LaTeX: \\unbekannt wird nicht unterstützt'], 'small document: notes (the preamble, \\newcommand included, is dropped without a note)');
check(tex('\\newcommand{\\R}{x} a').notes.includes('LaTeX: \\newcommand wird nicht unterstützt'), '\\newcommand in the body is named');
same(tex('\\title{T}\\date{}\\maketitle').blocks, [{ type: 'heading', level: 1, lines: [[T('T')]] }], '\\date{} writes no date line');
same(L('"a stays'), [P([T('"a stays')])], 'without German babel a " is a quote mark');

// 9b. tables
{
  const TB = (columns, rows, more = {}) => ({ type: 'table', columns, rows, ...more });
  const tb = (t) => md(t).filter((b) => b.type === 'table').map(({ lines, ...rest }) => rest);
  same(tb('| Wort | Zahl | Mitte |\n|:---|---:|:-:|\n| Haus | 12 | x |\n| Baum | 3 | y |'), [TB(['left', 'right', 'center'], [
    { head: true, cells: [[T('Wort')], [T('Zahl')], [T('Mitte')]] }, { cells: [[T('Haus')], [T('12')], [T('x')]] }, { cells: [[T('Baum')], [T('3')], [T('y')]] }])], 'Markdown table: header, alignments from the colons');
  same(tb('Wort | Zahl\n--- | ---\nHaus | 12'), [TB(['left', 'left'], [{ head: true, cells: [[T('Wort')], [T('Zahl')]] }, { cells: [[T('Haus')], [T('12')]] }])], 'leading and trailing pipes are optional');
  same(tb('| a \\| b | c |\n|---|---|\n| `x|y` | \\\\|'), [TB(['left', 'left', 'left'], [{ head: true, cells: [[T('a | b')], [T('c')], []] }, { cells: [[T('`x')], [T('y`')], [T('\\')]] }])], 'an escaped pipe stays in its cell; an escaped backslash before a pipe does not escape it');
  same(tb('| A | B |\n|---|---|\n| **fett** ==gelb== | [rot]{rot} -> {datum} |\n| ~~weg~~ *unter* | a<br>b<BR/>c |'), [TB(['left', 'left'], [
    { head: true, cells: [[T('A')], [T('B')]] },
    { cells: [[T('fett', { bold: true }), T(' '), T('gelb', { mark: 'gelb' })], [T('rot', { color: 'rot' }), T(' '), A('right'), T(' 26.11.2026')]] },
    { cells: [[T('weg', { strike: true }), T(' '), T('unter', { underline: true })], [T('a'), T('', { br: true }), T('b'), T('', { br: true }), T('c')]] }])], 'inline marks, arrows and {datum} in cells; <br> breaks the line inside a cell');
  same(tb('| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |\n|  | x |  |'), [TB(['left', 'left', 'left', 'left'], [
    { head: true, cells: [[T('a')], [T('b')], [T('c')], []] }, { cells: [[T('1')], [], [], []] }, { cells: [[T('1')], [T('2')], [T('3')], [T('4')]] }, { cells: [[], [T('x')], [], []] }])], 'missing cells are empty, a ragged row adds a column (nothing typed is lost)');
  same(md('Ein Satz davor\n| a | b |\n|---|---|\n| c | d |\nDanach ohne Pipe').map((b) => b.type), ['paragraph', 'table', 'paragraph'], 'a table directly after a paragraph; a line without a pipe ends it');
  same(md('# Titel\n| a | b |\n|---|---|\n\n| c | d |').map((b) => b.type), ['heading', 'table', 'blank', 'paragraph'], 'a table directly after a heading; an empty line ends it');
  same(md('Preis | Menge im Satz\nnoch ein Satz'), [P([T('Preis | Menge im Satz')], [T('noch ein Satz')])], '"a | b" in a sentence is no table');
  same(md('| a | b |'), [P([T('| a | b |')])], 'a single line with pipes and no delimiter row is no table');
  same(md('| a | b |\n|---|---|---|'), [P([T('| a | b |')], [T('|---|---|---|')])], 'a delimiter row with another number of cells is no table');
  same(md('| a |\n| --- |\n| b |').filter((b) => b.type === 'table').length, 1, 'one column');
  same(md('| |\n|---|\n| |'), [], 'a table without any text writes nothing');
  const inBox = parseMarkup('> | a | b |\n> |---|---|', 'markdown'), inList = parseMarkup('- Punkt\n  | a | b |\n  |---|---|', 'markdown');
  check(inBox.blocks.every((b) => b.type !== 'table') && inBox.notes.join() === 'Markdown: Tabellen in Listen oder Kästen werden als Text geschrieben', `a table in a box is written as lines, with a note (${inBox.notes})`);
  check(inList.blocks.length === 1 && inList.blocks[0].type === 'item' && inList.blocks[0].lines.length === 3 && inList.notes.length === 1, 'a table in a list item is written as its lines, with a note');
  check(plainText(parseMarkup('| a | b |\n|---|---|\n| c |  |\n| -> | x<br>y |', 'markdown')) === 'a | b\nc\n→ | x y', 'plainText: a table row by row, its cells " | " apart');
  same(md('| a | b |\n|---|---|\n| **c** | d |')[0].lines, [[T('a'), T(' '), T('b')], [T('c', { bold: true }), T(' '), T('d')]], 'a table\'s lines: its rows\' words, for code that reads only lines');
  const ttb = (t) => tex(t).blocks.map((b) => { if (b.type !== 'table') return b; const { lines, ...rest } = b; return rest; });
  same(ttb('\\begin{tabular}{|l|c|r|}\\hline Ware & Größe & Preis \\\\ \\hline Brot & \\textbf{groß} & 2,50 \\\\ Milch & & 1 \\\\ \\hline\\end{tabular}'), [TB(['left', 'center', 'right'], [
    { head: true, cells: [[T('Ware')], [T('Größe')], [T('Preis')]] }, { cells: [[T('Brot')], [T('groß', { bold: true })], [T('2,50')]] }, { cells: [[T('Milch')], [], [T('1')]] }])], 'LaTeX tabular: l c r, | and \\hline read and dropped, the first row a header when a rule follows it');
  same(ttb('\\begin{tabular}{lr} a & b \\\\ c & d \\end{tabular}')[0].rows[0].head, undefined, 'no rule after the first row: no header');
  same(ttb('\\begin{tabular}{p{3cm}*{2}{c}@{}X} \\toprule a & b & c & d\\\\ \\midrule e\\newline f & g & h & i \\\\ \\bottomrule \\end{tabular}'), [TB(['left', 'center', 'center', 'left'], [
    { head: true, cells: [[T('a')], [T('b')], [T('c')], [T('d')]] }, { cells: [[T('e'), T('', { br: true }), T('f')], [T('g')], [T('h')], [T('i')]] }])], 'p{…}, *{n}{…}, @{}, X; booktabs rules; \\newline breaks the line in a cell');
  const cap = tex('Davor.\n\\begin{table}[h]\\centering\\caption{Preise im Kiosk}\\begin{tabular}{lr} Brot & 2 \\\\ \\end{tabular}\\end{table}\nDanach.');
  same(cap.blocks.map((b) => b.type), ['paragraph', 'table', 'paragraph'], 'a table environment: its tabular a table');
  same(cap.blocks[1].caption, [T('Preise im Kiosk')], '\\caption in a table environment is the table\'s caption, wherever it stands');
  check(cap.notes.length === 0, `a tabular gets no note (${cap.notes})`);
  same(tex('\\begin{table}\\caption{Nur Titel}\\end{table}').blocks, [{ type: 'paragraph', align: 'center', lines: [[T('Nur Titel')]] }], 'a caption without a tabular: a centred line');
  const merged = tex('\\begin{tabular}{ll} \\multicolumn{2}{c}{Kopf} \\\\ a & b \\end{tabular}');
  check(merged.blocks.every((b) => b.type !== 'table') && merged.notes.includes('LaTeX: Tabellen mit verbundenen Zellen (\\multicolumn, \\multirow) werden als Text geschrieben'), `merged cells: written as lines, with a note (${merged.notes})`);
  const nested = tex('\\begin{itemize}\\item \\begin{tabular}{ll} a & b \\end{tabular}\\end{itemize}');
  check(nested.blocks.every((b) => b.type !== 'table') && nested.notes.some((n) => /in Listen, Kästen/.test(n)), 'a tabular in a list: written as text, with a note');
  check(plainText(cap) === 'Davor.\nBrot | 2\nPreise im Kiosk\nDanach.', `plainText: rows, then the caption (${JSON.stringify(plainText(cap))})`);
}

// 10. detection
for (const [t, want] of [['\\begin{itemize}', 'latex'], ['\\section{A}', 'latex'], ['\\textbf{a} und \\emph{b}', 'latex'], ['nur \\textbf{a}', 'markdown'], ['# Titel\n**x**', 'markdown'], ['Ganz normaler Text.', 'markdown'], ['C:\\Users\\Max', 'markdown'], ['\\documentclass{article}\\usepackage{x}', 'latex']])
  check(detectFormat(t) === want, `detectFormat(${JSON.stringify(t)}) = ${detectFormat(t)}, want ${want}`);
check(parseMarkup('\\section{A} **b**').format === 'latex' && parseMarkup('**b**').format === 'markdown', "'auto' uses the detection");

// 11. plainText
same(plainText(parseMarkup('# Titel\n- **a**\n  - [ ] b\n1. c -> d\n\n> ==e==\n---\n===\n[f]{rot}')), '# Titel'.slice(2) + '\n• a\n  ☐ b\n1. c → d\n\ne\nf', 'plainText: marks gone, bullets, boxes and arrows as characters');
for (const t of ['Liebe Grüße aus dem Urlaub!\n\nDas Wetter ist herrlich.', 'eins\nzwei\n\n\ndrei', 'Er rief: „Süße Ähre“ – 3,50 €'])
  check(plainText(parseMarkup(t)) === t, `plainText(parse(plain)) is the text itself: ${JSON.stringify(t)}`);

// 12. fuzzing: random mark soup never throws and keeps the words
const rnd = (() => { let x = 12345; return () => ((x = Math.imul(x ^ (x >>> 15), 0x2C1B3C6D) + 0x9E3779B9 | 0) >>> 0) / 4294967296; })();
const MD_TOKENS = ['ab', 'Wort', '12', ' ', ' ', '  ', '\n', '\n\n', '*', '**', '_', '__', '==', '~~', '[', ']', '{rot}', '{grün}', '{mitte}', '{rechts}', '{datum}', '-', '->', '<-', '=>', '<->', '>', '#', '# ', '- ', '1. ', '  - ', '\\', '`', '{', '}', '\t', '\r', '---', '===', '[ ] ', '„', '€', 'ü', '→',
  '|', ' | ', '\n|', '|\n', '\n|---|---|\n', '\n| :-- | --: |\n', ':-:', '<br>', '\\|'];
const TEX_TOKENS = ['ab', 'Wort', ' ', '\n', '\n\n', '\\textbf{', '\\emph{', '{', '}', '}', '$', '\\\\', '%', '\\foo', '\\item ', '\\begin{itemize}', '\\end{itemize}', '\\begin{enumerate}', '\\end{enumerate}',
  '\\section{', '\\fbox{', '\\begin{center}', '\\end{center}', '~', '--', '\\"', '"a', '\\color{red}', '\\textcolor{blue}{', '\\[', '\\]', '\\rightarrow', '\\newpage', '\\hline', '[', ']', '\\', '\\item[', '\\verb|', '\\begin{verbatim}', '\\end{verbatim}', '\\hfill ',
  '\\begin{tabular}{l|cr}', '\\end{tabular}', '&', ' & ', '\\\\ \\hline ', '\\multicolumn{2}{c}{', '\\begin{table}', '\\end{table}', '\\caption{', '\\newline '];
const VALID_TYPES = new Set(['paragraph', 'heading', 'item', 'rule', 'pagebreak', 'blank', 'table']);
const validSpan = (s) => typeof s.text === 'string' && (s.arrow || s.br ? s.text === '' : s.text.length > 0);
const validTable = (b) => Array.isArray(b.columns) && b.columns.every((c) => ['left', 'center', 'right'].includes(c)) && Array.isArray(b.rows) && b.rows.length > 0
  && b.rows.every((r) => Array.isArray(r.cells) && r.cells.length === b.columns.length && r.cells.every((c) => Array.isArray(c) && c.every(validSpan))) && Array.isArray(b.lines) && b.lines.length > 0;
const alnum = (t) => (t.match(/[\p{L}\p{N}]/gu) ?? []).join('');
const isSub = (small, big) => { let k = 0; for (const c of big) if (c === small[k]) k++; return k === small.length; };
let thrown = 0, bad = 0, fallbacks = 0, lost = 0, tables = 0;
for (let r = 0; r < 3000; r++) {
  const latex = r % 3 === 2, tokens = latex ? TEX_TOKENS : MD_TOKENS;
  let t = '';
  for (let k = 0, n = 1 + Math.floor(rnd() * 60); k < n; k++) t += tokens[Math.floor(rnd() * tokens.length)];
  let doc;
  try { doc = parseMarkup(t, latex ? 'latex' : 'markdown', { today }); } catch (e) { thrown++; if (thrown < 3) console.log('threw on', JSON.stringify(t), e.message); continue; }
  if (doc.format === 'text') fallbacks++;
  tables += doc.blocks.filter((b) => b.type === 'table').length;
  const ok = Array.isArray(doc.blocks) && Array.isArray(doc.notes) && doc.blocks.every((b) => VALID_TYPES.has(b.type) && Array.isArray(b.lines)
    && (b.type !== 'table' || validTable(b))
    && (['rule', 'pagebreak', 'blank'].includes(b.type) ? b.lines.length === 0 : b.lines.length > 0 && b.lines.every((l) => l.length > 0 && l.every((s) => typeof s.text === 'string' && (s.arrow ? s.text === '' : s.text.length > 0))))
    && (b.type !== 'item' || (b.level >= 1 && b.level <= 3 && ['bullet', 'number', 'check', 'checked'].includes(b.marker))) && (b.type !== 'heading' || [1, 2, 3].includes(b.level)));
  if (!ok) { bad++; if (bad < 3) console.log('bad model for', JSON.stringify(t), canon(doc.blocks)); }
  if (!latex) {
    // Every letter and digit written was typed, in order ({datum} as typed or as the date); none is lost but the colour, alignment and date words in braces.
    const out = alnum(plainText(doc)), typed = alnum(t.replace(/\{datum\}/g, '{datum26.11.2026}')), must = alnum(t.replace(/\{(rot|grün|mitte|rechts|datum)\}|<br>/g, ''));
    if (!isSub(out, typed) || out.length < must.length) { lost++; if (lost < 3) console.log('words changed for', JSON.stringify(t), '->', JSON.stringify(plainText(doc))); }
  }
}
check(thrown === 0 && fallbacks === 0, `fuzz: never throws, never falls back to plain text (${thrown} thrown, ${fallbacks} fallbacks)`);
check(bad === 0, `fuzz: always a valid model (${bad} bad)`);
check(lost === 0, `fuzz: Markdown keeps every letter and digit in order (${lost} changed)`);
check(tables > 100, `fuzz: tables among the cases (${tables})`);

// 13. speed: 40,000 characters
const essayBig = (essay + '\n\n').repeat(Math.ceil(40000 / (essay.length + 2))).slice(0, 40000);
let soup = '';
while (soup.length < 40000) soup += MD_TOKENS[Math.floor(rnd() * MD_TOKENS.length)];
const oneLine = '*a _b ==c ~~d [e **f '.repeat(2000).slice(0, 40000);
const texBig = small.replace(/\\end\{document\}[\s\S]*/, '').repeat(40).slice(0, 40000);
const texSoup = Array.from({ length: 8000 }, () => TEX_TOKENS[Math.floor(rnd() * TEX_TOKENS.length)]).join('').slice(0, 40000);
const timing = {};
for (const [name, t, f] of [['essay', essayBig, 'auto'], ['soup', soup, 'markdown'], ['one_line', oneLine, 'markdown'], ['latex', texBig, 'latex'], ['latex_soup', texSoup, 'latex'], ['backticks', '`a'.repeat(20000), 'markdown'], ['braces', '{'.repeat(40000), 'latex'],
  ['nested_braces', '{'.repeat(20000) + 'x' + '}'.repeat(20000), 'latex'], ['nested_bold', '\\textbf{'.repeat(5000), 'latex'], ['quotes', '``x'.repeat(13000), 'latex'],
  ['dollars', '$a'.repeat(20000), 'latex'], ['deep_box', '> '.repeat(20000), 'markdown'], ['links', '[a](b'.repeat(8000), 'markdown'], ['items', '- a\n  - b\n'.repeat(4000), 'markdown'],
  ['table', ('| Wort | **12** | a\\|b |\n|---|--:|:-:|\n' + '| Haus | 3,50 € | ==x== |\n'.repeat(2000)).slice(0, 40000), 'markdown'], ['pipes', 'a | b | '.repeat(5000), 'markdown'],
  ['tabular', ('\\begin{tabular}{lcr}' + 'a & \\textbf{b} & c \\\\ \\hline '.repeat(1300) + '\\end{tabular}').slice(0, 40000), 'latex']]) {
  check(parseMarkup(t, f).format === f || f === 'auto', `${name}: parsed, not the plain-text fallback`);
  const t0 = performance.now();
  for (let k = 0; k < 5; k++) parseMarkup(t, f);
  timing[name] = +((performance.now() - t0) / 5).toFixed(1);
  check(timing[name] < 50, `40,000 characters (${name}) in ${timing[name]} ms`);
}

// 14. the cheat sheet
check(Array.isArray(CHEAT_SHEET) && CHEAT_SHEET.length >= 10 && CHEAT_SHEET.length <= 20 && CHEAT_SHEET.every((r) => r.schreiben && r.ergebnis), 'cheat sheet: 10-20 rows of { schreiben, ergebnis }');
for (const r of CHEAT_SHEET.slice(0, 13)) {
  const d = parseMarkup(r.schreiben.split('   ')[0], 'markdown');
  check(d.blocks.length > 0 && canon(d.blocks) !== canon(parseMarkup(r.schreiben.split('   ')[0], 'text').blocks), `cheat sheet row "${r.schreiben}" does what it says`);
}

// 15. a line in parts: left, centred, right; {datum}; \hfill
const C = (text, props = {}) => T(text, { part: 'center', ...props }), R = (text, props = {}) => T(text, { part: 'right', ...props });
same(md('# {datum} {mitte} Die Weimarer Republik'), [{ type: 'heading', level: 1, lines: [[T('26.11.2026', { body: true }), C('Die Weimarer Republik')]] }], 'heading line: date left (body text), title centred');
same(md('Anna Schmidt {rechts} {datum}'), [P([T('Anna Schmidt'), R('26.11.2026')])], 'name left, date right');
same(md('Deutsch {mitte} Erörterung {rechts} Klasse 7b'), [P([T('Deutsch'), C('Erörterung'), R('Klasse 7b')])], 'three parts');
same(md('## {datum} {mitte} Hausaufgaben'), [{ type: 'heading', level: 2, lines: [[T('26.11.2026', { body: true }), C('Hausaufgaben')]] }], 'level-2 heading in the middle');
same(md('# Titel {rechts} 7b'), [{ type: 'heading', level: 1, lines: [[T('Titel'), R('7b', { body: true })]] }], 'no centred part: the heading is the left part');
same(md('{mitte} Titel {rechts} 7b'), [P([C('Titel'), R('7b')])], 'a mark at the start of a line with parts: the first part centred, no left part');
same(md('{mitte} Mitte\n{rechts} Rechts'), [{ type: 'paragraph', align: 'center', lines: [[T('Mitte')]] }, { type: 'paragraph', align: 'right', lines: [[T('Rechts')]] }], 'a mark at the start of a line without parts: the whole line, as before');
same(md('Text {mitte}\n{datum} {rechts}  '), [P([T('Text')], [T('26.11.2026')])], 'an empty part is dropped; a line left with one part is an ordinary line');
same(md('**Name:** Tim {rechts} ==Seite 12=='), [P([T('Name:', { bold: true }), T(' Tim'), R('Seite 12', { mark: 'gelb' })])], 'marks inside parts');
same(md('**fett {rechts} rechts**'), [P([T('fett', { bold: true }), R('rechts', { bold: true })])], 'a part mark inside a styled run: the style goes on');
same(md('{datum}: Heute ist {DATUM}.'), [P([T('26.11.2026: Heute ist 26.11.2026.')])], '{datum} anywhere, any case');
same(parseMarkup('{datum}', 'markdown', { today: new Date(2026, 2, 5) }).blocks, [P([T('05.03.2026')])], '{datum}: day and month with two digits');
same(md('a \\{mitte} b \\{datum} `{rechts}` c'), [P([T('a {mitte} b {datum} {rechts} c')])], 'after a backslash and in code the marks stay as typed');
same(md('a {rechts} b {mitte} c {rechts} d'), [P([T('a'), R('b {mitte} c {rechts} d')])], 'parts only go on to the right: a later mark that goes back or repeats stays as typed');
same(md('- Punkt {rechts} 5\n1. {datum} {mitte} x'), [{ type: 'item', level: 1, marker: 'bullet', lines: [[T('Punkt {rechts} 5')]] }, { type: 'item', level: 1, marker: 'number', lines: [[T('1. 26.11.2026 {mitte} x')]] }], 'list items have no parts (the marks stay), {datum} works');
{
  const notes = (s) => parseMarkup(s, 'markdown', { today }).notes;
  check(notes('a {rechts} b {mitte} c').length === 1 && notes('- Punkt {rechts} 5').length === 1 && notes('a {mitte} b {rechts} c').length === 0 && notes('a \\{mitte} b {datum}').length === 0, 'a mark that stays as typed gets a note; marks that split, escaped marks and {datum} get none');
}
same(md('> Name {rechts} Datum'), [{ type: 'paragraph', box: 1, lines: [[T('Name'), R('Datum')]] }], 'parts inside a box');
same(md('Eins {rechts} 1\nZwei {rechts} 2'), [P([T('Eins'), R('1')], [T('Zwei'), R('2')])], 'lines in parts stay one paragraph');
check(plainText(parseMarkup('# {datum} {mitte} Titel {rechts} 7b', 'markdown', { today })) === '26.11.2026 Titel 7b', 'plainText: the parts one space apart in reading order');
{
  const tx = (body) => tex(`\\documentclass{article}\\begin{document}\n${body}\n\\end{document}`).blocks;
  same(tx('Anna Schmidt \\hfill \\today'), [P([T('Anna Schmidt'), R('26. November 2026')])], 'LaTeX: a \\hfill b is left and right');
  same(tx('Deutsch \\hfill \\textbf{Erörterung} \\hfill 7b\\\\\nName \\hfill Datum'), [P([T('Deutsch'), C('Erörterung', { bold: true }), R('7b')], [T('Name'), R('Datum')])], 'LaTeX: two \\hfill left, centre, right; per line');
  same(tx('\\hfill rechts'), [P([R('rechts')])], 'LaTeX: \\hfill before the text sets it right');
  same(tx('\\section{\\today \\hfill Titel \\hfill}'), [{ type: 'heading', level: 1, lines: [[T('26. November 2026', { body: true }), C('Titel')]] }], 'LaTeX: a heading with parts, the centred one is the heading');
  same(tx('a \\hfill b \\hfill c \\hfill d'), [P([T('a'), C('b'), R('c d')])], 'LaTeX: a third \\hfill is a space');
  same(tx('\\begin{itemize}\\item a \\hfill b\\end{itemize}'), [{ type: 'item', level: 1, marker: 'bullet', lines: [[T('a b')]] }], 'LaTeX: \\hfill in a list item is a space');
}

console.log(JSON.stringify({ fuzz_cases: 3000, timing_ms: timing, failures }));
process.exit(failures ? 1 : 0);
