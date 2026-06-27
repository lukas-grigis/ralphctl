import type { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';

/**
 * Per-call input to {@link HeadlessAiProvider.generate}. Extends {@link AiSession} with
 * adapter-level hooks that do not belong on the session descriptor itself.
 *
 * `promptTransform` — optional per-provider prompt rewrite hook applied at the
 * {@link HeadlessAiProvider} boundary, before the prompt reaches the spawn layer.
 * Lets each adapter tune its preamble (e.g. system-message injection, model-specific
 * prefixes) without breaking the port contract. Callers that do not need a transform
 * simply omit the field; implementations apply it as:
 *
 *   const effectivePrompt = input.promptTransform
 *     ? input.promptTransform(input.prompt as Prompt)
 *     : input.prompt;
 */
export interface HeadlessAiProviderInput extends AiSession {
  /**
   * Optional prompt rewrite applied before the session is spawned. Receives the
   * fully-rendered {@link Prompt} and must return a valid {@link Prompt}. Absent →
   * the original prompt is used unchanged. No per-provider transforms are wired yet;
   * the field is reserved for future cross-harness provider tuning (AgencyBench R7).
   */
  readonly promptTransform?: (prompt: Prompt) => Prompt;
}

/**
 * AI provider port — runs one headless coding-assistant session against the caller's
 * {@link HeadlessAiProviderInput} descriptor and returns a structured-output handle:
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
  generate(input: HeadlessAiProviderInput): Promise<Result<ProviderOutput, DomainError>>;
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
