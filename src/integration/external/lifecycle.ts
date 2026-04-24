import { spawn } from 'node:child_process';
import { assertSafeCwd } from '@src/integration/persistence/paths.ts';

/** Lifecycle events where hooks can fire. Extend this union for new phases. */
export type LifecycleEvent = 'sprintStart' | 'taskComplete';

interface HookResult {
  passed: boolean;
  output: string;
}

/** Default timeout for lifecycle hooks: 5 minutes. Override via RALPHCTL_SETUP_TIMEOUT_MS. */
const DEFAULT_HOOK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Hard cap on combined stdout+stderr buffered in memory (50 MB).
 *
 * Replaces Node's silent 1 MB default on `spawnSync` / `execFile` — real-world
 * check scripts like `mvn clean install` on a Spring/Hibernate backend can
 * emit 5-10 MB legitimately. If the cap is hit we kill the child and surface
 * an explicit truncation marker rather than letting the overflow manifest as
 * a spurious "check failed".
 */
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

function getHookTimeoutMs(): number {
  const envVal = process.env['RALPHCTL_SETUP_TIMEOUT_MS'];
  if (envVal) {
    const parsed = Number(envVal);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_HOOK_TIMEOUT_MS;
}

/**
 * Run a lifecycle hook script in a project directory.
 *
 * Scripts are user-configured via `project add` or `project repo add` —
 * they are NOT arbitrary AI-generated commands.
 *
 * Streams stdout/stderr to in-memory buffers (no 1 MB `maxBuffer` cap from
 * `spawnSync` — see `MAX_OUTPUT_BYTES`). Kills the child on timeout or when
 * the output cap is exceeded and surfaces an explicit marker in `output`.
 */
export function runLifecycleHook(
  projectPath: string,
  script: string,
  event: LifecycleEvent,
  timeoutOverrideMs?: number
): Promise<HookResult> {
  assertSafeCwd(projectPath);
  const timeoutMs = timeoutOverrideMs ?? getHookTimeoutMs();

  return new Promise<HookResult>((resolve) => {
    const child = spawn(script, {
      cwd: projectPath,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, RALPHCTL_LIFECYCLE_EVENT: event },
    });

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let timedOut = false;
    let capExceeded = false;
    let settled = false;

    const appendChunk = (chunk: Buffer): void => {
      if (capExceeded) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_OUTPUT_BYTES) {
        capExceeded = true;
        child.kill('SIGTERM');
        return;
      }
      chunks.push(chunk);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      appendChunk(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      appendChunk(chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    const finish = (passed: boolean, suffix?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const base = Buffer.concat(chunks).toString('utf-8').trim();
      const output = suffix ? (base ? `${base}\n${suffix}` : suffix) : base;
      resolve({ passed, output });
    };

    child.on('error', (err) => {
      // Spawn failure (e.g. shell missing). Surface the error message.
      finish(false, `[spawn error: ${err.message}]`);
    });

    child.on('close', (code) => {
      if (timedOut) {
        finish(false, `[timeout exceeded after ${String(timeoutMs)}ms]`);
        return;
      }
      if (capExceeded) {
        finish(false, `[output exceeded ${String(MAX_OUTPUT_BYTES)} byte cap — truncated]`);
        return;
      }
      finish(code === 0);
    });
  });
}
