// The page mode's formatting reference: what to type and what it gives (CHEAT_SHEET of
// markup.js), the choice of format, and a short example document.  page-view.js keeps
// the choice; this file owns the panel.

import { CHEAT_SHEET } from './markup.js';

/** School notes that show the range of marks.  Words the hand writes well: no digits,
 *  few capitals H, R, Ä, no word ending in r where it is avoidable. */
export const EXAMPLE_TEXT = `# {datum} {mitte} Fotosynthese

Aus Licht und ==Kohlendioxid== wird *Glukose*.

- findet in den Zellen statt
- braucht viel Licht
  - am besten mittags
- gibt Sauerstoff ab

- [x] Seite lesen
- [ ] Aufgaben machen

Licht -> Energie und Wachstum

> **Merke:** Ohne Licht keine Fotosynthese.

Das Grün kommt vom [Chlorophyll]{grün}.

---
{rechts} bis Montag lernen`;

const FORMATS = [['auto', 'Automatisch'], ['markdown', 'Markdown'], ['latex', 'LaTeX'], ['text', 'Nur Text']];

/**
 * Wires the button #pg-format to its panel #pg-format-panel.
 * text: the page mode's textarea; getFormat / setFormat: the stored choice;
 * onText: called after the panel changed the textarea's value.
 */
export function createFormatHelp({ text, getFormat, setFormat, onText }) {
  const $ = (id) => document.getElementById(id);
  const btn = $('pg-format'), panel = $('pg-format-panel');
  const example = $('pg-example'), keep = $('pg-example-keep'), undo = $('pg-example-undo');
  const choices = panel.querySelector('.pg-fmt-choices');

  for (const [v, label] of FORMATS) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'gen-choice', textContent: label });
    b.setAttribute('role', 'radio');
    b.dataset.v = v;
    choices.append(b);
  }
  panel.querySelector('.pg-ref').append(...CHEAT_SHEET.flatMap((row) => [
    Object.assign(document.createElement('dt'), { textContent: row.schreiben }),
    Object.assign(document.createElement('dd'), { textContent: row.ergebnis }),
  ]));

  // The text the example replaced.  Setting a textarea's value clears the browser's own
  // undo, and Android keyboards offer none, so the way back is a button of the panel; it
  // holds while the field still shows the example untouched.
  let replaced = null;
  let asking = false;

  function show() {
    const f = getFormat();
    for (const b of choices.children) b.setAttribute('aria-checked', b.dataset.v === f ? 'true' : 'false');
    if (text.value !== EXAMPLE_TEXT) replaced = null;
    example.textContent = asking ? 'Text ersetzen' : 'Beispiel einsetzen';
    example.classList.toggle('pg-ask', asking);
    keep.hidden = !asking;
    undo.hidden = asking || replaced === null;
  }

  function open() {
    // Stil and this panel share the room above the text; one at a time.
    const style = $('gen-style-btn');
    if (style?.getAttribute('aria-expanded') === 'true') style.click();
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    asking = false;
    show();
    panel.scrollTop = 0;
    (choices.querySelector('[aria-checked="true"]') || choices.firstElementChild).focus({ preventScroll: true });
  }

  function close(refocus) {
    if (panel.hidden) return;
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    asking = false;
    if (refocus) btn.focus({ preventScroll: true });
  }

  function put(value) {
    text.value = value;
    onText();
  }

  btn.addEventListener('click', () => (panel.hidden ? open() : close(true)));
  choices.addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    setFormat(b.dataset.v);
    show();
  });
  example.addEventListener('click', () => {
    // the example shows the marks at work: under 'Nur Text' it would be written mark by mark
    if (getFormat() === 'text') { setFormat('auto'); show(); }
    if (text.value === EXAMPLE_TEXT) return;
    if (text.value.trim() && !asking) { asking = true; show(); keep.focus({ preventScroll: true }); return; }
    const before = text.value.trim() ? text.value : null;
    asking = false;
    put(EXAMPLE_TEXT);
    replaced = before;
    show();
    (replaced === null ? example : undo).focus({ preventScroll: true });
  });
  keep.addEventListener('click', () => { asking = false; show(); example.focus({ preventScroll: true }); });
  undo.addEventListener('click', () => {
    if (replaced === null) return;
    const back = replaced;
    replaced = null;
    put(back);
    show();
    example.focus({ preventScroll: true });
  });
  text.addEventListener('input', () => { if (!panel.hidden) show(); });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || panel.hidden) return;
    const inside = panel.contains(document.activeElement) || document.activeElement === btn;
    close(inside);
  });
  // A tap anywhere else closes the panel and goes on to what was tapped.
  document.addEventListener('pointerdown', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) close(false);
  });

  show();
  return { refresh: show };
}
