import { Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';

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
 *    replacement).
 *
 * `assertFullySubstituted` is the post-substitution fence. Call it at the boundary where the
 * rendered prompt is about to leave the builder so a typo or missing slot surfaces as a typed
 * error instead of silently leaking a literal `{{TOKEN}}` to the AI.
 */

const PLACEHOLDER_PATTERN = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

export const substitute = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(PLACEHOLDER_PATTERN, (match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return match;
    // Defensive: a Record<string, string> may still contain `undefined` at runtime when
    // constructed from looser sources. Treat that the same as "absent" so we don't render
    // the literal "undefined".
    const value = values[key];
    return value !== undefined ? value : match;
  });

/**
 * Scan the rendered string for any leftover `{{TOKEN}}` placeholders. On a clean string the
 * input is branded as `Prompt` and returned ok. On any leftover, returns a `ParseError`
 * (subCode `'schema-mismatch'`) listing every unresolved placeholder, deduplicated and in
 * first-seen order.
 */
export const assertFullySubstituted = (rendered: string, where: string): Result<Prompt, ParseError> => {
  const matches = rendered.match(PLACEHOLDER_PATTERN);
  if (matches === null) return Result.ok(rendered as Prompt) as Result<Prompt, ParseError>;
  const unique = Array.from(new Set(matches));
  return Result.error(
    new ParseError({
      subCode: 'schema-mismatch',
      message:
        `${where}: rendered prompt has ${String(unique.length)} unresolved placeholder(s): ${unique.join(', ')}. ` +
        `Either fill the slot in the builder's substitution map or remove the placeholder from the template.`,
    })
  );
};
