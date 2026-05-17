import type { Result } from '@src/domain/result.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';

/**
 * Static metadata for a single prompt template. Code-level declaration of which template a
 * prompt uses, what its placeholders are, what to validate, which partials get auto-loaded,
 * and which harness signals the response is expected to carry.
 *
 * Each prompt module exports one `PromptDefinition` and (typically) a typed top-level
 * builder. The generic `buildPrompt(deps, def, input)` entry uses the definition to load
 * the template + partials, validate input, substitute placeholders, and return a branded
 * `Prompt`.
 *
 * Tests pin the alignment between template and definition: a placeholder in the template
 * with no spec — or a spec for a placeholder that doesn't exist — is a test failure rather
 * than a runtime surprise.
 */

/** A single tag from `HarnessSignal['type']`. */
export type HarnessSignalType = HarnessSignal['type'];

export interface ParameterSpec<TValue> {
  /**
   * Placeholder name in the template (SCREAMING_SNAKE_CASE). The substitution engine looks
   * for `{{<placeholder>}}` and replaces it with the rendered value.
   */
  readonly placeholder: string;
  /**
   * Human-readable description of what the parameter is and why it's needed. Surfaced in
   * generated docs and TUI introspection.
   */
  readonly description: string;
  /**
   * Optional pre-substitution validator. Runs before the value reaches the template. Return
   * `Result.ok` with the (possibly normalised) value to proceed, or `Result.error` to abort
   * prompt construction with a typed `ValidationError`.
   */
  readonly validate?: (value: TValue) => Result<TValue, ValidationError>;
  /**
   * When true, an undefined input value is replaced with the empty string (so an entire
   * section can opt itself out of the rendered prompt). When false / omitted, an undefined
   * value aborts construction with a `ValidationError`.
   */
  readonly optional?: boolean;
}

/**
 * Map a typed input shape to a per-field parameter spec. Required fields keep their `TValue`;
 * optional fields strip `undefined` from the spec's value type so validators always see a
 * concrete value.
 */
export type ParameterManifest<TInput> = {
  readonly [K in keyof TInput]-?: ParameterSpec<NonNullable<TInput[K]>>;
};

export interface PromptDefinition<TInput extends object> {
  /** Template file name without `.md`, e.g. `'refine'`. */
  readonly templateName: string;
  /** One-line description of what this prompt asks the AI to do. */
  readonly description: string;
  /** Per-input-field placeholder spec. */
  readonly parameters: ParameterManifest<TInput>;
  /**
   * Partials auto-loaded by the builder and substituted into the main template by
   * placeholder name. Key = placeholder in the main template (SCREAMING_SNAKE_CASE);
   * value = partial template file name (no `.md`).
   *
   * Partials are loaded once per `buildPrompt` call. Their bodies are trimmed before
   * substitution so leading / trailing whitespace doesn't bleed into the rendered prompt.
   */
  readonly partials?: Readonly<Record<string, string>>;
  /**
   * `HarnessSignal['type']` values this prompt's response is expected to produce.
   * Documentation + future tooling (e.g., scoped signal parser, smoke tests) read this
   * list. An empty array means "no harness signals expected" — e.g., a refine prompt that
   * returns markdown only.
   */
  readonly expectedSignals: readonly HarnessSignalType[];
}
