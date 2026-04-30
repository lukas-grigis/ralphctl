/**
 * Internal-to-integration types describing how a provider CLI behaves.
 *
 * These shapes are *not* part of any port contract. The business layer
 * never reaches them — it only knows about {@link AiSessionPort} and the
 * domain types behind it. The session adapter ({@link
 * provider-ai-session-adapter}) consumes a {@link ProviderAdapter} to
 * translate between the abstract port and a concrete CLI invocation.
 */
import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import type { AiProvider } from '../../../business/ports/ai-session-port.ts';

/** Structured fields a provider's JSON output produces, post-parse. */
export interface ParsedOutput {
  /** Result text the harness records as the AI's reply. */
  readonly result: string;
  /** Provider-assigned session id, if exposed. */
  readonly sessionId: string | null;
  /** Model identifier the provider actually used, if exposed. */
  readonly model: string | null;
  /**
   * Number of agentic turns the provider used. `null` when the provider's
   * JSON output doesn't expose it (e.g. Copilot's JSONL).
   */
  readonly numTurns: number | null;
}

/** Result of a rate-limit pattern match against captured stderr. */
export interface RateLimitInfo {
  readonly rateLimited: boolean;
  readonly retryAfterMs: number | null;
}

/**
 * Provider-specific behaviour the session runner needs.
 *
 * Implementations are stateless — every method is a pure function of its
 * arguments. The runner injects a single adapter at construction time;
 * picking the active provider is the caller's responsibility (resolved
 * lazily through the session adapter's `ensureReady` hook).
 */
export interface ProviderAdapter {
  readonly name: AiProvider;
  readonly displayName: string;
  readonly binary: string;

  /** Base CLI args common to both interactive and headless modes. */
  readonly baseArgs: readonly string[];

  /**
   * Whether this provider is experimental (not yet GA). Surfaced by
   * `ralphctl doctor`; the harness itself doesn't gate on it.
   */
  readonly experimental: boolean;

  /** Build args for an interactive `stdio: 'inherit'` spawn. */
  buildInteractiveArgs(prompt: string, extraArgs?: readonly string[]): readonly string[];

  /** Build args for a headless capture spawn (`-p` / `--print` mode). */
  buildHeadlessArgs(extraArgs?: readonly string[]): readonly string[];

  /**
   * Parse the JSON the provider emits with `--output-format json`.
   * Implementations must always return a valid `ParsedOutput` — on parse
   * failure they fall back to treating the raw stdout as the result text.
   */
  parseJsonOutput(stdout: string): ParsedOutput;

  /**
   * Recover a session id from a side-channel (e.g. Copilot's `--share`
   * sidecar file). Called only when {@link parseJsonOutput} returned
   * `sessionId: null`. Implementations swallow filesystem errors and
   * return `null` — graceful degradation, never a throw.
   */
  extractSessionId?(cwd: AbsolutePath): Promise<string | null>;

  /**
   * Build CLI args to resume a previous session. Implementations validate
   * the session id format and throw on invalid input — that's a
   * programmer / config error, not a runtime failure, so a synchronous
   * throw is the right surface.
   */
  buildResumeArgs(sessionId: string): readonly string[];

  /** Match captured stderr against the provider's rate-limit patterns. */
  detectRateLimit(stderr: string): RateLimitInfo;

  /** Provider-specific environment overrides for spawn(). */
  getSpawnEnv(): Record<string, string>;
}
