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
 * The provider writes parsed {@link HarnessSignal}s to `session.signalsFile` as a JSON array
 * (caller-supplied path; the caller owns its placement and lifetime). The body string the AI
 * emitted is NOT returned — it's the source of a long-running OOM where v8's sliced-string
 * representation pinned multi-megabyte spawn buffers across multi-hour implement chains. Every
 * tag a flow extracts (`<task-verified>`, `<setup-script>`, `<claude-md>`, …) has a parser in
 * the harness-signal registry, so the signals file is the single uniform read-path.
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
}
