import type { AiProvider } from '@src/domain/models.ts';

// ============================================================================
// Parsed output from provider CLI
// ============================================================================

export interface ParsedOutput {
  result: string;
  sessionId: string | null;
  model: string | null;
}

// ============================================================================
// Spawn options & results (provider-agnostic)
// ============================================================================

export interface SpawnSyncOptions {
  cwd: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface SpawnAsyncOptions {
  cwd: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HeadlessSpawnOptions extends SpawnAsyncOptions {
  prompt?: string;
  resumeSessionId?: string;
  /**
   * When the signal aborts mid-spawn, the session layer sends SIGTERM to
   * the provider child via the process-lifecycle adapter so cancellation
   * propagates to the underlying AI process.
   */
  abortSignal?: AbortSignal;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Session ID from CLI (available with --output-format json) */
  sessionId: string | null;
  /** Model identifier from CLI (available with --output-format json) */
  model: string | null;
}

// ============================================================================
// Rate limit detection
// ============================================================================

export interface RateLimitInfo {
  rateLimited: boolean;
  retryAfterMs: number | null;
}

// ============================================================================
// Provider adapter interface
// ============================================================================

export interface ProviderAdapter {
  readonly name: AiProvider;
  readonly displayName: string;
  readonly binary: string;

  /** Base CLI args for permission/tool access. */
  readonly baseArgs: string[];

  /**
   * Whether this provider is experimental (not fully stable).
   * Copilot CLI is in public preview; Claude Code is GA.
   */
  readonly experimental: boolean;

  /** Build args for interactive mode (inherits stdio). */
  buildInteractiveArgs(prompt: string, extraArgs?: string[]): string[];

  /** Build args for headless/print mode (captures stdout). */
  buildHeadlessArgs(extraArgs?: string[]): string[];

  /**
   * Parse JSON output from --output-format json.
   *
   * Implementations use Result-based internal logic for JSON parsing.
   * Always returns a valid ParsedOutput — on parse failure, falls back
   * to treating raw stdout as the result text with null sessionId.
   */
  parseJsonOutput(stdout: string): ParsedOutput;

  /**
   * Extract a session ID after a headless process completes.
   * Called when parseJsonOutput returns sessionId: null.
   * Copilot: parses the --share output file; Claude: not needed (JSON output has it).
   *
   * Implementations use Result-based internal logic for I/O.
   * Returns null when no session file is found or on filesystem errors (graceful degradation).
   */
  extractSessionId?(cwd: string): Promise<string | null>;

  /**
   * Build CLI args for resuming a previous session.
   * Claude: `['--resume', sessionId]`
   * Copilot: `['--resume=' + sessionId]` (optional-value syntax)
   *
   * Validates the session ID format and throws if invalid (prevents argument injection).
   */
  buildResumeArgs(sessionId: string): string[];

  /** Detect rate limit signals in stderr. */
  detectRateLimit(stderr: string): RateLimitInfo;

  /** Provider-specific env vars to set for a spawn. Claude-only example: CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD */
  getSpawnEnv(): Record<string, string>;
}
