/**
 * Fork a detached child process that survives the originating terminal.
 *
 * The daemon's stdout + stderr are appended to a log file; stdin is closed.
 * `child.unref()` lets the parent's event loop exit immediately even though
 * the daemon is still running, which is what makes the parent's terminal
 * disconnect (or normal `process.exit`) safe for the daemon.
 *
 * The Node binary that launched this process (`process.execPath` plus
 * `process.execArgv` for loader hooks like tsx) is reused for the child so
 * the daemon runs under the same runtime as the parent. The CLI entrypoint
 * defaults to `process.argv[1]` — the script the parent was invoked with —
 * so detached spawns work identically in dev (tsx + entrypoint.ts) and
 * production (node + dist/cli.mjs).
 */

import { spawn as defaultSpawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DaemonSpawnOptions {
  /** CLI args passed after the script path (e.g. ['sprint', '__daemon-run', sprintId, ...]). */
  readonly args: readonly string[];
  /** Absolute path to the log file. stdout + stderr are appended here. */
  readonly logPath: string;
  /** Override the CLI script path. Defaults to `process.argv[1]`. */
  readonly cliScript?: string;
  /** Override the Node executable. Defaults to `process.execPath`. */
  readonly nodeBin?: string;
  /** Forward `process.execArgv` (loader hooks etc.). Defaults to true. */
  readonly inheritExecArgv?: boolean;
  /** Override env. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Override `child_process.spawn` (for tests). */
  readonly spawnFn?: SpawnFn;
  /** Override file descriptor opener (for tests). */
  readonly openLogFd?: (logPath: string) => number;
}

export interface DaemonSpawnResult {
  readonly pid: number;
}

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: ['ignore', number, number]; env: NodeJS.ProcessEnv }
) => ChildProcess;

function defaultOpenLogFd(logPath: string): number {
  mkdirSync(dirname(logPath), { recursive: true });
  return openSync(logPath, 'a');
}

/**
 * Resolve the CLI script the parent process is currently executing. The
 * daemon needs the same script so its CLI surface matches (commands,
 * argument parsing, version).
 */
export function resolveCliScript(): string {
  const argv1 = process.argv[1];
  if (!argv1) {
    throw new Error('Cannot resolve CLI script — process.argv[1] is unset');
  }
  return argv1;
}

export function spawnDaemon(options: DaemonSpawnOptions): DaemonSpawnResult {
  const open = options.openLogFd ?? defaultOpenLogFd;
  const logFd = open(options.logPath);
  const node = options.nodeBin ?? process.execPath;
  const cliScript = options.cliScript ?? resolveCliScript();
  const inheritExecArgv = options.inheritExecArgv !== false;
  const execArgv = inheritExecArgv ? process.execArgv : [];
  const allArgs = [...execArgv, cliScript, ...options.args];
  const spawnImpl: SpawnFn = options.spawnFn ?? defaultSpawn;
  const env = options.env ?? process.env;

  const child = spawnImpl(node, allArgs, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env,
  });

  if (typeof child.pid !== 'number') {
    throw new Error('Failed to spawn daemon: no pid');
  }
  child.unref();
  return { pid: child.pid };
}
