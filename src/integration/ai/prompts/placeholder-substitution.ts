/**
 * Placeholder substitution for `.md` prompt templates.
 *
 * Contract:
 *  - `{{KEY}}` is replaced by `values[KEY]`. Keys are matched
 *    case-sensitively and consist of ASCII letters, digits, and
 *    underscores (`/[A-Z0-9_]/i` extended to allow uppercase + digits +
 *    underscore — by convention all template keys are SCREAMING_SNAKE).
 *  - When a key is present in `values` with the empty string, the
 *    placeholder is replaced with the empty string (so consumers can opt
 *    a section out by passing `''`).
 *  - When a key is **absent** from `values`, the placeholder is **left
 *    intact** in the output. This is a deliberate fail-soft policy — the
 *    new port surface is shaped by the input bag, not by every template
 *    placeholder, and we want adapters to be able to fill in the keys
 *    they know about without a brittle "every key required" contract.
 *  - All occurrences of the same key are replaced.
 *  - Replacement values are inserted verbatim — `$` and other
 *    regex/replacement metacharacters in the value do not trigger
 *    backreferences (we use `split` + `join`, not `String.replaceAll`'s
 *    function form, to avoid the `$&` family of replacement specials).
 *
 * `assertFullySubstituted` is the post-substitution fence — fail-loud
 * when any `{{TOKEN}}` survives. Call it at the boundary where the
 * rendered prompt is about to leave the adapter (i.e. inside every
 * `build*Prompt` method) so a typo or missing field surfaces as a typed
 * error instead of silently leaking a literal `{{TOKEN}}` to Claude.
 */
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';

const PLACEHOLDER_PATTERN = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

export function substitute(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER_PATTERN, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      // Defensive: a `Record<string, string>` may still contain `undefined`
      // at runtime when constructed from looser sources. Treat that the
      // same as "absent" so we don't render the literal "undefined".
      return values[key] ?? match;
    }
    return match;
  });
}

/**
 * Scan `rendered` for any leftover `{{TOKEN}}` placeholders. Returns
 * `Result.ok(undefined)` on a clean string; otherwise returns a
 * `StorageError(subCode: 'parse')` listing every unresolved placeholder
 * (deduplicated, in first-seen order).
 *
 * The error type is reused rather than introducing a new variant — the
 * builder methods all return `Result<string, StorageError>`, so this
 * fence stays in the same envelope.
 */
export function assertFullySubstituted(rendered: string, where: string): Result<void, StorageError> {
  const matches = rendered.match(PLACEHOLDER_PATTERN);
  if (matches === null) return Result.ok();

  const unique = Array.from(new Set(matches));
  return Result.error(
    new StorageError({
      subCode: 'parse',
      message:
        `${where}: rendered prompt has ${String(unique.length)} unresolved placeholder(s): ${unique.join(', ')}. ` +
        `Either fill the slot in the adapter's substitution map or remove the placeholder from the template.`,
    })
  );
}
