import { spawn, spawnSync } from 'node:child_process';
import { ProcessManager } from '@src/ai/process-manager.ts';
import { assertSafeCwd } from '@src/utils/paths.ts';
import { type ProviderAdapter } from '@src/providers/types.ts';
import { getActiveProvider } from '@src/providers/index.ts';

// Re-export types from providers for backward compatibility
export type { HeadlessSpawnOptions, SpawnResult } from '@src/providers/types.ts';
export type { SpawnSyncOptions, SpawnAsyncOptions } from '@src/providers/types.ts';

// Local import aliases for use in function signatures
import type { HeadlessSpawnOptions, SpawnResult, SpawnSyncOptions, SpawnAsyncOptions } from '@src/providers/types.ts';

/** Parsed JSON result from provider CLI --output-format json */
export interface ProviderJsonResult {
  type: string;
  subtype: string;
  is_error: boolean;
  result: string;
  session_id: string;
  duration_ms: number;
  total_cost_usd: number;
  num_turns: number;
}

export class SpawnError extends Error {
  public readonly stderr: string;
  public readonly exitCode: number;
  public readonly rateLimited: boolean;
  public readonly retryAfterMs: number | null;
  /** Session ID if available (for resume after rate limit) */
  public readonly sessionId: string | null;

  constructor(
    message: string,
    stderr: string,
    exitCode: number,
    sessionId?: string | null,
    provider?: ProviderAdapter
  ) {
    super(message);
    this.name = 'SpawnError';
    this.stderr = stderr;
    this.exitCode = exitCode;
    this.sessionId = sessionId ?? null;
    const rl = provider ? provider.detectRateLimit(stderr) : detectRateLimitFallback(stderr);
    this.rateLimited = rl.rateLimited;
    this.retryAfterMs = rl.retryAfterMs;
  }
}

/**
 * Fallback rate limit detection (used when no provider is available).
 */
function detectRateLimitFallback(stderr: string): { rateLimited: boolean; retryAfterMs: number | null } {
  const patterns = [/rate.?limit/i, /\b429\b/, /too many requests/i, /overloaded/i, /\b529\b/];
  const isRateLimited = patterns.some((p) => p.test(stderr));
  if (!isRateLimited) {
    return { rateLimited: false, retryAfterMs: null };
  }
  const retryMatch = /retry.?after:?\s*(\d+)/i.exec(stderr);
  const retryAfterMs = retryMatch?.[1] ? parseInt(retryMatch[1], 10) * 1000 : null;
  return { rateLimited: true, retryAfterMs };
}

/**
 * Detect rate limit signals in stderr output.
 * @deprecated Use provider.detectRateLimit() instead.
 */
export function detectRateLimit(stderr: string): { rateLimited: boolean; retryAfterMs: number | null } {
  return detectRateLimitFallback(stderr);
}

/**
 * Parse JSON output from provider CLI --output-format json.
 * @deprecated Use provider.parseJsonOutput() instead.
 */
export function parseJsonOutput(stdout: string): { result: string; sessionId: string | null } {
  try {
    const parsed = JSON.parse(stdout) as Partial<ProviderJsonResult>;
    return {
      result: parsed.result ?? stdout,
      sessionId: parsed.session_id ?? null,
    };
  } catch {
    return { result: stdout, sessionId: null };
  }
}

/**
 * Spawn AI CLI for interactive session.
 *
 * Starts a single interactive session with an optional initial prompt.
 * The prompt is passed as a CLI argument, keeping everything in one session.
 * User sees and interacts with the AI directly in the terminal.
 *
 * @param prompt - Optional initial prompt to start the session with.
 * @param options - Spawn options (cwd, args, env).
 * @param provider - Provider adapter (defaults to active provider resolved from config).
 */
export function spawnInteractive(
  prompt: string,
  options: SpawnSyncOptions,
  provider?: ProviderAdapter
): { code: number; error?: string } {
  assertSafeCwd(options.cwd);

  // If no provider given, use a synchronous fallback (claude) since we can't await here
  const p =
    provider ??
    ({
      binary: 'claude',
      baseArgs: ['--permission-mode', 'acceptEdits'],
      buildInteractiveArgs: (pr: string, extra: string[] = []) => [
        ...['--permission-mode', 'acceptEdits'],
        ...extra,
        '--',
        pr,
      ],
    } as Pick<ProviderAdapter, 'binary' | 'baseArgs' | 'buildInteractiveArgs'>);

  const args = prompt ? p.buildInteractiveArgs(prompt, options.args ?? []) : [...p.baseArgs, ...(options.args ?? [])];

  const env = options.env ? { ...process.env, ...options.env } : undefined;

  const result = spawnSync(p.binary, args, {
    cwd: options.cwd,
    stdio: 'inherit',
    env,
  });

  if (result.error) {
    return { code: 1, error: `Failed to spawn ${p.binary} CLI: ${result.error.message}` };
  }

  return { code: result.status ?? 1 };
}

/**
 * Spawn AI CLI in print mode for headless execution.
 * Captures stdout and returns the text result.
 *
 * Uses --output-format json internally to capture session IDs.
 * The returned string is the extracted `result` field from the JSON output.
 */
export async function spawnHeadless(
  options: SpawnAsyncOptions & { prompt?: string },
  provider?: ProviderAdapter
): Promise<string> {
  const result = await spawnHeadlessRaw(options as HeadlessSpawnOptions, provider);
  return result.stdout;
}

/**
 * Low-level headless spawn returning structured result.
 *
 * Uses --output-format json to capture session_id for resumability.
 * Extracts the text result from JSON and returns it in stdout.
 * Session ID is available in the returned SpawnResult.
 *
 * Throws SpawnError on non-zero exit (includes rate limit detection + session ID).
 */
export async function spawnHeadlessRaw(
  options: HeadlessSpawnOptions,
  provider?: ProviderAdapter
): Promise<SpawnResult> {
  assertSafeCwd(options.cwd);
  const p = provider ?? (await getActiveProvider());

  return new Promise((resolve, reject) => {
    const allArgs = p.buildHeadlessArgs(options.args ?? []);

    // Add --resume if resuming a session (validate format to prevent argument injection)
    if (options.resumeSessionId) {
      if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/.test(options.resumeSessionId)) {
        reject(new SpawnError('Invalid session ID format', '', 1, null, p));
        return;
      }
      allArgs.push('--resume', options.resumeSessionId);
    }

    const child = spawn(p.binary, allArgs, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env ? { ...process.env, ...options.env } : undefined,
    });

    // Register child with ProcessManager for signal handling
    const manager = ProcessManager.getInstance();
    try {
      manager.registerChild(child);
    } catch {
      reject(new SpawnError('Cannot spawn during shutdown', '', 1, null, p));
      return;
    }

    // Write prompt to stdin if provided, then close
    const MAX_PROMPT_SIZE = 1_000_000; // 1MB
    if (options.prompt) {
      if (options.prompt.length > MAX_PROMPT_SIZE) {
        reject(new SpawnError('Prompt exceeds maximum size (1MB)', '', 1, null, p));
        return;
      }
      child.stdin.write(options.prompt);
    }
    child.stdin.end();

    let rawStdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      rawStdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      void (async () => {
        const exitCode = code ?? 1;

        // Parse output to extract result text and session ID.
        // For Claude: JSON output contains session_id directly.
        // For Copilot: plain text output; session ID captured via --share file.
        const { result, sessionId: parsedSessionId } = p.parseJsonOutput(rawStdout);
        const sessionId = parsedSessionId ?? (await p.extractSessionId?.(options.cwd)) ?? null;

        if (exitCode !== 0) {
          reject(
            new SpawnError(
              `${p.displayName} CLI exited with code ${String(exitCode)}: ${stderr}`,
              stderr,
              exitCode,
              sessionId,
              p
            )
          );
        } else {
          resolve({ stdout: result, stderr, exitCode: 0, sessionId });
        }
      })().catch((err: unknown) => {
        reject(new SpawnError(`Unexpected error in close handler: ${String(err)}`, '', 1, null, p));
      });
    });

    child.on('error', (err) => {
      reject(new SpawnError(`Failed to spawn ${p.binary} CLI: ${err.message}`, '', 1, null, p));
    });
  });
}

const DEFAULT_MAX_RETRIES = 5;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 120_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 600_000; // 10 minutes across all retries

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(): number {
  return Math.floor(Math.random() * 1000);
}

/**
 * Spawn AI CLI with automatic retry on rate limit errors.
 * Uses exponential backoff with jitter.
 *
 * On rate limit failures, automatically resumes the session using the
 * captured session ID so the AI picks up where it left off.
 */
export async function spawnWithRetry(
  options: HeadlessSpawnOptions,
  retryOptions?: {
    maxRetries?: number;
    totalTimeoutMs?: number;
    onRetry?: (attempt: number, delayMs: number, error: SpawnError) => void;
  },
  provider?: ProviderAdapter
): Promise<SpawnResult> {
  const p = provider ?? (await getActiveProvider());
  const maxRetries = retryOptions?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const totalTimeoutMs = retryOptions?.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const startTime = Date.now();
  let resumeSessionId = options.resumeSessionId;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Check total elapsed time before each attempt
    const elapsed = Date.now() - startTime;
    if (attempt > 0 && elapsed >= totalTimeoutMs) {
      throw new SpawnError(`Total retry timeout exceeded (${String(totalTimeoutMs)}ms)`, '', 1, resumeSessionId, p);
    }

    try {
      return await spawnHeadlessRaw({ ...options, resumeSessionId }, p);
    } catch (err) {
      if (!(err instanceof SpawnError) || !err.rateLimited) {
        throw err;
      }

      // Capture session ID for resume on next attempt
      if (err.sessionId) {
        resumeSessionId = err.sessionId;
      }

      if (attempt >= maxRetries) {
        throw err;
      }

      const delay = Math.min(err.retryAfterMs ?? BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS) + jitter();
      retryOptions?.onRetry?.(attempt + 1, delay, err);
      await sleep(delay);
    }
  }

  // Unreachable, but satisfies TypeScript
  throw new Error('Max retries exceeded');
}
