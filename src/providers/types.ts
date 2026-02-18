import type { AiProvider } from '@src/schemas/index.ts';

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
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Session ID from CLI (available with --output-format json) */
  sessionId: string | null;
}

export interface SpawnInteractiveResult {
  code: number;
  error?: string;
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

  /** Build args for interactive mode (inherits stdio). */
  buildInteractiveArgs(prompt: string, extraArgs?: string[]): string[];

  /** Build args for headless/print mode (captures stdout). */
  buildHeadlessArgs(extraArgs?: string[]): string[];

  /** Parse JSON output from --output-format json. */
  parseJsonOutput(stdout: string): { result: string; sessionId: string | null };

  /** Detect rate limit signals in stderr. */
  detectRateLimit(stderr: string): RateLimitInfo;

  /** Provider-specific env vars to set for a spawn. Claude-only example: CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD */
  getSpawnEnv(): Record<string, string>;
}
