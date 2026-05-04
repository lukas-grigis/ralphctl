/**
 * `unitSlug` — derive a stable, ASCII-safe folder name for a per-unit
 * sandbox under `<sprintDir>/{refinement,ideation,execution}/<id>-<slug>/`.
 *
 * Rules:
 *  - Lowercase, kebab-case, ASCII-only (strip diacritics, drop any char
 *    that isn't `[a-z0-9-]`).
 *  - Collapse repeated dashes.
 *  - Trim leading / trailing dashes.
 *  - Slug body capped at 40 characters.
 *  - Final form: `<id>-<slug>`. If slug is empty (the input name was all
 *    symbols / punctuation), we collapse to just `<id>` so the folder is
 *    still unique and creatable.
 *
 * The id prefix is always preserved in full — collisions across units
 * with the same generated slug are impossible because the id is unique.
 */
export function unitSlug(id: string, name: string): string {
  const slug = toSlug(name);
  return slug.length > 0 ? `${id}-${slug}` : id;
}

const MAX_SLUG_LEN = 40;

function toSlug(name: string): string {
  // NFKD splits accented characters into base + combining marks. Strip
  // those (`\p{M}` matches every combining-mark category) so the base
  // letter survives intact and the dash-conversion below doesn't split
  // a word at the diacritic.
  const stripped = name.normalize('NFKD').replace(/\p{M}+/gu, '');
  const ascii = stripped
    .toLowerCase()
    // Replace any run of non-[a-z0-9] with a single dash.
    .replace(/[^a-z0-9]+/g, '-')
    // Trim leading / trailing dashes.
    .replace(/^-+|-+$/g, '');
  if (ascii.length <= MAX_SLUG_LEN) return ascii;
  // Truncate, then re-trim a trailing dash that the cut may have left.
  return ascii.slice(0, MAX_SLUG_LEN).replace(/-+$/, '');
}
