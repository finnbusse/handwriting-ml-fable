// Who is writing: a display name typed once ("Finn") and the slug derived from it,
// which is the writer id in records and upload paths. No writer is ever built in.

const MAX_SLUG = 24;
const MAX_NAME = 40;

/** Lowercase, ä->ae ö->oe ü->ue ß->ss, everything else reduced to a-z 0-9 and "-", max 24 characters. '' when nothing is left. */
export function slugify(input) {
  const s = String(input == null ? '' : input).normalize('NFC').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')       // é -> e
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, MAX_SLUG).replace(/-+$/, '');
}

/** The display name as typed: trimmed, inner spaces collapsed, not too long. */
export function cleanName(input) {
  return String(input == null ? '' : input).normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
}

/** {id, name} for a typed name, or null when no usable id can be made from it. */
export function makeWriter(input) {
  const id = slugify(input);
  const name = cleanName(input);
  return id && name ? { id, name } : null;
}
