import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Narrowed signature of `node:child_process.spawn` for the external runners (git, shell
 * scripts, editor). Sibling to `integration/ai/providers/spawn.ts:ProviderSpawn` — kept
 * separate because external runners need `cwd` (and may need `env`/`shell`/`detached`),
 * while AI providers pass cwd as a CLI argument and only need stdio.
 *
 * Tests inject a fake to script stdout / stderr / exit codes without launching a real
 * binary.
 */
export type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcessWithoutNullStreams;

export interface SpawnOptions {
  readonly stdio: readonly ['pipe', 'pipe', 'pipe'];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly shell?: boolean;
  readonly detached?: boolean;
}
