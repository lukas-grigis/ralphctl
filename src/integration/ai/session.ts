import { spawn, spawnSync } from 'node:child_process';
import { ProcessManager } from '@src/integration/ai/process-manager.ts';
import { assertSafeCwd } from '@src/integration/persistence/paths.ts';
import type {
  HeadlessSpawnOptions,
  SpawnAsyncOptions,
  SpawnResult,
  SpawnSyncOptions,
} from '@src/integration/ai/providers/types.ts';
import { type ProviderAdapter } from '@src/integration/ai/providers/types.ts';
import { getActiveProvider } from '@src/integration/ai/providers/registry.ts';
import { ensureError, wrapAsync } from '@src/integration/utils/result-helpers.ts';
import { SpawnError } from '@src/domain/errors.ts';

/**
 * Spawn AI CLI for interactive session.
 *
 * Starts a single interactive session with an optional initial prompt.
 * The prompt is passed as a CLI argument, keeping everything in one session.
 * User sees and interacts with the AI directly in the terminal.
 *
 * @param prompt - Optional initial prompt to start the session with.
 * @param options - Spawn options (cwd, args, env).
 * @param provider - Provider adapter (resolved from config is NOT supported — callers must pass explicitly).
 */
export function spawnInteractive(
  prompt: string,
  options: SpawnSyncOptions,
  provider: ProviderAdapter
): { code: number; error?: string } {
  assertSafeCwd(options.cwd);

  const args = prompt
    ? provider.buildInteractiveArgs(prompt, options.args ?? [])
    : [...provider.baseArgs, ...(options.args ?? [])];

  const env = options.env ? { ...process.env, ...options.env } : undefined;

  const result = spawnSync(provider.binary, args, {
    cwd: options.cwd,
    stdio: 'inherit',
    env,
  });

  if (result.error) {
    return { code: 1, error: `Failed to spawn ${provider.binary} CLI: ${result.error.message}` };
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

    // Add provider-specific resume args if resuming a session
    if (options.resumeSessionId) {
      try {
        allArgs.push(...p.buildResumeArgs(options.resumeSessionId));
      } catch {
        reject(new SpawnError('Invalid session ID format', '', 1));
        return;
      }
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
      reject(new SpawnError('Cannot spawn during shutdown', '', 1));
      return;
    }

    const MAX_STDOUT_SIZE = 10_000_000; // 10MB — guard against runaway provider output

    // Write prompt to stdin if provided, then close
    const MAX_PROMPT_SIZE = 1_000_000; // 1MB
    if (options.prompt) {
      if (options.prompt.length > MAX_PROMPT_SIZE) {
        reject(new SpawnError('Prompt exceeds maximum size (1MB)', '', 1));
        return;
      }
      child.stdin.write(options.prompt);
    }
    child.stdin.end();

    let rawStdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      if (rawStdout.length < MAX_STDOUT_SIZE) {
        rawStdout += data.toString();
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      void (async () => {
        const exitCode = code ?? 1;

        // Parse output to extract result text and session ID.
        // Both providers now use --output-format json; session ID is in JSON output.
        // extractSessionId is called as a fallback (e.g., Copilot's --share file)
        // when JSON output doesn't contain a session_id.
        const { result, sessionId: parsedSessionId, model: parsedModel } = p.parseJsonOutput(rawStdout);
        const sessionId = parsedSessionId ?? (await p.extractSessionId?.(options.cwd)) ?? null;

        if (exitCode !== 0) {
          reject(
            new SpawnError(
              `${p.displayName} CLI exited with code ${String(exitCode)}: ${stderr}`,
              stderr,
              exitCode,
              sessionId
            )
          );
        } else {
          resolve({ stdout: result, stderr, exitCode: 0, sessionId, model: parsedModel });
        }
      })().catch((err: unknown) => {
        reject(new SpawnError(`Unexpected error in close handler: ${String(err)}`, '', 1));
      });
    });

    child.on('error', (err) => {
      reject(new SpawnError(`Failed to spawn ${p.binary} CLI: ${err.message}`, '', 1));
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
      throw new SpawnError(`Total retry timeout exceeded (${String(totalTimeoutMs)}ms)`, '', 1, resumeSessionId);
    }

    const r = await wrapAsync(async () => spawnHeadlessRaw({ ...options, resumeSessionId }, p), ensureError);

    if (r.ok) return r.value;

    const err = r.error;
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

  // Unreachable, but satisfies TypeScript
  throw new Error('Max retries exceeded');
}
