import type { Result } from '@src/domain/result.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';

/**
 * One option in a `askChoice` / `askMultiChoice` menu. `value` is what the caller actually wants
 * back; `label` is what the user sees. Keeping the two split lets callers map labels to typed
 * domain values (e.g. `RepositoryId`) without extra plumbing.
 */
export interface Choice<T> {
  readonly label: string;
  readonly value: T;
  /** Optional one-line clarifier rendered next to the label. Reserved for richer renderers. */
  readonly description?: string;
  /**
   * When `true` the renderer must skip the entry on keyboard navigation, dim the label, and
   * reject submission. Used by gating surfaces (e.g. the Settings provider picker dimming
   * providers whose CLI is missing). Defaults to `false` / undefined.
   */
  readonly disabled?: boolean;
}

/** Input bag for {@link InteractivePrompt.askConfirm}. */
export interface AskConfirmInput {
  readonly message: string;
  /** Answer focused on open (what ↵ submits). Defaults to `true`; pass `false` for a `[y/N]` question. */
  readonly defaultValue?: boolean;
}

/** Options for {@link InteractivePrompt.askText}. */
export interface AskTextOptions {
  readonly initial?: string;
  /** Returns a message to block submit and show inline, or `undefined` when the raw buffer is acceptable. */
  readonly validate?: (value: string) => string | undefined;
}

/**
 * Port for asking the user questions; the only adapter is the Ink one, so prompting flows are
 * TUI-only. Cancellation arrives on the `Result` channel (typically `AbortError`), so leaves can
 * fail fast on Ctrl-C without special casing.
 */
export interface InteractivePrompt {
  /** Trimmed free text. `initial` pre-fills an editable suggestion; `validate` holds the prompt until accepted. */
  askText(prompt: string, opts?: AskTextOptions): Promise<Result<string, DomainError>>;
  /** Multi-line input, returned verbatim (untrimmed). Enter submits; `\`+Enter or ctrl+j inserts a newline. */
  askTextArea(prompt: string, opts?: { readonly initial?: string }): Promise<Result<string, DomainError>>;
  /** Single-select from a fixed option list. Returns the selected option's `value`. */
  askChoice<T>(prompt: string, options: ReadonlyArray<Choice<T>>): Promise<Result<T, DomainError>>;
  /** Multi-select, order preserved. `initial` pre-checks options whose `value` matches (`===`). */
  askMultiChoice<T>(
    prompt: string,
    options: ReadonlyArray<Choice<T>>,
    opts?: { readonly initial?: readonly T[] }
  ): Promise<Result<readonly T[], DomainError>>;
  /** Yes/no confirmation. */
  askConfirm(input: AskConfirmInput): Promise<Result<boolean, DomainError>>;
}
