import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import { type SpawnScript, createScriptedChild } from '@src/integration/ai/providers/_engine/scripted-spawn.ts';

/**
 * Recording `ProviderSpawn` fake for the headless adapter suites.
 *
 * The fabrication half lives in `src/integration/ai/providers/_engine/scripted-spawn.ts` — the
 * shipped demo replays a canned transcript through the same builder, so a divergence between what
 * the tests exercise and what a first-run user sees is impossible by construction. What stays here
 * is the part only a test wants: a per-call log of everything the adapter handed the spawn.
 *
 * `stdin` and `kills` are the two fields no per-file fake had. Without `stdin` the port contract
 * "the prompt travels on stdin, never inlined into argv" is only half-assertable (argv can be
 * checked, delivery cannot). Without `kills` the `SIGTERM → grace → SIGKILL` ladder is invisible,
 * because a fake whose `kill()` discards its argument reports the same thing for both rungs.
 *
 * @public
 */
export interface ProviderSpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Everything written to the child's stdin, concatenated. Empty when the adapter piped nothing. */
  readonly stdin: string;
  /** Signals sent to this child, in order. */
  readonly kills: readonly NodeJS.Signals[];
}

/** @public */
export interface RecordingProviderSpawn {
  readonly spawn: ProviderSpawn;
  readonly calls: readonly ProviderSpawnCall[];
}

/**
 * What the caller was handed when the chooser picks a script. `index` is the zero-based spawn
 * number, which is what a retry / resume assertion keys off.
 *
 * @public
 */
export interface ProviderSpawnChoice {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly index: number;
}

/** @public */
export type ProviderSpawnScripts = readonly SpawnScript[] | ((choice: ProviderSpawnChoice) => SpawnScript);

/**
 * Build a `ProviderSpawn` that answers from `scripts`.
 *
 * The array form replays scripts in spawn order and repeats the last one once exhausted (so a
 * single-element array is "always answer this way", which is what most argv assertions want). The
 * function form is the one worth reaching for when the answer depends on the question — a
 * `(choice) => choice.index === 0 ? FAIL : PASS` chooser drives a real FAIL → retry → PASS loop
 * through the real adapter with no binary anywhere.
 *
 * @public
 */
export const makeProviderSpawn = (scripts: ProviderSpawnScripts = [{}]): RecordingProviderSpawn => {
  const calls: Array<{
    command: string;
    args: readonly string[];
    cwd?: string;
    stdin: string;
    kills: NodeJS.Signals[];
  }> = [];

  const pick = (choice: ProviderSpawnChoice): SpawnScript => {
    if (typeof scripts === 'function') return scripts(choice);
    return scripts[choice.index] ?? scripts.at(-1) ?? {};
  };

  const spawn: ProviderSpawn = (command, args, options) => {
    const index = calls.length;
    const call = {
      command,
      args,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      stdin: '',
      kills: [] as NodeJS.Signals[],
    };
    calls.push(call);
    return createScriptedChild(
      () => pick({ command, args, ...(options.cwd !== undefined ? { cwd: options.cwd } : {}), index }),
      {
        onStdin: (chunk) => {
          call.stdin += chunk;
        },
        onKill: (signal) => call.kills.push(signal),
      }
    );
  };

  return { spawn, calls };
};
