import type { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';

/**
 * AI provider port — runs one headless coding-assistant session against the caller's
 * {@link AiSession} descriptor and returns a structured-output handle:
 *
 *   { signalsFile, sessionId?, exitCode }
 *
 * Under the audit-[09] contract the AI itself writes `session.signalsFile` via its `Write`
 * tool — production providers no longer parse stdout for harness signals. The provider just
 * spawns the session, captures meta (session id, exit code), and returns the path the chain
 * leaf reads back. The body string the AI emitted is NOT returned — it's the source of a
 * long-running OOM where v8's sliced-string representation pinned multi-megabyte spawn
 * buffers across multi-hour implement chains.
 *
 * `sessionId` is best-effort per-provider — claude's `--output-format stream-json` init event,
 * codex's JSONL meta event, copilot's stream meta line. Absence is never an error.
 */
export interface HeadlessAiProvider {
  generate(session: AiSession): Promise<Result<ProviderOutput, DomainError>>;
}

export interface ProviderOutput {
  /** Absolute path to the JSON file the provider wrote parsed signals to (echoes `session.signalsFile`). */
  readonly signalsFile: AbsolutePath;
  /** Best-effort session id captured from the underlying CLI; absent when the provider didn't surface one. */
  readonly sessionId?: string;
  /** The child process's exit code (0 on the success path). Surfaced so callers can decide their own outcome semantics. */
  readonly exitCode: number;
  /**
   * Present only when the spawn exited non-clean (SIGTERM from the idle-stdout watchdog,
   * or code 143 — macOS Node surfaces SIGTERM either way) but the AI had already written
   * `signals.json` per the audit-[09] contract, so the harness honoured the work and
   * recovered. `undefined` on every clean (`code === 0`) exit. Lets the round summary
   * distinguish a healthy spawn from one that was killed post-Write without log-scraping
   * — set in `_engine/classify-spawn-exit.ts`.
   */
  readonly recoveredFromExit?: { readonly code: number | null; readonly signal: string | null };
}
