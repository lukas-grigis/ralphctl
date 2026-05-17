import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Narrowed signature of `node:child_process.spawn` shared by every provider adapter.
 * Tests inject a fake to script stdout / stderr / exit codes without launching a real
 * binary. Each provider's `Deps` exposes a `spawn?: ProviderSpawn` optional override.
 */
export type ProviderSpawn = (
  command: string,
  args: readonly string[],
  options: { readonly stdio: readonly ['pipe', 'pipe', 'pipe'] }
) => ChildProcessWithoutNullStreams;
