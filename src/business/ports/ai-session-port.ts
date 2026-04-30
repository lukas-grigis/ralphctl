/**
 * `AiSessionPort` — spawns AI provider CLI sessions (Claude / Copilot) and
 * surfaces structured outputs back to the harness.
 *
 * This port is the only seam business code uses to talk to an external AI
 * binary. Concrete adapters live under `integration/ai/` and own the
 * provider-specific spawn semantics (flags, env, JSONL parsing, retry on
 * rate limit). Callers stay provider-agnostic.
 */
import type { AbsolutePath } from '../../domain/values/absolute-path.ts';
import type { DomainError } from '../../domain/errors/domain-error.ts';
import type { Result } from '../../domain/result.ts';

/**
 * The two AI providers ralphctl currently integrates with. Defined locally
 * (instead of imported from the legacy domain/models.ts) so this port owns
 * its own vocabulary — provider names are an integration concern, not a
 * domain invariant.
 */
export type AiProvider = 'claude' | 'copilot';

/** Options for spawning an AI session. */
export interface SessionOptions {
  /** Working directory for the spawned child process. */
  readonly cwd: AbsolutePath;
  /** Extra CLI args to forward to the provider binary. */
  readonly args?: readonly string[];
  /** Environment variables overlaid onto the child process. */
  readonly env?: Readonly<Record<string, string>>;
  /** Cap on agentic turns for headless runs. */
  readonly maxTurns?: number;
  /** Cap on USD spend for headless runs. */
  readonly maxBudgetUsd?: number;
  /** Provider model identifier to fall back to on quota / capability errors. */
  readonly fallbackModel?: string;
  /**
   * Previous AI session id to resume. When set, the provider is invoked
   * with its `--resume` equivalent so the agent continues the same
   * conversation rather than starting fresh. Used by the scheduler after a
   * rate-limit capture to relaunch with continuity. Default: start fresh.
   */
  readonly resumeSessionId?: string;
  /**
   * Cooperative cancellation. When the signal aborts mid-spawn, the
   * adapter sends SIGTERM to the provider's child process via the
   * process-lifecycle layer so the child winds down gracefully (same
   * machinery as Ctrl+C).
   */
  readonly abortSignal?: AbortSignal;
}

/** Result from a headless AI session. */
export interface SessionResult {
  /** Raw stdout from the provider. */
  readonly output: string;
  /** Provider-assigned session id, when surfaced. */
  readonly sessionId?: string;
  /** Model identifier the provider actually used. */
  readonly model?: string;
  /**
   * Number of agentic turns reported by the provider for this spawn.
   * `null` when the provider doesn't expose it (e.g. Copilot's JSONL).
   * Surfaced for harness instrumentation (debug logs).
   */
  readonly numTurns?: number | null;
}

/** Port for AI session management. */
export interface AiSessionPort {
  /** Spawn an interactive AI session — user controls the terminal directly. */
  spawnInteractive(prompt: string, options: SessionOptions): Promise<Result<void, DomainError>>;

  /** Spawn a headless AI session and return its captured output. */
  spawnHeadless(prompt: string, options: SessionOptions): Promise<Result<SessionResult, DomainError>>;

  /** Spawn headless with automatic retry on rate-limit responses. */
  spawnWithRetry(
    prompt: string,
    options: SessionOptions & { readonly maxRetries?: number }
  ): Promise<Result<SessionResult, DomainError>>;

  /** Resume a previous headless session by id. */
  resumeSession(
    sessionId: string,
    prompt: string,
    options: SessionOptions
  ): Promise<Result<SessionResult, DomainError>>;

  /**
   * Eagerly resolve the active provider so the sync getters below can be
   * called safely. Idempotent — subsequent calls are no-ops. Call once at
   * the top of any use case that needs the provider name / display / env
   * before spawning a session (spinner labels, confirm prompts, etc.).
   */
  ensureReady(): Promise<void>;

  /** Get the current provider identifier. Requires a prior `ensureReady`. */
  getProviderName(): AiProvider;

  /** Get the display-friendly provider name. Requires a prior `ensureReady`. */
  getProviderDisplayName(): string;

  /** Get spawn environment overrides for the active provider. Requires a prior `ensureReady`. */
  getSpawnEnv(): Record<string, string>;
}
