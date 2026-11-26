// The texts of tests/engine/unwrap.test.mjs, each with what must come out.  The owner's two
// wishes, in this order of weight: a line break typed on purpose stays (DELIBERATE, the
// breaks of MIXED); a text copied with the breaks of its source column flows (FLOWING).
// What still goes wrong is listed by name with its reason (*_EXCEPT, STILL_JOINED).
const L = (s) => [...s].length;
// a text wrapped the way a source column does: a line ends when the next word would pass `width`
export const wrap = (text, width) => text.split('\n').map((par) => {
  const out = []; let line = '';
  for (const w of par.split(' ')) { if (line && L(line) + 1 + L(w) > width) { out.push(line); line = w; } else line = line ? `${line} ${w}` : w; }
  return [...out, line].join('\n');
}).join('\n');
// the same with a quote mark on every line, as an e-mail program quotes
export const wrapPrefix = (text, width, prefix) => wrap(text, width - L(prefix)).split('\n').map((l) => prefix + l).join('\n');
// a source set in a proportional font: lines wrapped by width, not by count
const NARROW = new Set([...'iljtfrI1.,:;!| ()\'"-']), WIDE = new Set([...'mwMWGODÜÖQ']);
const wide = (s) => [...s].reduce((a, c) => a + (NARROW.has(c) ? 0.5 : WIDE.has(c) ? 1.5 : /\p{Lu}/u.test(c) ? 1.25 : 1), 0);
export const prop = (text, width) => text.split('\n').map((par) => {
  const out = []; let line = '';
  for (const w of par.split(' ')) { if (line && wide(`${line} ${w}`) > width) { out.push(line); line = w; } else line = line ? `${line} ${w}` : w; }
  return [...out, line].join('\n');
}).join('\n');
// the line breaks of a text, as the number of words before each
const breaks = (text) => { const set = new Set(); let w = 0; for (const t of text.split(/(\s+)/u)) { if (!t) continue; if (/^\s+$/u.test(t)) { if (t.includes('\n')) set.add(w); } else w++; } return set; };
// orig: the text as written; src: as copied; out: as joined.  A break of orig that is gone
// from out is destroyed; a break src added that is still in out is missed.
export function score(orig, src, out) {
  const o = breaks(orig), r = breaks(out);
  const s = { added: 0, missed: 0, deliberate: 0, destroyed: 0, lost: [] };
  for (const b of breaks(src)) {
    if (o.has(b)) { s.deliberate++; if (!r.has(b)) { s.destroyed++; s.lost.push(b); } } else { s.added++; if (r.has(b)) s.missed++; }
  }
  return s;
}

// 1. Texts typed with their line breaks on purpose: every one must come out unchanged.
export const DELIBERATE = [];
const keep = (name, text) => DELIBERATE.push({ name, text });

keep('address', 'Familie Schneider\nAm Lindenweg 14\n72070 Tübingen\nDeutschland');
keep('address block in letter', 'Max Mustermann\nHauptstraße 5\n10115 Berlin\n\nStadtverwaltung Musterstadt\nBürgerbüro, Zimmer 112\nRathausplatz 1\n12345 Musterstadt');
keep('poem short', 'Über allen Gipfeln\nIst Ruh,\nIn allen Wipfeln\nSpürest du\nKaum einen Hauch;\nDie Vögelein schweigen im Walde.\nWarte nur, balde\nRuhest du auch.');
keep('poem long lines (Rilke Panther-like, own text)', 'Sein Blick ist vom Vorübergehn der Stäbe so müd geworden, dass er nichts mehr hält\nihm ist, als ob es tausend Stäbe gäbe und hinter tausend Stäben keine Welt\nder weiche Gang geschmeidig starker Schritte, der sich im allerkleinsten Kreise dreht\nist wie ein Tanz von Kraft um eine Mitte, in der betäubt ein großer Wille steht');
keep('poem long lines, lowercase starts, no punctuation', 'und wenn der abend kommt über die stillen felder der stadt\nund die lichter angehen eines nach dem anderen in den fenstern\ndann denke ich an dich und an den sommer der nie zu ende ging\nund an die straße die wir gegangen sind bis an das ende der welt\nwo das meer anfängt und die möwen schreien über dem hafen');
keep('song lyrics with chorus', 'Wir fahren übers Land und singen laut die alten Lieder mit\nDie Fenster offen, der Wind in den Haaren, und keiner von uns sagt ein Wort\nund irgendwo da vorne wartet schon der Sommer auf uns zwei\nund wenn die Sonne untergeht, dann sind wir endlich frei\n\nOh oh, nur wir zwei\nOh oh, endlich frei');
keep('song lyrics long, mixed', 'I walked along the river where the willows used to grow\nand every stone was talking of the days of long ago\nmy father built a cabin there before the war was won\nand mother sang the old songs in the evening to her son\n\nAnd oh, the river rolls\nand oh, the river knows');
keep('dialogue', 'Anna: Kommst du heute Abend noch mit ins Kino, oder musst du wieder arbeiten?\nBen: Ich weiß noch nicht genau, das hängt davon ab, wann ich hier fertig werde.\nAnna: Der Film fängt erst um neun an, das solltest du doch schaffen können.\nBen: Gut, dann sag ich dir spätestens um sieben Bescheid, ob es klappt oder nicht.');
keep('dialogue no names, dashes', '„Kommst du heute Abend noch mit ins Kino?“, fragte Anna leise.\n„Ich weiß noch nicht“, sagte Ben und sah auf die Uhr an der Wand.\n„Der Film fängt erst um neun an, das schaffst du doch“, meinte sie.\n„Gut, dann sag ich dir spätestens um sieben Bescheid“, versprach er.');
keep('notes one fact a line', 'Termin beim Zahnarzt am Donnerstag um halb neun, Karte mitnehmen\nmorgen Oma anrufen wegen der Feier am Wochenende und Kuchen bestellen\nAuto muss im März zum TÜV, vorher noch die Bremsen prüfen lassen\nRechnung für den Strom bis Ende des Monats überweisen, sonst Mahnung');
keep('notes one fact a line, capital starts', 'Termin beim Zahnarzt am Donnerstag um halb neun, Karte mitnehmen\nOma anrufen wegen der Feier am Wochenende und Kuchen bestellen\nAuto muss im März zum TÜV, vorher noch die Bremsen prüfen lassen\nRechnung für den Strom bis Ende des Monats überweisen, sonst Mahnung');
keep('one sentence per line, punctuated', 'Heute war ein langer Tag in der Schule und ich bin sehr müde.\nIn Mathe haben wir eine Arbeit über Brüche geschrieben.\nDanach hatten wir Sport, und ich habe beim Basketball zwei Körbe geworfen.\nAm Nachmittag war ich mit Lena in der Stadt und wir haben Eis gegessen.\nJetzt mache ich noch schnell meine Hausaufgaben für morgen.');
keep('one sentence per line, no final punct', 'Heute war ein langer Tag in der Schule und ich bin sehr müde\nIn Mathe haben wir eine Arbeit über Brüche geschrieben und sie war schwer\nDanach hatten wir Sport und ich habe beim Basketball zwei Körbe geworfen\nAm Nachmittag war ich mit Lena in der Stadt und wir haben Eis gegessen\nJetzt mache ich noch schnell meine Hausaufgaben für den nächsten Tag');
keep('one sentence per line, no punct, one lowercase start', 'Heute war ein langer Tag in der Schule und ich bin wirklich sehr müde\nin Mathe haben wir eine Arbeit über Brüche geschrieben und sie war schwer\nDanach hatten wir Sport und ich habe beim Basketball zwei Körbe geworfen\nAm Nachmittag war ich mit Lena in der Stadt und wir haben Eis gegessen\nJetzt mache ich noch schnell meine Hausaufgaben für den nächsten Tag');
keep('table of contents', 'Inhaltsverzeichnis\n1 Einleitung und Fragestellung der vorliegenden Arbeit ............ 3\n2 Stand der Forschung zu den Ursachen des Klimawandels ............ 7\n2.1 Natürliche Ursachen und ihre Bedeutung in der Vergangenheit ... 8\n2.2 Menschliche Einflüsse seit Beginn der Industrialisierung ....... 12\n3 Methoden der Datenerhebung und der statistischen Auswertung ...... 19');
keep('table of contents w/o dots', 'Einleitung und Fragestellung der vorliegenden Arbeit über den Wandel 3\nStand der Forschung zu den Ursachen des Klimawandels in Europa 7\nNatürliche Ursachen und ihre Bedeutung in der jüngeren Vergangenheit 8\nMenschliche Einflüsse seit dem Beginn der Industrialisierung 12\nMethoden der Datenerhebung und der statistischen Auswertung 19');
keep('code (js)', 'function sum(values) {\n  let total = 0;\n  for (const value of values) total += value * weightFor(value, options);\n  return total / Math.max(1, values.length) + offsetFromSettings(options);\n}\nconst result = sum([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);');
keep('code (python), no semicolons', 'def load_samples(path, limit=None):\n    with open(path, encoding="utf-8") as handle:\n        rows = [line.strip().split(",") for line in handle if line.strip()]\n    if limit is not None and limit < len(rows):\n        rows = rows[:limit]\n    return [dict(zip(header_names, row)) for row in rows]');
keep('CSV', 'name,street,city,zip,country,phone,email\nAnna Schmidt,Hauptstraße 5,Berlin,10115,Deutschland,030 1234567,anna@example.org\nBen Müller,Bahnhofstraße 12,Hamburg,20095,Deutschland,040 7654321,ben@example.org\ncarla weber,lindenweg 3,münchen,80331,deutschland,089 111222,carla@example.org\nDieter Koch,Am Markt 1,Köln,50667,Deutschland,0221 999888,dieter@example.org');
keep('TSV', 'Datum\tBeschreibung der Buchung\tBetrag\tKategorie\n01.03.2024\tMiete für die Wohnung in der Lindenstraße\t-850,00\tWohnen\n03.03.2024\teinkauf im supermarkt am bahnhof\t-63,20\tLebensmittel\n05.03.2024\tGehalt vom Arbeitgeber für den Monat Februar\t2.450,00\tEinkommen');
keep('list of URLs', 'https://www.example.org/artikel/2024/03/klimawandel-folgen-fuer-europa.html\nhttps://www.example.org/artikel/2024/04/energiewende-stand-der-dinge-in-deutschland.html\nhttps://www.example.com/blog/warum-wir-mehr-fahrrad-fahren-sollten-und-wie\nhttps://de.wikipedia.org/wiki/Erneuerbare_Energien_in_Deutschland_und_Europa');
keep('vocabulary list', 'das Haus - the house\ndie Straße - the street\nder Bahnhof - the railway station\ndas Fahrrad - the bicycle\nder Kühlschrank - the fridge\ndie Waschmaschine - the washing machine');
keep('vocabulary list long', 'die Waschmaschine - the washing machine, a machine that washes clothes\ndie Geschirrspülmaschine - the dishwasher, used in kitchens every day\ndas Bügeleisen - the iron, which makes clothes smooth after washing\nder Staubsauger - the vacuum cleaner, which cleans floors and carpets\nder Wäschetrockner - the tumble dryer, which dries clothes with hot air');
keep('chat log', '[10:02] Anna: bist du schon unterwegs oder sitzt du noch im Büro?\n[10:03] Ben: noch im büro, das meeting hat länger gedauert als gedacht, sorry\n[10:03] Anna: kein problem, ich warte im café gegenüber vom bahnhof auf dich\n[10:05] Ben: super, bin in etwa zwanzig minuten da, bestell mir schon mal einen kaffee');
keep('chat log, WhatsApp export', '12.03.24, 10:02 - Anna: bist du schon unterwegs oder sitzt du noch im Büro?\n12.03.24, 10:03 - Ben: noch im büro, das meeting hat länger gedauert als gedacht\n12.03.24, 10:03 - Anna: kein problem, ich warte im café gegenüber vom bahnhof\n12.03.24, 10:05 - Ben: super, bin in etwa zwanzig minuten da, bestell mir was');
keep('chat log, no brackets', 'Anna 10:02 bist du schon unterwegs oder sitzt du noch im Büro bei der Arbeit\nBen 10:03 noch im büro, das meeting hat länger gedauert als gedacht, sorry\nAnna 10:03 kein problem, ich warte im café gegenüber vom bahnhof auf dich\nBen 10:05 super, bin in etwa zwanzig minuten da, bestell mir schon einen kaffee');
keep('hand letter + one long paragraph', 'Liebe Oma,\n\nwie geht es dir?\nMir geht es gut.\nIch vermisse dich sehr.\n\nIn den Ferien waren wir an der Nordsee, und es war wunderschön, obwohl es fast jeden Tag geregnet hat und der Wind so stark war, dass wir kaum am Strand spazieren gehen konnten, aber abends haben wir in der Ferienwohnung Spiele gespielt und viel gelacht.\n\nViele Grüße\ndeine Lena');
keep('markdown one line per paragraph', '# Ausflug an den See\n\nAm Samstag sind wir früh losgefahren, weil das Wetter so schön war und wir den ganzen Tag draußen verbringen wollten.\n\nAm See haben wir zuerst gefrühstückt und sind dann mit dem Boot hinausgerudert, bis zur kleinen Insel in der Mitte.\n\nAm Abend waren alle müde, aber glücklich, und auf der Rückfahrt im Auto sind die Kinder sofort eingeschlafen.');
keep('shopping list long items lowercase', 'zwei Packungen Milch, aber bitte die fettarme aus dem Kühlregal hinten\nein großes Brot vom Bäcker, am besten das dunkle mit den Körnern drauf\nKäse für das Wochenende, Gouda und vielleicht noch einen Camembert\nsechs Eier aus Freilandhaltung und eine Packung Butter, die gesalzene');
keep('to-do lines w/o bullets (mixed case)', 'Steuererklärung für das letzte Jahr fertig machen und an den Berater schicken\nbeim Vermieter wegen der kaputten Heizung im Bad anrufen und Termin machen\nGeschenk für Papas Geburtstag besorgen, er wünscht sich ein Buch über Segeln\nAnmeldung für den Schwimmkurs der Kinder ausfüllen und bis Freitag abgeben');
keep('haiku-like / short sentences w/o punct', 'der Regen fällt leise\nauf das Dach des alten Hauses\nund niemand hört zu');
keep('Gedicht mit Strophen, Länge ~45-60', 'Es war einmal ein Mann, der wohnte ganz allein im Wald\nund hatte keine Freunde, denn sein Herz war hart und kalt\ner sprach mit keinem Menschen und er grüßte keinen Gast\nund trug an seinem Rücken eine schwere, schwere Last\n\nDoch eines Tages kam ein Kind vorbei an seiner Tür\nund fragte ihn ganz freundlich: Darf ich bleiben hier bei dir?\nda wurde ihm ganz warm ums Herz, er wusste nicht wie ihm geschah\nund plötzlich war die Welt nicht mehr so dunkel wie sie war');
keep('Gedicht ohne Satzzeichen, Länge 50-70, Kleinschreibung', 'ich gehe durch die straßen dieser stadt die mir so fremd geworden ist\nund suche nach den spuren meiner kindheit zwischen grauen mauern hier\ndie bäckerei an der ecke gibt es nicht mehr und auch nicht den alten laden\nwo wir als kinder süßigkeiten kauften für ein paar pfennig nach der schule');
keep('Liedtext Refrain lang', 'Und wir tanzen durch die Nacht, bis der Morgen langsam kommt\nund die Sterne gehen aus, einer nach dem anderen am Horizont\nwir sind jung und wir sind frei, und die Welt gehört nur uns allein\nund so soll es immer sein, und so soll es immer, immer sein');
keep('list of names with roles', 'Dr. Petra Hoffmann, Vorsitzende des Ausschusses für Umwelt und Verkehr\nMarkus Lehmann, stellvertretender Vorsitzender und Sprecher der Fraktion\nSabine Wolf, Schriftführerin, zuständig für das Protokoll der Sitzungen\nJonas Becker, beratendes Mitglied ohne Stimmrecht aus dem Jugendrat');
keep('timetable', 'Mo 08:00 Mathematik bei Frau Schulz im Raum 204, bitte Taschenrechner mitbringen\nMo 09:45 Deutsch bei Herrn Krüger, wir lesen weiter im Buch ab Kapitel drei\nDi 08:00 Englisch bei Frau Wagner, Vokabeltest über die Unit fünf und sechs\nDi 09:45 sport in der großen halle, bitte turnschuhe und handtuch mitbringen');
keep('bulleted with unicode bullets', '• Die Dämmung der Außenwände senkte den Heizbedarf im Mittel um ein Drittel\n• neue Fenster brachten weniger als erwartet, weil viele schon gut waren\n• das Dach zu dämmen lohnt sich fast immer und ist auch sehr günstig\n• eine neue Heizung ist teuer, spart aber auf lange Sicht am meisten');
keep('en-dash bullets', '– Die Dämmung der Außenwände senkte den Heizbedarf im Mittel um ein Drittel\n– neue Fenster brachten weniger als erwartet, weil viele schon gut waren\n– das Dach zu dämmen lohnt sich fast immer und ist auch sehr günstig\n– eine neue Heizung ist teuer, spart aber auf lange Sicht am meisten');
keep('numbered with "1 " no dot', '1 Die Dämmung der Außenwände senkte den Heizbedarf im Mittel um ein Drittel\n2 neue Fenster brachten weniger als erwartet, weil viele schon gut waren\n3 das Dach zu dämmen lohnt sich fast immer und ist auch sehr günstig\n4 eine neue Heizung ist teuer, spart aber auf lange Sicht am meisten');
keep('Roman numerals / letters with dot', 'I. Die Dämmung der Außenwände senkte den Heizbedarf im Mittel um ein Drittel\nII. neue Fenster brachten weniger als erwartet, weil viele schon gut waren\nIII. das Dach zu dämmen lohnt sich fast immer und ist auch sehr günstig\nIV. eine neue Heizung ist teuer, spart aber auf lange Sicht am meisten');
keep('Markdown hard break with backslash lines', 'Erste Zeile, die ich absichtlich so geschrieben habe und hier umbreche\\\nzweite Zeile, die ebenfalls absichtlich so bleiben soll wie sie ist\\\ndritte Zeile, die ebenfalls absichtlich so bleiben soll, wie sie ist\\\nvierte Zeile und Schluss.');
// three lines: too few to tell, so they stay whatever they look like
keep('three lines: address long, no title', 'Stadtverwaltung Musterstadt, Abteilung für Stadtentwicklung und Planung\nund Bauleitplanung, Rathaus Musterstadt, Zimmer 214 im zweiten Stock links\nHauptstraße 1, 12345 Musterstadt');
keep('three lines: poem 3 lines, last ends "."', 'Und wir tanzen durch die Nacht, bis der Morgen langsam kommt\nund die Sterne gehen aus, einer nach dem anderen am Horizont\nwir sind jung und wir sind frei, und die Welt gehört nur uns allein.');
keep('three lines: poem 3 lines no punct', 'Und wir tanzen durch die Nacht, bis der Morgen langsam kommt\nund die Sterne gehen aus, einer nach dem anderen am Horizont\nwir sind jung und wir sind frei, und die Welt gehört nur uns allein');
keep('three lines: notes 3, last "."', 'Termin beim Zahnarzt am Donnerstag um halb neun, Karte mitnehmen\nmorgen Oma anrufen wegen der Feier am Wochenende und Kuchen bestellen\nAuto muss im März zum TÜV, vorher noch die Bremsen prüfen lassen.');
keep('three lines: notes 3 no punct', 'Termin beim Zahnarzt am Donnerstag um halb neun, Karte mitnehmen\nmorgen Oma anrufen wegen der Feier am Wochenende und Kuchen bestellen\nAuto muss im März zum TÜV, vorher noch die Bremsen prüfen lassen');
keep('three lines: sentence a line 3', 'Heute war ein langer Tag in der Schule und ich bin wirklich sehr müde.\nin Mathe haben wir eine Arbeit über Brüche geschrieben und sie war schwer\nDanach hatten wir Sport und ich habe beim Basketball zwei Körbe geworfen.');
keep('three lines: to-do 3 lowercase', 'beim Vermieter wegen der kaputten Heizung im Bad anrufen und Termin machen\nGeschenk für Papas Geburtstag besorgen, er wünscht sich ein Buch über Segeln\nanmeldung für den Schwimmkurs der Kinder ausfüllen und bis Freitag abgeben.');
keep('three lines: greeting body sig', 'Liebe Anna, lieber Ben, liebe Kinder und alle anderen im ganzen Haus,\nwir wünschen euch frohe Weihnachten und ein gutes neues Jahr 2025!\nEure Großeltern aus Tübingen, die sich schon auf euren Besuch freuen');
keep('three lines: lyrics 3 w/ mid end', 'Wir fahren übers Land. Und singen laut die alten Lieder mit\ndie Fenster offen, der Wind in den Haaren, und keiner sagt ein Wort\nund irgendwo da vorne wartet schon der Sommer auf uns zwei');
keep('three lines: chat 3', '[10:02] Anna: bist du schon unterwegs oder sitzt du noch im Büro? Sag mal\n[10:03] Ben: noch im büro, das meeting hat länger gedauert als gedacht\n[10:04] Anna: ok, ich warte im café gegenüber vom bahnhof auf dich.');
keep('three lines: code 3', 'const total = values.reduce((sum, value) => sum + value * weight, 0);\nconsole.log(total / values.length, "ist der Mittelwert. Fertig");\nreturn total;');
keep('three lines: signature 3', 'Dr. Thomas Becker, Leiter der Abteilung Bauordnung und Denkmalschutz\nStadtverwaltung Musterstadt, Rathausplatz 1, 12345 Musterstadt am Rhein\nTel. 0711 123456, E-Mail thomas.becker@musterstadt.example.org');
keep('three-line address with long lines', 'Herrn Dr. Maximilian Mustermann-Schmidt, Abteilung für Stadtentwicklung\nund Bauleitplanung, Rathaus Musterstadt, Zimmer 214 im zweiten Stock links\nHauptstraße 1, 12345 Musterstadt');
keep('quoted poem', '> Der Mond ist aufgegangen,\n> Die goldnen Sternlein prangen\n> Am Himmel hell und klar.\n> Der Wald steht schwarz und schweiget,\n> Und aus den Wiesen steiget\n> Der weiße Nebel wunderbar.');
keep('quoted long-line lyrics', '> Und wir tanzen durch die Nacht, bis der Morgen langsam kommt\n> und die Sterne gehen aus, einer nach dem anderen am Horizont\n> wir sind jung und wir sind frei, und die Welt gehört nur uns allein\n> und so soll es immer sein, und so soll es immer, immer sein');
keep('numbered list typed one a line', '1. Die Dämmung der Außenwände senkte den Heizbedarf im Mittel um ein Drittel\n2. neue Fenster brachten weniger als erwartet, weil viele schon gut waren\n3. das Dach zu dämmen lohnt sich fast immer und ist auch sehr günstig\n4. eine neue Heizung ist teuer, spart aber auf lange Sicht am meisten');
keep('signature block', 'Mit freundlichen Grüßen aus dem Rathaus und bis zur nächsten Sitzung\nDr. Thomas Becker, Leiter der Abteilung Bauordnung und Denkmalschutz\nStadtverwaltung Musterstadt, Rathausplatz 1, 12345 Musterstadt am Rhein\nTel. 0711 123456, E-Mail thomas.becker@musterstadt.example.org');
keep('headings one a line', 'Einleitung und Fragestellung der vorliegenden Arbeit über den Wandel\nStand der Forschung zu den Ursachen des Klimawandels in ganz Europa\nNatürliche Ursachen und ihre Bedeutung in der jüngeren Vergangenheit\nMenschliche Einflüsse seit dem Beginn der Industrialisierung bis heute');
keep('dialogue with dashes', '– Kommst du heute Abend noch mit ins Kino, oder musst du wieder arbeiten?\n– Ich weiß noch nicht genau, das hängt davon ab, wann ich hier fertig werde.\n– Der Film fängt erst um neun an, das solltest du doch schaffen können.\n– Gut, dann sag ich dir spätestens um sieben Bescheid, ob es klappt.');
// verse of 35 to 46 characters a line, where 0.8 of the column is passed by most lines
keep('Rilke, Der Panther', 'Der Panther\nIm Jardin des Plantes, Paris\n\nSein Blick ist vom Vorübergehn der Stäbe\nso müd geworden, daß er nichts mehr hält.\nIhm ist, als ob es tausend Stäbe gäbe\nund hinter tausend Stäben keine Welt.\n\nDer weiche Gang geschmeidig starker Schritte,\nder sich im allerkleinsten Kreise dreht,\nist wie ein Tanz von Kraft um eine Mitte,\nin der betäubt ein großer Wille steht.\n\nNur manchmal schiebt der Vorhang der Pupille\nsich lautlos auf –. Dann geht ein Bild hinein,\ngeht durch der Glieder angespannte Stille –\nund hört im Herzen auf zu sein.\n\nRainer Maria Rilke');
keep('Rilke, Der Panther, without stanza breaks', 'Sein Blick ist vom Vorübergehn der Stäbe\nso müd geworden, daß er nichts mehr hält.\nIhm ist, als ob es tausend Stäbe gäbe\nund hinter tausend Stäben keine Welt.\nDer weiche Gang geschmeidig starker Schritte,\nder sich im allerkleinsten Kreise dreht,\nist wie ein Tanz von Kraft um eine Mitte,\nin der betäubt ein großer Wille steht.');
keep('Rilke, Herbsttag', 'Herbsttag\n\nHerr: es ist Zeit. Der Sommer war sehr groß.\nLeg deinen Schatten auf die Sonnenuhren,\nund auf den Fluren laß die Winde los.\n\nBefiehl den letzten Früchten voll zu sein;\ngieb ihnen noch zwei südlichere Tage,\ndränge sie zur Vollendung hin und jage\ndie letzte Süße in den schweren Wein.\n\nWer jetzt kein Haus hat, baut sich keines mehr.\nWer jetzt allein ist, wird es lange bleiben,\nwird wachen, lesen, lange Briefe schreiben\nund wird in den Alleen hin und her\nunruhig wandern, wenn die Blätter treiben.');
keep('Rilke, Archaïscher Torso Apollos', 'Wir kannten nicht sein unerhörtes Haupt,\ndarin die Augenäpfel reiften. Aber\nsein Torso glüht noch wie ein Kandelaber,\nin dem sein Schauen, nur zurückgeschraubt,\n\nsich hält und glänzt. Sonst könnte nicht der Bug\nder Brust dich blenden, und im leisen Drehen\nder Lenden könnte nicht ein Lächeln gehen\nzu jener Mitte, die die Zeugung trug.');
keep('Hamlet, lower-case edition', "To be, or not to be, that is the question:\nwhether 'tis nobler in the mind to suffer\nthe slings and arrows of outrageous fortune,\nor to take arms against a sea of troubles\nand by opposing end them. To die, to sleep,\nno more; and by a sleep to say we end\nthe heart-ache and the thousand natural shocks\nthat flesh is heir to.");
keep('Whitman, Song of Myself', "I celebrate myself, and sing myself,\nAnd what I assume you shall assume,\nFor every atom belonging to me as good belongs to you.\n\nI loafe and invite my soul,\nI lean and loafe at my ease observing a spear of summer grass.\n\nMy tongue, every atom of my blood, form'd from this soil, this air,\nBorn here of parents born here from parents the same, and their parents the same,\nI, now thirty-seven years old in perfect health begin,\nHoping to cease not till death.");
// a dot that ends no sentence: one letter ("z. Hd.") and dot leaders
keep('address with "z. Hd."', 'Stadtverwaltung Musterstadt, Amt für öffentliche Ordnung und Bürgerdienste\nAbteilung Gewerbeangelegenheiten, Sachgebiet Gaststättenerlaubnisse\nz. Hd. Frau Sabine Krüger-Wellershoff, Zimmer 214 im Neuen Rathaus\nMarktplatz 1, 54321 Musterstadt');
keep('contents with dot leaders', 'Vorwort ........................................................... 5\nErstes Kapitel: Die Kindheit in der kleinen Stadt am Fluss ......... 9\nZweites Kapitel: Die Jahre in der Fremde und die Rückkehr .......... 47\nDrittes Kapitel: Der Brand und was danach geschah .................. 93');
// a chat: "Name: " with or without a time in front
const chat = '[18:02] Lisa: bin gleich da, stehe noch im stau auf der autobahn kurz vor der ausfahrt\n[18:03] Max: kein problem, wir haben eh noch nicht bestellt und warten auf dich\n[18:05] Lisa: okay super, bestellt mir schon mal eine große apfelschorle bitte\n[18:05] Max: mach ich, und die vorspeise für alle oder lieber jeder einzeln?';
keep('chat [18:02] Name:', chat);
keep('chat 18:02 Name:', chat.replace(/\[(\d\d:\d\d)\]/gu, '$1'));
keep('chat Name:', chat.replace(/\[\d\d:\d\d\] /gu, ''));
keep('speech salutation', 'Liebe Kolleginnen und Kollegen aus dem Vertrieb, dem Marketing und der Buchhaltung,\nliebe Freundinnen und Freunde unseres Hauses, die heute ebenfalls dabei sind,\nsehr geehrte Gäste aus Politik und Verwaltung,\nich begrüße Sie herzlich zu unserem Jubiläum.');
// alone these stay; beside a wrapped paragraph they are joined (ADJACENT_EXCEPT)
keep('Psalm 23, a verse over two lines', 'Der Herr ist mein Hirte, mir wird nichts mangeln.\nEr weidet mich auf einer grünen Aue und führet mich zum frischen Wasser.\nEr erquicket meine Seele. Er führet mich auf rechter Straße um seines Namens willen.\nUnd ob ich schon wanderte im finstern Tal, fürchte ich kein Unglück; denn du bist bei mir,\ndein Stecken und Stab trösten mich.\nDu bereitest vor mir einen Tisch im Angesicht meiner Feinde.');
keep('a quote over two lines and its source', '"The only thing we have to fear is fear itself, nameless, unreasoning, unjustified terror\nwhich paralyzes needed efforts to convert retreat into advance."\nFranklin D. Roosevelt, first inaugural address, 4 March 1933');

// 1b. Each text of DELIBERATE above and below a wrapped paragraph, an empty line between:
// it must come out unchanged there too, but for these (name: how many of the placements
// lose a break, why).
const SHORT_BLOCK = 'three lines of a column\'s length are judged like a short wrapped paragraph once the paragraph beside them makes the text count as wrapped; holding short blocks back left 1,453 of the 38,756 copied breaks of the random documents in the test instead of 536';
export const ADJACENT_EXCEPT = {
  'three lines: poem 3 lines, last ends "."': { lost: 10, why: SHORT_BLOCK },
  'three lines: notes 3, last "."': { lost: 12, why: SHORT_BLOCK },
  'three lines: sentence a line 3': { lost: 12, why: SHORT_BLOCK },
  'three lines: to-do 3 lowercase': { lost: 12, why: SHORT_BLOCK },
  'three lines: lyrics 3 w/ mid end': { lost: 8, why: SHORT_BLOCK },
  'three lines: code 3': { lost: 12, why: SHORT_BLOCK },
  'Rilke, Der Panther': { lost: 2, why: 'beside a paragraph wrapped at 60, a verse line of 44 before "sich" passes 0.8 of the column, and "auf –. Dann" is a sentence end inside a line' },
  'Rilke, Archaïscher Torso Apollos': { lost: 4, why: 'the same at 60: lines of 40 to 48 before a short word, "glänzt. Sonst" inside' },
  'Whitman, Song of Myself': { lost: 4, why: 'lines of 55 to 81 characters at a column of 72 are all full' },
  'Psalm 23, a verse over two lines': { lost: 8, why: '"bei mir," before "dein" is a full line before a small letter: a wrapped line looks the same' },
  'a quote over two lines and its source': { lost: 8, why: 'the same: "terror" before "which"' },
};

// Typed on purpose, and still joined: a run of long lines without a sentence end inside
// and with one at its end looks exactly like one wrapped sentence.
export const STILL_JOINED = [
  { name: 'poem stanza ending with "."', text: 'Und wir tanzen durch die Nacht, bis der Morgen langsam kommt\nund die Sterne gehen aus, einer nach dem anderen am Horizont\nwir sind jung und wir sind frei, und die Welt gehört nur uns allein\nund so soll es immer sein, und so soll es immer, immer sein.', why: 'four long lines and one sentence end, at the end: one wrapped sentence looks the same' },
  { name: 'to-do lines ending with "."', text: 'Steuererklärung für das letzte Jahr fertig machen und an den Berater schicken\nbeim Vermieter wegen der kaputten Heizung im Bad anrufen und Termin machen\nGeschenk für Papas Geburtstag besorgen, er wünscht sich ein Buch über Segeln\nAnmeldung für den Schwimmkurs der Kinder ausfüllen und bis Freitag abgeben.', why: 'the same: a full stop only at the end' },
  { name: 'poem with a sentence end inside a line', text: 'Sein Blick ist vom Vorübergehn der Stäbe so müd geworden. Er hält nichts mehr\nund ihm ist, als ob es tausend Stäbe gäbe und hinter tausend Stäben keine Welt\nder weiche Gang geschmeidig starker Schritte, der sich im allerkleinsten Kreise dreht\nist wie ein Tanz von Kraft um eine Mitte, in der betäubt ein großer Wille steht', why: 'a sentence end inside a line is the evidence of running text' },
  { name: 'free verse in small letters', text: 'wir haben die fenster geöffnet und die kälte\nkam herein wie ein gast der zu früh ist und\nnicht weiß wohin mit seinen händen, wir saßen\nam tisch und schwiegen, draußen fuhr ein zug\nvorbei, und niemand von uns stand auf.', why: 'every line is full at a column of 46 and the last one ends a sentence: a paragraph wrapped at 46 is the same' },
];

// 2. Texts copied with the breaks of their source column: orig is the text as written,
// src as copied; every added break must go and every break of orig stay, or expect is
// the exact text that must come out.
export const FLOWING = [];
const add = (name, orig, src, expect) => FLOWING.push({ name, orig, src: src ?? orig, expect });
const flow = (c) => FLOWING.push({ ...c, expect: c.expectText });

const DE1 = 'Die Stadt liegt an einem breiten Fluss, der im Frühjahr oft über die Ufer tritt und die tiefer gelegenen Wiesen überschwemmt. Seit dem Mittelalter haben die Bewohner gelernt, mit dem Wasser zu leben, und ihre Häuser auf kleinen Hügeln gebaut. Heute schützen Deiche und Rückhaltebecken die meisten Viertel, doch bei starkem Regen steigt der Pegel noch immer bedrohlich an.';
const DE2 = 'Im Sommer kommen viele Touristen, die mit dem Fahrrad entlang des Flusses fahren und in den kleinen Gasthöfen übernachten. Die Gemeinde hat deshalb neue Radwege angelegt, Bänke aufgestellt und an mehreren Stellen Tafeln angebracht, die von der Geschichte der Gegend erzählen.';
const DE3 = 'Wer länger bleibt, sollte das Museum am Marktplatz besuchen, in dem alte Karten, Werkzeuge und Fotografien zeigen, wie sich das Leben am Fluss in den letzten zweihundert Jahren verändert hat.';
const EN1 = 'The committee met on Tuesday to discuss the proposed changes to the budget, which had been circulated to all members a week earlier. Several speakers raised concerns about the cuts to the library service, arguing that they would fall hardest on families who could not afford to buy books of their own.';
const EN2 = 'After a long debate the chair proposed a compromise: the cuts would be phased in over three years instead of one, and the savings would be reviewed every six months by a working group drawn from all parties.';
const DE = [DE1, DE2, DE3].join('\n\n'), EN = [EN1, EN2].join('\n\n');

for (const w of [60, 66, 72, 78, 80]) { add(`DE greedy ${w}`, DE, wrap(DE, w)); add(`EN greedy ${w}`, EN, wrap(EN, w)); }
for (const w of [50, 60, 70, 80]) { add(`DE prop ${w}`, DE, prop(DE, w)); add(`EN prop ${w}`, EN, prop(EN, w)); }
// single line breaks between paragraphs
add('DE paras single \\n, 72', DE.replace(/\n\n/g, '\n'), wrap(DE.replace(/\n\n/g, '\n'), 72));
add('EN paras single \\n, 72', EN.replace(/\n\n/g, '\n'), wrap(EN.replace(/\n\n/g, '\n'), 72));
// single paragraph of N lines
const words = DE1.split(' ');
for (const n of [3, 4, 5, 8]) {
  // pick a prefix of DE1 that wraps to exactly n lines at 72
  let k = 1; while (wrap(words.slice(0, k).join(' '), 72).split('\n').length < n && k < words.length) k++;
  let t = words.slice(0, k).join(' ');
  while (wrap(t + ' ' + words[k], 72).split('\n').length === n && k < words.length) t += ' ' + words[k++];
  if (n === 8) t = (DE1 + ' ' + DE2).split(' ').slice(0, 85).join(' ');
  add(`single paragraph ${wrap(t, 72).split('\n').length} lines`, t, wrap(t, 72));
}
// e-mail
const mailBody = 'vielen Dank für Ihre Nachricht vom Montag. Wir haben die Unterlagen geprüft und können Ihnen mitteilen, dass der Antrag vollständig ist und in der nächsten Sitzung des Ausschusses behandelt wird. Über das Ergebnis informieren wir Sie schriftlich.';
const mailBody2 = 'Sollten Sie bis dahin noch Fragen haben, erreichen Sie mich am besten vormittags unter der unten angegebenen Telefonnummer oder per E-Mail.';
const mailO = `Sehr geehrte Frau Müller,\n\n${mailBody}\n\n${mailBody2}\n\nMit freundlichen Grüßen\nThomas Becker\nSachbearbeitung Bauamt\nTel. 0711 123456`;
add('e-mail 72', mailO, `Sehr geehrte Frau Müller,\n\n${wrap(mailBody, 72)}\n\n${wrap(mailBody2, 72)}\n\nMit freundlichen Grüßen\nThomas Becker\nSachbearbeitung Bauamt\nTel. 0711 123456`);
add('e-mail 72 no blank before sig', mailO.replace('\n\nMit', '\nMit'), `Sehr geehrte Frau Müller,\n\n${wrap(mailBody, 72)}\n\n${wrap(mailBody2, 72)}\nMit freundlichen Grüßen\nThomas Becker\nSachbearbeitung Bauamt\nTel. 0711 123456`);
add('e-mail short (one wrapped para of 3 lines)', `Hallo Jan,\n\n${mailBody2}\n\nGruß\nTim`, `Hallo Jan,\n\n${wrap(mailBody2, 60)}\n\nGruß\nTim`);
// quoted e-mail ("> " on every line)
const qO = `Am 3. Mai schrieb Anna:\n> ${DE1}\n\nDas sehe ich genauso. ${DE3}`;
add('quoted e-mail', qO, `Am 3. Mai schrieb Anna:\n${wrapPrefix(DE1, 72, '> ')}\n\n${wrap('Das sehe ich genauso. ' + DE3, 72)}`);
// hyphenated line ends
const hyO = 'Die Gleichberechtigung von Frauen und Männern ist im Grundgesetz verankert, doch in der Praxis gibt es noch immer große Unterschiede bei Löhnen, Renten und der Verteilung der unbezahlten Arbeit in der Familie und im Haushalt.';
const hyW = 'Die Gleich-\nberechtigung von Frauen und Männern ist im Grundgesetz veran-\nkert, doch in der Praxis gibt es noch immer große Unterschiede bei\nLöhnen, Renten und der Verteilung der unbezahlten Arbeit in der Fa-\nmilie und im Haushalt.';
flow({ name: 'hyphenated line ends', orig: null, src: hyW, expectText: hyO });
// legal text with § at line starts
const leg = '(1) Der Vermieter kann die Zustimmung zu einer Erhöhung der Miete bis zur ortsüblichen Vergleichsmiete verlangen, wenn die Miete in dem Zeitpunkt, zu dem die Erhöhung eintreten soll, seit 15 Monaten unverändert ist; dies gilt nach § 558 Abs. 2 und Art. 5 Nr. 3 der Verordnung entsprechend, soweit nicht § 3 Abs. 2 etwas anderes bestimmt.\n(2) Die ortsübliche Vergleichsmiete wird gebildet aus den üblichen Entgelten, die in der Gemeinde oder einer vergleichbaren Gemeinde für Wohnraum vergleichbarer Art, Größe, Ausstattung, Beschaffenheit und Lage in den letzten sechs Jahren vereinbart oder geändert worden sind.';
for (const w of [60, 66, 70, 72]) add(`legal § text ${w}`, leg, wrap(leg, w));
// line starting with "§ 3" forced
const legF = 'Die Frist beginnt mit dem Zugang der Erklärung beim Empfänger und richtet sich im Übrigen nach\n§ 3 Abs. 2 dieses Gesetzes, wobei die Vorschriften des Bürgerlichen Gesetzbuches über die\nBerechnung von Fristen und Terminen entsprechend anzuwenden sind, soweit hier nichts anderes\ngeregelt ist und auch keine abweichende Vereinbarung zwischen den Parteien getroffen wurde.';
flow({ name: 'line starting "§ 3 Abs. 2"', orig: legF.replace(/\n/g, ' '), src: legF });
// numbers/dates at line starts
const dat = 'Nach dem Fall der Mauer im November 1989 dauerte es noch fast ein Jahr, bis am\n3. Oktober 1990 die Wiedervereinigung offiziell vollzogen wurde und die beiden Staaten\nwieder ein gemeinsames Land bildeten. Viele Menschen erinnern sich noch heute an diesen\nTag, an dem in Berlin und anderen Städten gefeiert wurde, bis tief in die Nacht hinein.';
flow({ name: 'line starting "3. Oktober 1990"', orig: dat.replace(/\n/g, ' '), src: dat });
const dat2 = 'Die Zahl der Besucher ist in den letzten Jahren stetig gestiegen. Im Jahr\n2024 wurde erstmals die Marke von einer Million überschritten, und die Stadt\nrechnet damit, dass sich dieser Trend auch in den kommenden Jahren noch weiter\nfortsetzen wird, sofern die Verkehrsanbindung wie geplant verbessert wird.';
flow({ name: 'line starting "2024 wurde"', orig: dat2.replace(/\n/g, ' '), src: dat2 });
const dat3 = 'Die Sitzung wurde um 18 Uhr eröffnet. Anwesend waren insgesamt\n12 Mitglieder des Rates sowie drei Gäste aus der Nachbargemeinde, die\n2. Vorsitzende leitete die Sitzung, weil der erste Vorsitzende krank war\nund sich kurzfristig entschuldigt hatte, wie aus dem Protokoll hervorgeht.';
flow({ name: 'line starting "2. Vorsitzende" (enumerator look-alike)', orig: dat3.replace(/\n/g, ' '), src: dat3 });
const enumf = 'Für die Anmeldung brauchen Sie Ihren Personalausweis, eine Meldebescheinigung, die nicht älter als\ndrei Monate ist, ein aktuelles Passfoto, den ausgefüllten Antrag sowie den Nachweis über die bezahlte\nGebühr, die Sie entweder bar oder mit Karte an der Kasse im Erdgeschoss entrichten können, bevor\nSie zur Sachbearbeitung im zweiten Stock gehen und dort eine Wartenummer ziehen.';
flow({ name: 'bullet-free enumeration in prose (100 col)', orig: enumf.replace(/\n/g, ' '), src: enumf });
// AI-style hard-wrapped markdown
const md = [
  '## Zusammenfassung',
  '',
  wrap('Die Untersuchung zeigt, dass die Maßnahmen zur Senkung des Energieverbrauchs in den meisten Gebäuden erfolgreich waren und sich bereits nach wenigen Jahren bezahlt gemacht haben.', 72),
  '',
  '- ' + wrap('Die Dämmung der Außenwände senkte den Heizbedarf im Mittel um ein Drittel, in Altbauten sogar um fast die Hälfte.', 70).split('\n').join('\n  '),
  '- ' + wrap('Neue Fenster brachten weniger als erwartet, weil viele der alten bereits doppelt verglast waren und gut schlossen.', 70).split('\n').join('\n  '),
  '',
  '1. ' + wrap('Zuerst sollten die Dächer gedämmt werden, denn dort geht die meiste Wärme verloren und die Kosten sind gering.', 69).split('\n').join('\n   '),
  '2. ' + wrap('Danach folgen die Außenwände, sofern der Denkmalschutz das zulässt und die Eigentümer zustimmen.', 69).split('\n').join('\n   '),
  '',
  wrapPrefix('Wichtig: Jede Maßnahme muss vorher mit dem Energieberater abgestimmt werden, sonst entfällt die Förderung durch den Bund vollständig.', 72, '> '),
  '',
  '| Maßnahme | Ersparnis |',
  '|---|---|',
  '| Dach | 25 % |',
  '',
  '```',
  'ergebnis = verbrauch * 0.75',
  'print(ergebnis)',
  '```',
].join('\n');
const mdO = [
  '## Zusammenfassung', '',
  'Die Untersuchung zeigt, dass die Maßnahmen zur Senkung des Energieverbrauchs in den meisten Gebäuden erfolgreich waren und sich bereits nach wenigen Jahren bezahlt gemacht haben.', '',
  '- Die Dämmung der Außenwände senkte den Heizbedarf im Mittel um ein Drittel, in Altbauten sogar um fast die Hälfte.',
  '- Neue Fenster brachten weniger als erwartet, weil viele der alten bereits doppelt verglast waren und gut schlossen.', '',
  '1. Zuerst sollten die Dächer gedämmt werden, denn dort geht die meiste Wärme verloren und die Kosten sind gering.',
  '2. Danach folgen die Außenwände, sofern der Denkmalschutz das zulässt und die Eigentümer zustimmen.', '',
  '> Wichtig: Jede Maßnahme muss vorher mit dem Energieberater abgestimmt werden, sonst entfällt die Förderung durch den Bund vollständig.', '',
  '| Maßnahme | Ersparnis |', '|---|---|', '| Dach | 25 % |', '', '```', 'ergebnis = verbrauch * 0.75', 'print(ergebnis)', '```'].join('\n');
add('AI hard-wrapped markdown', mdO, md);
// trailing spaces / tabs
const tsW = wrap(DE, 72).split('\n').map((l, i) => l + (i % 3 === 0 ? ' ' : i % 3 === 1 ? '\t' : '')).join('\n');
add('trailing single space / tab', DE, tsW);
// nbsp
const nb = DE.replace(/ (\d+|Mittelalter)/g, ' $1').replace(/z\. B\./g, 'z. B.');
add('nbsp inside', nb, wrap(nb, 72));
// emoji + combining
const em = DE1.replace('Fluss', 'Fluss 🌊').replace('Häuser', 'Häuser').replace('Deiche', 'Deiche 👩‍👩‍👧').replace('Regen', 'Regen ☔️');
add('emoji and combining', em, wrap(em, 72));
// web page at 70 with link line
// PDF two-column narrow (45)
add('DE greedy 45 (narrow PDF column)', DE, wrap(DE, 45));
add('DE greedy 42', DE, wrap(DE, 42));
add('DE greedy 38 (narrower than MIN_WIDTH)', DE, wrap(DE, 38));
// title-case-heavy German: nouns at line starts. Choose text where no line after a full one starts lowercase? Hard; test random wraps.
// short paragraph text: 3 paragraphs each 2 lines
const two = ['Die Bahn fährt heute wegen Bauarbeiten nur bis zum Hauptbahnhof, dort steht ein Ersatzbus bereit.', 'Bitte planen Sie für die Weiterfahrt zum Flughafen etwa dreißig Minuten mehr Zeit ein als sonst üblich.', 'Fahrräder können im Ersatzbus leider nicht mitgenommen werden, Kinderwagen dagegen schon.'].join('\n\n');
add('three paragraphs of 2 lines each, 72', two, wrap(two, 72));
add('two paragraphs of 2 lines each, 72', two.split('\n\n').slice(0, 2).join('\n\n'), wrap(two.split('\n\n').slice(0, 2).join('\n\n'), 72));
// an English one too; a hyphen behind one letter is the word's own ("e-mail": hyphenation
// never leaves one letter), one behind more letters goes ("well-known": "wellknown", a known flaw)
add('hyphenated line ends, English', undefined, ['The committee agreed that the cuts would be phased in over three years and re-', 'viewed every six months by a working group, and the chair promised to send an e-', 'mail with the minutes to every member of the committee before the next meeting', 'on Tuesday, together with the figures from the library service.'].join('\n'), 'The committee agreed that the cuts would be phased in over three years and reviewed every six months by a working group, and the chair promised to send an e-mail with the minutes to every member of the committee before the next meeting on Tuesday, together with the figures from the library service.');
// a German PDF splits words at its line ends: the hyphen goes, except before a link word
// ("Haus- und Gartenanlagen") and where the word has one of its own ("E-Mail", "US-...")
add('hyphenated line ends of a PDF', undefined, ['Im Ausschuss wurden gestern die Kosten für die Pflege der Haus-', 'und Gartenanlagen lange besprochen, und die Antwort auf die E-', 'Mail des Vereins ging erst am Freitag hinaus. Eine US-', 'amerikanische Studie zur Gleichberechtigung von Frauen und Män-', 'nern im Beruf lag den Mitgliedern dabei schon vor, doch eine', 'Entscheidung fiel noch nicht.'].join('\n'), 'Im Ausschuss wurden gestern die Kosten für die Pflege der Haus- und Gartenanlagen lange besprochen, und die Antwort auf die E-Mail des Vereins ging erst am Freitag hinaus. Eine US-amerikanische Studie zur Gleichberechtigung von Frauen und Männern im Beruf lag den Mitgliedern dabei schon vor, doch eine Entscheidung fiel noch nicht.');
{
  const items = ['- Die Dämmung der Außenwände senkte den Heizbedarf im Mittel um ein Drittel, in Altbauten sogar um fast die Hälfte', '- Neue Fenster brachten weniger als erwartet, weil viele der alten bereits doppelt verglast waren', '- Das Dach zu dämmen lohnt sich fast immer, weil dort die meiste Wärme verloren geht'];
  add('wrapped list items without full stops are whole again', items.join('\n'), items.map((i) => wrap(i, 66)).join('\n'));
}
for (const c of FLOWING) if (c.expect) c.orig = undefined;

// Still not joined, with the reason.  missed: added breaks that stay; destroyed: breaks of
// orig that go.
export const FLOWING_EXCEPT = {
  'DE paras single \\n, 72': { missed: 0, destroyed: 1, why: 'a paragraph whose last line is full and ends a sentence, before one whose first line goes on, looks like a sentence end inside wrapped text' },
  'single paragraph 3 lines': { missed: 2, destroyed: 0, why: 'two full lines are fewer than MIN_JOINS: three lines typed so look the same' },
  'e-mail short (one wrapped para of 3 lines)': { missed: 2, destroyed: 0, why: 'the same: one paragraph of three lines' },
  'two paragraphs of 2 lines each, 72': { missed: 2, destroyed: 0, why: 'the same: two full lines' },
};

// 3. Documents of both: their own breaks stay, the copied paragraphs flow.
export const MIXED = [];
const mix = (name, pieces) => MIXED.push({ name, orig: pieces.map((p) => (typeof p === 'string' ? p : p.t)).join('\n'), src: pieces.map((p) => (typeof p === 'string' ? p : wrap(p.t, p.w ?? 72))).join('\n') });

const P1 = 'Die Stadt liegt an einem breiten Fluss, der im Frühjahr oft über die Ufer tritt und die tiefer gelegenen Wiesen überschwemmt. Seit dem Mittelalter haben die Bewohner gelernt, mit dem Wasser zu leben, und ihre Häuser auf kleinen Hügeln gebaut.';
const P2 = 'Heute schützen Deiche und Rückhaltebecken die meisten Viertel, doch bei starkem Regen steigt der Pegel noch immer bedrohlich an, und viele Keller laufen voll.';
const PA = 'In diesem Kapitel werden die Ergebnisse der Befragung vorgestellt, die im Frühjahr unter allen Mitgliedern des Vereins durchgeführt wurde, und mit früheren Befragungen verglichen, soweit es die Daten erlauben.';
const PB = 'Für die Auswertung wurden die Antworten zunächst bereinigt und anschließend mit einem Statistikprogramm ausgewertet; offene Antworten wurden von zwei Personen unabhängig kodiert.';
mix('heading short', ['Hochwasser in der Altstadt', { t: P1 }, '', 'Die Lage heute', { t: P2 }]);
mix('heading long', ['Hochwasser in der Altstadt und die Folgen für die Bewohner am Fluss', { t: P1 }]);
mix('heading 65', ['Wie die Menschen am Fluss seit Jahrhunderten mit dem Wasser leben', { t: P1 + ' ' + P2 }]);
mix('poem short inside', [{ t: P1 }, '', 'Der Mond ist aufgegangen,', 'Die goldnen Sternlein prangen', 'Am Himmel hell und klar.', '', { t: P2 }]);
mix('poem long inside', [{ t: P1 + ' ' + P2 }, '', 'Und wir tanzen durch die Nacht, bis der Morgen langsam kommt', 'und die Sterne gehen aus, einer nach dem anderen am Horizont', 'wir sind jung und wir sind frei, und die Welt gehört nur uns allein', 'und so soll es immer sein, und so soll es immer, immer sein']);
mix('list inside', [{ t: P1 }, 'Mitbringen:', 'Gummistiefel und eine wasserfeste Jacke für den Rundgang am Ufer', 'eine Taschenlampe, falls es im Keller des Museums dunkel sein sollte', { t: P2 }]);
mix('letter with address', ['Familie Schneider', 'Am Lindenweg 14', '72070 Tübingen', '', 'Sehr geehrte Damen und Herren,', '', { t: P1 + ' ' + P2 }, '', 'Mit freundlichen Grüßen', 'Anna Schneider']);
mix('signature right after', [{ t: P1 + ' ' + P2 }, 'Viele Grüße und bis bald', 'Anna']);
mix('signature after full line', ['Sehr geehrte Frau Müller,', { t: 'vielen Dank für Ihre Nachricht vom Montag. Wir haben die Unterlagen geprüft und können Ihnen mitteilen, dass der Antrag vollständig ist und in der Sitzung behandelt wird.', w: 60 }, 'Mit freundlichen Grüßen', 'Thomas Becker']);
mix('greeting long', ['Liebe Anna, lieber Ben, liebe Kinder und alle anderen im Haus,', { t: P1 + ' ' + P2, w: 66 }]);
mix('sentences block inside', [{ t: P1 + ' ' + P2 }, '', 'Wichtig sind vor allem drei Dinge, die jeder wissen sollte', 'wo der nächste Sandsack-Ausgabepunkt in der Nähe ist', 'wie man den Strom im Keller rechtzeitig abschaltet', 'und welche Nummer man im Notfall wählen muss']);
mix('chat + prose', ['[10:02] Anna: bist du schon unterwegs oder sitzt du noch im Büro?', '[10:03] Ben: noch im büro, das meeting hat länger gedauert als gedacht', '', { t: P1 + ' ' + P2 }]);
mix('label lines + prose', ['Name: Anna Schneider, Lindenweg 14, Tübingen', 'Geburtsdatum: 3. Mai 1985 in Stuttgart, Baden-Württemberg', 'Beruf: Ingenieurin für Wasserbau bei der Stadt Tübingen', '', { t: P1 + ' ' + P2 }]);
mix('ingredients long', ['Zutaten', 'zwei Tassen Mehl, am besten Weizenmehl Type 405 aus dem Supermarkt', 'eine halbe Tasse Zucker, gern auch braunen Zucker oder etwas Honig', 'ein Stück weiche Butter, etwa so groß wie eine Streichholzschachtel', '', 'Zubereitung', { t: 'Alles in einer großen Schüssel gut verrühren, bis ein glatter Teig entsteht, und diesen dann für eine Stunde kalt stellen, bevor man ihn ausrollt und bei mittlerer Hitze backt.' }]);
mix('PDF numbered heading', [{ t: PA, w: 70 }, '2.3 Methoden der Auswertung', { t: PB, w: 70 }]);
mix('PDF Kapitel heading', [{ t: PA, w: 70 }, 'Kapitel 3: Ergebnisse', { t: PB, w: 70 }]);
mix('PDF page number', [{ t: PA, w: 70 }, '12', { t: PB, w: 70 }]);
const OWN = 'Ich habe dazu einen Artikel gefunden, den ich dir unten einfüge, weil er ziemlich gut erklärt, warum das Hochwasser bei uns jedes Jahr wiederkommt und was die Stadt dagegen tut.';
mix('own one-liner then wrapped', [OWN, { t: P1 + ' ' + P2 }]);
mix('own one-liners between wrapped', [OWN, { t: P1 }, OWN, { t: P2 }, OWN, { t: P1 }, OWN]);
mix('PDF single-\\n paragraphs', [{ t: PA, w: 70 }, { t: PB, w: 70 }, { t: P1, w: 70 }, { t: P2, w: 70 }]);
mix('recipe: ingredients above a wrapped paragraph', ['Zutaten:', '250 g Mehl', '125 g Butter', '100 g Zucker', '1 Ei', '1 Prise Salz', '', 'Zubereitung:', { t: 'Mehl, Butter, Zucker, Ei und Salz zu einem glatten Teig verkneten und in Folie gewickelt für mindestens eine Stunde im Kühlschrank ruhen lassen. Danach den Teig auf einer bemehlten Fläche ausrollen, Plätzchen ausstechen und auf ein mit Backpapier belegtes Blech legen. Bei 180 Grad etwa zwölf Minuten backen.', w: 82 }]);
{
  // a full line that ends in a colon, before a small letter: only the indent tells the command apart
  const prose = ['Wer das Programm auf dem eigenen Rechner ausprobieren möchte, lädt', 'es am besten direkt herunter und gibt im Terminal den folgenden', 'Befehl ein, der alle nötigen Teile holt und dann gleich startet:'];
  const code = ['    git clone https://example.org/werkzeuge/handschrift.git', '    cd handschrift && npm install && npm start'];
  MIXED.push({ name: 'command set in after a colon', orig: [prose.join(' '), ...code].join('\n'), src: [...prose, ...code].join('\n') });
}
mix('greeting long, a small letter after it', ['Liebe Anna, lieber Ben, liebe Kinder und alle anderen im Haus,', { t: 'wir haben uns sehr über eure Karte gefreut. ' + P1 + ' ' + P2, w: 66 }]);
mix('numbered list after prose', [{ t: P1 }, '1. Gummistiefel und eine wasserfeste Jacke für den Rundgang am Ufer', '2. eine Taschenlampe, falls es im Keller des Museums dunkel sein sollte']);
mix('quoted reply with a quoted poem', ['Am 3. Mai schrieb Anna:', '> Der Mond ist aufgegangen,', '> Die goldnen Sternlein prangen', '> Am Himmel hell und klar.', '', { t: 'Das Gedicht kenne ich noch aus der Schule, wir mussten es damals auswendig lernen und vor der ganzen Klasse aufsagen, was mir sehr schwerfiel. Heute bin ich froh darüber, denn ich kann es immer noch und sage es manchmal abends den Kindern auf, wenn sie nicht einschlafen können.' }]);

export const MIXED_EXCEPT = {
  'PDF single-\\n paragraphs': { missed: 0, destroyed: 1, why: 'a paragraph whose last line is full and ends a sentence, before one whose first line goes on, looks like a sentence end inside wrapped text' },
  'signature after full line': { missed: 2, destroyed: 0, why: 'a body of three lines has two full lines, fewer than MIN_JOINS' },
};

// 4. Sentences for random documents: paragraphs of them, sometimes with a short line of
// their own, wrapped at 45 to 84 characters.
export const SENTENCES = [DE1, DE2, DE3, EN1, EN2, mailBody, mailBody2, hyO, P1, P2, PA, PB, OWN, two, enumf.replace(/\n/gu, ' ')].join(' ').split(/(?<=[.!?])\s+/u).filter((s) => s.length > 20);
export const SHORT_LINES = ['Hallo Anna,', 'Viele Grüße', 'Tim', 'Kapitel 2', 'Mit freundlichen Grüßen', 'Ergebnisse der Befragung'];

