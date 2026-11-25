// Prompt list (SPEC 2.4): web/prompts/de-core.json, or a small built-in
// fallback while that file does not exist yet.

const FALLBACK = {
  set: 'fallback@1',
  prompts: [
    'Morgen um 9 Uhr Zahnarzt, danach Einkauf.',
    'Brot, Käse, Äpfel und zwei Flaschen Saft',
    'Treffpunkt: Bahnhof, Gleis 4 (vorne)',
    'Kannst du mich heute Abend anrufen?',
    'Die Übung fällt am Freitag leider aus.',
    'Großer Spaß beim Quiz: 17 von 20 richtig!',
    'Paket für Jörg liegt beim Nachbarn.',
    'Please call back after 3 pm, thanks.',
    'Wäsche aufhängen, Blumen gießen, lesen',
    'Zug fährt um 18:45 ab, nicht vergessen!',
  ].map((text, i) => ({ id: `fallback-${String(i + 1).padStart(4, '0')}`, text, lang: /Please/.test(text) ? 'en' : 'de', block: 1 })),
};

function valid(data) {
  return data && typeof data.set === 'string' && Array.isArray(data.prompts) && data.prompts.length > 0
    && data.prompts.every((p) => p && typeof p.id === 'string' && typeof p.text === 'string' && p.text.trim()
      && Number.isInteger(p.block));
}

/** Returns {set, prompts:[{id,text,lang,block,set}], fallback:boolean}. */
export async function loadPrompts(url) {
  let data = null;
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (res.ok) data = await res.json();
  } catch (_) { data = null; }
  const fallback = !valid(data);
  const src = fallback ? FALLBACK : data;
  const prompts = src.prompts.map((p) => ({
    id: p.id, text: p.text.normalize('NFC'), lang: p.lang || 'de', block: p.block, set: src.set,
  }));
  prompts.sort((a, b) => a.block - b.block);   // stable: keeps file order inside a block
  return { set: src.set, prompts, fallback };
}

/**
 * Pick the next prompt: the first block that still has open prompts; inside it
 * the first open prompt that was not skipped; skipped ones come back once
 * nothing else is left in that block.
 */
export function nextPrompt(prompts, doneIds, skippedIds) {
  const open = prompts.filter((p) => !doneIds.has(p.id));
  if (!open.length) return null;
  const block = open[0].block;
  const inBlock = open.filter((p) => p.block === block);
  return inBlock.find((p) => !skippedIds.has(p.id)) || inBlock[0];
}

/** {block, index (1-based, the line being written), size, done, total} */
export function progressOf(prompts, doneIds, current) {
  const total = prompts.length;
  const done = prompts.filter((p) => doneIds.has(p.id)).length;
  if (!current) return { block: null, index: null, size: null, done, total };
  const inBlock = prompts.filter((p) => p.block === current.block);
  const doneInBlock = inBlock.filter((p) => doneIds.has(p.id)).length;
  return { block: current.block, index: doneInBlock + 1, size: inBlock.length, done, total };
}
