import { spawn, spawnSync } from 'node:child_process';
import { ProcessManager } from '@src/claude/process-manager.ts';
import { assertSafeCwd } from '@src/utils/paths.ts';

/**
 * Base args for Claude CLI invocation.
 * - acceptEdits: Allow file edits without prompting
 */
const BASE_ARGS = ['--permission-mode', 'acceptEdits'];

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

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Session ID from Claude CLI (available with --output-format json) */
  sessionId: string | null;
}

/** Parsed JSON result from Claude CLI --output-format json */
export interface ClaudeJsonResult {
  type: string;
  subtype: string;
  is_error: boolean;
  result: string;
  session_id: string;
  duration_ms: number;
  total_cost_usd: number;
  num_turns: number;
}

export class ClaudeSpawnError extends Error {
  public readonly stderr: string;
  public readonly exitCode: number;
  public readonly rateLimited: boolean;
  public readonly retryAfterMs: number | null;
  /** Session ID if available (for resume after rate limit) */
  public readonly sessionId: string | null;

  constructor(message: string, stderr: string, exitCode: number, sessionId?: string | null) {
    super(message);
    this.name = 'ClaudeSpawnError';
    this.stderr = stderr;
    this.exitCode = exitCode;
    this.sessionId = sessionId ?? null;
    const rl = detectRateLimit(stderr);
    this.rateLimited = rl.rateLimited;
    this.retryAfterMs = rl.retryAfterMs;
  }
}

/**
 * Detect rate limit signals in stderr output.
 */
export function detectRateLimit(stderr: string): { rateLimited: boolean; retryAfterMs: number | null } {
  const patterns = [/rate.?limit/i, /\b429\b/, /too many requests/i, /overloaded/i, /\b529\b/];

  const isRateLimited = patterns.some((p) => p.test(stderr));
  if (!isRateLimited) {
    return { rateLimited: false, retryAfterMs: null };
  }

  // Try to parse retry-after value
  const retryMatch = /retry.?after:?\s*(\d+)/i.exec(stderr);
  const retryAfterMs = retryMatch?.[1] ? parseInt(retryMatch[1], 10) * 1000 : null;

  return { rateLimited: true, retryAfterMs };
}

/**
 * Parse JSON output from Claude CLI --output-format json.
 * Returns the parsed result and session_id, or falls back to raw stdout.
 */
export function parseClaudeJsonOutput(stdout: string): { result: string; sessionId: string | null } {
  try {
    const parsed = JSON.parse(stdout) as Partial<ClaudeJsonResult>;
    return {
      result: parsed.result ?? stdout,
      sessionId: parsed.session_id ?? null,
    };
  } catch {
    // Not valid JSON — return raw stdout (backwards compat with text mode)
    return { result: stdout, sessionId: null };
  }
}

/**
 * Spawn Claude CLI for interactive session.
 *
 * Starts a single interactive session with an optional initial prompt.
 * The prompt is passed as a CLI argument, keeping everything in one session.
 * User sees and interacts with Claude directly in the terminal.
 *
 * @param prompt - Optional initial prompt to start the session with.
 */
export function spawnClaudeInteractive(prompt: string, options: SpawnSyncOptions): { code: number; error?: string } {
  assertSafeCwd(options.cwd);
  const baseArgs = [...BASE_ARGS, ...(options.args ?? [])];
  const env = options.env ? { ...process.env, ...options.env } : undefined;

  // Build args: base args, then prompt as final argument if provided
  // Use '--' separator so variadic options (like --add-dir) don't consume the prompt
  const args = prompt ? [...baseArgs, '--', prompt] : baseArgs;

  const result = spawnSync('claude', args, {
    cwd: options.cwd,
    stdio: 'inherit',
    env,
  });

  if (result.error) {
    return { code: 1, error: `Failed to spawn claude CLI: ${result.error.message}` };
  }

  return { code: result.status ?? 1 };
}

/**
 * Spawn Claude CLI in print mode for headless execution.
 * Captures stdout and returns the text result.
 *
 * Uses --output-format json internally to capture session IDs.
 * The returned string is the extracted `result` field from the JSON output.
 */
export async function spawnClaudeHeadless(options: SpawnAsyncOptions & { prompt?: string }): Promise<string> {
  const result = await spawnClaudeHeadlessRaw(options);
  return result.stdout;
}

export interface HeadlessSpawnOptions extends SpawnAsyncOptions {
  prompt?: string;
  /** Resume a previous session by ID */
  resumeSessionId?: string;
}

/**
 * Low-level headless spawn returning structured result.
 *
 * Uses --output-format json to capture session_id for resumability.
 * Extracts the text result from JSON and returns it in stdout.
 * Session ID is available in the returned SpawnResult.
 *
 * Throws ClaudeSpawnError on non-zero exit (includes rate limit detection + session ID).
 */
export async function spawnClaudeHeadlessRaw(options: HeadlessSpawnOptions): Promise<SpawnResult> {
  assertSafeCwd(options.cwd);
  return new Promise((resolve, reject) => {
    // Build args: -p for print mode, --output-format json for session tracking
    const allArgs = ['-p', '--output-format', 'json', ...BASE_ARGS, ...(options.args ?? [])];

    // Add --resume if resuming a session
    if (options.resumeSessionId) {
      allArgs.push('--resume', options.resumeSessionId);
    }

    const child = spawn('claude', allArgs, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env ? { ...process.env, ...options.env } : undefined,
    });

    // Register child with ProcessManager for signal handling
    const manager = ProcessManager.getInstance();
    try {
      manager.registerChild(child);
    } catch {
      reject(new ClaudeSpawnError('Cannot spawn during shutdown', '', 1));
      return;
    }

    // Write prompt to stdin if provided, then close
    const MAX_PROMPT_SIZE = 1_000_000; // 1MB
    if (options.prompt) {
      if (options.prompt.length > MAX_PROMPT_SIZE) {
        reject(new ClaudeSpawnError('Prompt exceeds maximum size (1MB)', '', 1));
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
      const exitCode = code ?? 1;

      // Parse JSON output to extract result text and session ID
      const { result, sessionId } = parseClaudeJsonOutput(rawStdout);

      if (exitCode !== 0) {
        // Also check stderr for rate limit info, include session ID for resume
        reject(
          new ClaudeSpawnError(
            `Claude CLI exited with code ${String(exitCode)}: ${stderr}`,
            stderr,
            exitCode,
            sessionId
          )
        );
      } else {
        resolve({ stdout: result, stderr, exitCode: 0, sessionId });
      }
    });

    child.on('error', (err) => {
      reject(new ClaudeSpawnError(`Failed to spawn claude CLI: ${err.message}`, '', 1));
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
 * Spawn Claude CLI with automatic retry on rate limit errors.
 * Uses exponential backoff with jitter.
 *
 * On rate limit failures, automatically resumes the session using the
 * captured session ID so Claude picks up where it left off.
 */
export async function spawnClaudeWithRetry(
  options: HeadlessSpawnOptions,
  retryOptions?: {
    maxRetries?: number;
    totalTimeoutMs?: number;
    onRetry?: (attempt: number, delayMs: number, error: ClaudeSpawnError) => void;
  }
): Promise<SpawnResult> {
  const maxRetries = retryOptions?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const totalTimeoutMs = retryOptions?.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const startTime = Date.now();
  let resumeSessionId = options.resumeSessionId;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Check total elapsed time before each attempt
    const elapsed = Date.now() - startTime;
    if (attempt > 0 && elapsed >= totalTimeoutMs) {
      throw new ClaudeSpawnError(`Total retry timeout exceeded (${String(totalTimeoutMs)}ms)`, '', 1, resumeSessionId);
    }

    try {
      return await spawnClaudeHeadlessRaw({ ...options, resumeSessionId });
    } catch (err) {
      if (!(err instanceof ClaudeSpawnError) || !err.rateLimited) {
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
