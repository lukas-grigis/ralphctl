/**
 * Pause-the-host helper for interactive subprocesses (interactive AI sessions, editors, etc.).
 * Wraps an async function `fn` in "yield the terminal, run, restore the terminal" semantics.
 *
 * Lives in `platform/` because the *type* is generic (a callable `<T>(fn) => Promise<T>`).
 * The Ink-aware *implementation* — which actually pauses the React tree — lives in
 * `ui/shared/run-in-terminal.ts` since it depends on Ink. Tests and CLI use the passthrough.
 */
export type RunInTerminal = <T>(fn: () => Promise<T>) => Promise<T>;

/** Passthrough — for CLI invocations and tests where no TUI is rendering. */
export const passthroughRunInTerminal: RunInTerminal = async (fn) => fn();
