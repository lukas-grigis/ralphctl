/**
 * In-process CLI runner for fast integration tests.
 * Runs CLI commands without spawning processes.
 */
import { Command } from 'commander';
import { registerProjectCommands } from '@src/commands/project/index.ts';
import { registerSprintCommands } from '@src/commands/sprint/index.ts';
import { registerTaskCommands } from '@src/commands/task/index.ts';
import { registerTicketCommands } from '@src/commands/ticket/index.ts';
import { registerProgressCommands } from '@src/commands/progress/index.ts';

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Create a fresh CLI program instance for testing.
 */
function createProgram(): Command {
  const program = new Command();
  program
    .name('ralphctl')
    .description('Sprint & task management for AI-assisted coding')
    .version('0.1.0')
    .configureOutput({
      // Suppress commander's internal output - we capture console.log/error instead
      writeOut: () => undefined,
      writeErr: () => undefined,
    })
    .exitOverride();

  registerProjectCommands(program);
  registerSprintCommands(program);
  registerTaskCommands(program);
  registerTicketCommands(program);
  registerProgressCommands(program);

  return program;
}

/**
 * Run CLI command in-process (no spawning).
 * Much faster than runCliSpawn - use this for all tests.
 *
 * WARNING: This function manipulates shared module-level state (process.env, console).
 * Tests running in parallel that mutate the same modules may see each other's state.
 * Use isolated test environments (RALPHCTL_ROOT) to prevent data conflicts.
 */
export async function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  // Set environment for the duration of this call
  const originalEnv = { ...process.env };
  Object.assign(process.env, env);

  // Capture console output
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  const restoreConsole = () => {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  };

  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  };

  const restoreEnv = () => {
    // Restore environment key-by-key to avoid object reference issues
    for (const key of Object.keys(env)) {
      if (key in originalEnv) {
        process.env[key] = originalEnv[key];
      } else {
        Reflect.deleteProperty(process.env, key);
      }
    }
  };

  let code = 0;

  try {
    const program = createProgram();
    await program.parseAsync(['node', 'ralphctl', ...args]);
  } catch (err) {
    // Commander throws on exitOverride
    if (err instanceof Error && 'exitCode' in err) {
      code = (err as { exitCode: number }).exitCode;
    } else if (err instanceof Error) {
      stderr.push(err.message);
      code = 1;
    } else {
      // Handle non-Error thrown values
      stderr.push(String(err));
      code = 1;
    }
  } finally {
    // Restore console and env independently to prevent cascading failures
    try {
      restoreConsole();
    } catch {
      // Ignore restoration errors
    }
    try {
      restoreEnv();
    } catch {
      // Ignore restoration errors
    }
  }

  return {
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    code,
  };
}

/**
 * Extract a field value from CLI output (e.g., "ID: abc123").
 */
export function extractField(output: string, fieldName: string): string | null {
  const regex = new RegExp(`${fieldName}:\\s+(\\S+)`);
  const match = regex.exec(output);
  return match?.[1] ?? null;
}

/**
 * Extract all task IDs from output (hex patterns).
 */
export function extractTaskIds(output: string): string[] {
  const matches = output.match(/[a-f0-9]{8}/g) ?? [];
  return [...new Set(matches)];
}
