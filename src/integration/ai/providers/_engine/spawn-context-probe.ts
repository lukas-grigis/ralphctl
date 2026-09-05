/**
 * A snapshot of what the harness is about to hand an interactive CLI, written to disk in the
 * instant before the spawn.
 *
 * Why this exists: an interactive session is spawned `stdio: 'inherit'`, so the harness gives the
 * child its terminal and can observe nothing afterwards. When a child freezes during its own
 * startup there is no stdout to read, no exit code, and — as the Grok black-screen hang showed —
 * not necessarily any log from the child either, because it can freeze before it opens one.
 *
 * A bisect established that the argv is not the difference: the exact command the harness builds,
 * run by hand from a shell in the same directory, starts every time. What is left is the spawn
 * CONTEXT — the environment, the state of the three standard streams, and what the parent has
 * left attached to stdin. This file records that, and nothing else can outrun it: the write is
 * synchronous and happens before `spawn` is called, so even a child that hangs instantly still
 * leaves a complete account of the conditions it was handed.
 *
 * It is written for every interactive backend, not just the one that misbehaves — the whole point
 * is to be able to diff a healthy Claude spawn against a frozen Grok one.
 *
 * SECRETS: environment VALUES are not written. Provider credentials, tokens and API keys live in
 * the environment this process inherits, and this file lands in the sprint data directory, so only
 * the sorted list of variable NAMES is recorded plus the values of {@link SAFE_ENV_KEYS} — the
 * terminal- and runtime-describing variables that are the point of the exercise and carry no
 * secrets. A name list is enough to spot a variable that is present in one spawn and absent in
 * another, which is the comparison this is for.
 *
 * Best-effort throughout: a diagnostic must never be the reason a session fails to start.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Basename of the snapshot, dropped beside `outputFile` and the session-id mirror. */
export const SPAWN_CONTEXT_FILENAME = 'spawn-context.json';

/**
 * Environment variables whose VALUES are safe to record and worth comparing: they describe the
 * terminal, the locale, and the Node runtime. Everything outside this list contributes its name
 * only. Deliberately conservative — a variable earns a place here by being useless to an attacker
 * and useful in a diff.
 */
const SAFE_ENV_KEYS: readonly string[] = [
  'TERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'COLORTERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SHELL',
  'SHLVL',
  'NODE_ENV',
  'NODE_OPTIONS',
  'COLUMNS',
  'LINES',
  'CI',
  'FORCE_COLOR',
  'NO_COLOR',
  'TMPDIR',
];

interface StreamSnapshot {
  readonly isTTY: boolean;
  readonly columns?: number;
  readonly rows?: number;
}

const snapshotOutput = (stream: NodeJS.WriteStream): StreamSnapshot => ({
  isTTY: stream.isTTY === true,
  ...(typeof stream.columns === 'number' ? { columns: stream.columns } : {}),
  ...(typeof stream.rows === 'number' ? { rows: stream.rows } : {}),
});

/**
 * What the parent still has attached to stdin. This is the half that matters most: the child is
 * about to read the same file descriptor, and anything the parent has left listening competes for
 * the bytes a terminal sends back in reply to the child's capability queries.
 */
const snapshotStdin = (): Record<string, unknown> => {
  const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean };
  const safe = <T>(read: () => T): T | 'unavailable' => {
    try {
      return read();
    } catch {
      return 'unavailable' as const;
    }
  };
  return {
    isTTY: stdin.isTTY === true,
    isRaw: stdin.isRaw ?? null,
    isPaused: safe(() => stdin.isPaused()),
    readableFlowing: stdin.readableFlowing ?? null,
    // A non-zero count here means the parent is still consuming the child's terminal.
    listeners: {
      data: safe(() => stdin.listenerCount('data')),
      readable: safe(() => stdin.listenerCount('readable')),
      keypress: safe(() => stdin.listenerCount('keypress')),
    },
  };
};

export interface SpawnContextInput {
  readonly providerName: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The snapshot lands in this file's directory, beside the session's other artifacts. */
  readonly outputFile: string;
  /** Environment overrides the adapter declared, if any — recorded by name only, same as the rest. */
  readonly envOverrides?: Readonly<Record<string, string>> | undefined;
}

/**
 * Write the snapshot. Synchronous on purpose — an `await` here would let the spawn race the write
 * on a child that freezes immediately, and it previously broke the shared interactive-port
 * conformance suite, whose contract is that `run()` reaches `spawn` without yielding.
 */
export const recordSpawnContext = (input: SpawnContextInput): void => {
  try {
    const env = process.env;
    const snapshot = {
      at: new Date().toISOString(),
      provider: input.providerName,
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      node: { version: process.version, pid: process.pid, ppid: process.ppid, platform: process.platform },
      stdout: snapshotOutput(process.stdout),
      stderr: snapshotOutput(process.stderr),
      stdin: snapshotStdin(),
      env: {
        note: 'values are recorded only for terminal/runtime variables; everything else is names only',
        values: Object.fromEntries(SAFE_ENV_KEYS.filter((k) => env[k] !== undefined).map((k) => [k, env[k]] as const)),
        names: Object.keys(env).sort(),
        overrideNames: Object.keys(input.envOverrides ?? {}).sort(),
      },
    };
    writeFileSync(
      join(dirname(input.outputFile), SPAWN_CONTEXT_FILENAME),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      'utf8'
    );
  } catch {
    // A diagnostic must never be the reason a session fails to start.
  }
};
