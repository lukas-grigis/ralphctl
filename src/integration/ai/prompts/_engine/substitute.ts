import { Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import { extractPlaceholders } from '@src/integration/ai/prompts/_engine/extract-placeholders.ts';
import { compressSection, SECTION_CHAR_CAP } from '@src/integration/ai/prompts/_engine/compress-section.ts';

/**
 * Placeholder substitution for `.md` prompt templates.
 *
 * Contract:
 *  - `{{KEY}}` is replaced by `values[KEY]`. Keys are SCREAMING_SNAKE — ASCII uppercase
 *    letters, digits, and underscores; the first character must be a letter.
 *  - When a key is **present** with the empty string, the placeholder is replaced with the
 *    empty string (so callers can opt a section out by passing `''`).
 *  - When a key is **absent**, the placeholder is **left intact** in the output. This is
 *    fail-soft on purpose: builders compose multi-pass substitutions (partials filled first,
 *    then the outer template), and a soft pass means a placeholder inside an injected partial
 *    isn't accidentally consumed by the first pass.
 *  - All occurrences of the same key are replaced.
 *  - Replacement values are inserted verbatim — `$&` and other regex replacement specials in
 *    the value do not trigger backreferences (we use a plain function callback, not a string
 *    replacement). Inserted values are NEVER re-scanned: a value that happens to contain
 *    `{{ANYTHING}}` (AI-authored journal text quoting a placeholder, a critique naming
 *    `{{API_KEY}}`, …) passes through as inert literal text.
 *
 * `assertTemplateKeysFilled` is the TEMPLATE-side fence. It checks that every placeholder the
 * template (and its loaded partials) declares has a value in the substitution map — a typo or
 * missing slot surfaces as a typed error. It deliberately does NOT scan the rendered output:
 * a post-render scan punished placeholder-shaped literals inside SUBSTITUTED VALUES, so one
 * AI-journaled `{{TOKEN}}` quote poisoned every later prompt built from that journal — and the
 * depth-preserving progress cap re-inlined the poison on every retry, permanently wedging the
 * task. Template/manifest drift is what the fence is for; AI prose is not drift.
 */

const PLACEHOLDER_PATTERN = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

/**
 * Keys whose substituted values are tail-compressed when they exceed {@link SECTION_CHAR_CAP}.
 * These are large dynamic sections (progress journals, learning ledgers) that grow unboundedly
 * over a long sprint. Keeping the tail (most recent content) follows the "Lost in the Middle"
 * guidance — older entries are less useful and pushing them into the middle of the context
 * degrades model attention on the task-critical sections that follow.
 *
 * Episode summaries are deliberately excluded: they are hard-bounded to a handful of short items
 * well under the cap, and their substituted value self-wraps in an opening/closing tag (unlike
 * the wrappers for the keys below, which live in template.md). Tail-slicing would drop the
 * leading open tag, leaving a dangling close tag outside any tag — malformed.
 */
const COMPRESSIBLE_KEYS = new Set(['PRIOR_PROGRESS', 'PRIOR_LEARNINGS']);

export const substitute = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(PLACEHOLDER_PATTERN, (match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return match;
    // Defensive: a Record<string, string> may still contain `undefined` at runtime when
    // constructed from looser sources. Treat that the same as "absent" so we don't render
    // the literal "undefined".
    const value = values[key];
    if (value === undefined) return match;
    if (COMPRESSIBLE_KEYS.has(key) && value.length > SECTION_CHAR_CAP) {
      return compressSection(value);
    }
    return value;
  });

/**
 * Assert every placeholder declared by `template` — and by each supplied partial body, since a
 * partial's own placeholders survive the single-pass substitution as literals — has a value in
 * `values`. On success the RENDERED string is branded as `Prompt`; on any unfilled key, returns
 * a `ParseError` (subCode `'schema-mismatch'`) listing the missing placeholders in first-seen
 * order. Values containing placeholder-shaped text are intentionally NOT flagged — see the
 * module docstring.
 */
export const assertTemplateKeysFilled = (
  rendered: string,
  template: string,
  partialBodies: readonly string[],
  values: Readonly<Record<string, string>>,
  where: string
): Result<Prompt, ParseError> => {
  const required = new Set<string>(extractPlaceholders(template));
  for (const body of partialBodies) {
    for (const key of extractPlaceholders(body)) required.add(key);
  }
  const missing = Array.from(required).filter((key) => values[key] === undefined);
  if (missing.length === 0) return Result.ok(rendered as Prompt) as Result<Prompt, ParseError>;
  return Result.error(
    new ParseError({
      subCode: 'schema-mismatch',
      message:
        `${where}: template declares ${String(missing.length)} unfilled placeholder(s): ` +
        `${missing.map((k) => `{{${k}}}`).join(', ')}. ` +
        `Either fill the slot in the builder's substitution map or remove the placeholder from the template.`,
    })
  );
};
