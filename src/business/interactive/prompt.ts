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

/** Input bag for {@link InteractivePrompt.askConfirm}. Object form keeps room for future fields. */
export interface AskConfirmInput {
  readonly message: string;
}

/**
 * Output port for asking the user questions. The only production adapter lives in
 * `ui/tui/prompts/` (Ink-based, wired by `ui/tui/launch.ts`). v2's CLI surface is
 * non-interactive by design (see `docs/api.md`), so there is no console / stdin adapter
 * today — chain flows that need prompts are TUI-only.
 *
 * Tests build a fake that returns scripted answers — the use case stays adapter-agnostic.
 *
 * Cancellation is surfaced through the `Result` channel as a `DomainError` (typically
 * `AbortError`) — same shape every other domain call uses, so chain leaves can fail-fast on a
 * Ctrl-C without special-case handling.
 */
export interface InteractivePrompt {
  /**
   * Free-text input. Result text is whatever the user typed (trimmed by the adapter).
   * `opts.initial` pre-fills the buffer so callers can offer an editable suggestion (e.g.
   * an AI-proposed script the user wants to tweak) without forcing the user to retype it.
   */
  askText(prompt: string, opts?: { readonly initial?: string }): Promise<Result<string, DomainError>>;
  /**
   * Multi-line free-text input. Enter inserts a newline; Ctrl+D submits. Returns the typed
   * value verbatim (not trimmed — newlines and indentation matter for callers that paste
   * structured input). Designed to replace external `$EDITOR` round-trips that left the
   * terminal in inconsistent redraw state on return.
   */
  askTextArea(prompt: string, opts?: { readonly initial?: string }): Promise<Result<string, DomainError>>;
  /** Single-select from a fixed option list. Returns the selected option's `value`. */
  askChoice<T>(prompt: string, options: ReadonlyArray<Choice<T>>): Promise<Result<T, DomainError>>;
  /** Multi-select from a fixed option list. Returns the selected options' `value`s, order preserved. */
  askMultiChoice<T>(prompt: string, options: ReadonlyArray<Choice<T>>): Promise<Result<readonly T[], DomainError>>;
  /**
   * Yes/no confirmation. Returns the user's boolean answer. Adapters define what counts as
   * yes/no (the console adapter accepts `y`/`yes` / `n`/`no`, case-insensitive); empty input
   * surfaces a `ValidationError` rather than guessing a default — callers that want a default
   * can wrap this method with their own fallback logic.
   */
  askConfirm(input: AskConfirmInput): Promise<Result<boolean, DomainError>>;
}
