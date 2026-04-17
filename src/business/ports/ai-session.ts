import type { AiProvider } from '@src/domain/models.ts';

/** Options for spawning an AI session */
export interface SessionOptions {
  cwd: string;
  args?: string[];
  env?: Record<string, string>;
  maxTurns?: number;
  maxBudgetUsd?: number;
  fallbackModel?: string;
  /**
   * Previous AI session ID to resume. When set, the provider is invoked with
   * its `--resume` equivalent so the agent continues the same conversation
   * rather than starting fresh. Used by the scheduler after a rate-limit
   * capture to relaunch with continuity. Default: start a fresh session.
   */
  resumeSessionId?: string;
}

/** Result from a headless AI session */
export interface SessionResult {
  output: string;
  sessionId?: string;
  model?: string;
}

/** Port for AI session management */
export interface AiSessionPort {
  /** Spawn an interactive AI session (user controls terminal) */
  spawnInteractive(prompt: string, options: SessionOptions): Promise<void>;

  /** Spawn a headless AI session and return output */
  spawnHeadless(prompt: string, options: SessionOptions): Promise<SessionResult>;

  /** Spawn headless with automatic retry on rate limits */
  spawnWithRetry(prompt: string, options: SessionOptions & { maxRetries?: number }): Promise<SessionResult>;

  /** Resume a session by ID */
  resumeSession(sessionId: string, prompt: string, options: SessionOptions): Promise<SessionResult>;

  /** Get the current provider identifier */
  getProviderName(): AiProvider;

  /** Get display-friendly provider name */
  getProviderDisplayName(): string;

  /** Get spawn environment variables for child processes */
  getSpawnEnv(): Record<string, string>;
}
