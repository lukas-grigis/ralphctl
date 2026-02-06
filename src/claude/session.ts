import { spawn, spawnSync } from 'node:child_process';

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
  onSignal?: () => void;
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
 * Captures stdout and returns it. Claude runs autonomously without user interaction.
 *
 * The prompt should be passed via stdin for large content (like file references).
 * BASE_ARGS (--permission-mode acceptEdits) are automatically prepended.
 *
 * @param options.prompt - Prompt to send via stdin (preferred for large content)
 */
export async function spawnClaudeHeadless(options: SpawnAsyncOptions & { prompt?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    // Build args: -p for print mode, then base args, then any extra args
    const allArgs = ['-p', ...BASE_ARGS, ...(options.args ?? [])];

    const child = spawn('claude', allArgs, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env ? { ...process.env, ...options.env } : undefined,
    });

    // Write prompt to stdin if provided, then close
    if (options.prompt) {
      child.stdin.write(options.prompt);
    }
    child.stdin.end();

    // Kill child process on parent abort
    const cleanup = () => {
      options.onSignal?.();
      child.kill('SIGTERM');
    };
    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      process.off('SIGINT', cleanup);
      process.off('SIGTERM', cleanup);
      if (code !== 0) {
        reject(new Error(`Claude CLI exited with code ${code !== null ? String(code) : 'null'}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });

    child.on('error', (err) => {
      process.off('SIGINT', cleanup);
      process.off('SIGTERM', cleanup);
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
    });
  });
}
