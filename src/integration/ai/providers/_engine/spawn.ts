import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { crossPlatformSpawn } from '@src/integration/io/cross-platform-spawn.ts';

/**
 * Narrowed signature of `node:child_process.spawn` shared by every provider adapter.
 * Tests inject a fake to script stdout / stderr / exit codes without launching a real
 * binary. Each provider's `Deps` exposes a `spawn?: ProviderSpawn` optional override.
 *
 * `cwd` is the child's working directory. Provider context-file autoload
 * (`CLAUDE.md` / `.github/copilot-instructions.md` / `AGENTS.md`), skills auto-discovery,
 * agents, and `.mcp.json` all key off the child's `process.cwd()` — never off
 * `--add-dir` roots. Adapters MUST forward `AiSession.cwd` here so context-file autoload
 * works; the Codex adapter additionally passes `-C <cwd>` argv because the Codex CLI
 * derives some implicit behaviour from its argv-supplied cwd rather than its OS-level
 * process cwd. Optional so test fakes that drop the argument remain assignment-compatible.
 */
export type ProviderSpawn = (
  command: string,
  args: readonly string[],
  options: { readonly stdio: readonly ['pipe', 'pipe', 'pipe']; readonly cwd?: string }
) => ChildProcessWithoutNullStreams;

/**
 * Default `ProviderSpawn` backed by `crossPlatformSpawn`. Each headless adapter carried a
 * byte-identical local copy as its `deps.spawn ?? defaultSpawn` fallback; this is the one shared
 * impl. Tests still inject a fake `spawn` to avoid launching a real binary.
 */
export const defaultProviderSpawn: ProviderSpawn = (command, args, options) =>
  crossPlatformSpawn(command, args, {
    stdio: [...options.stdio],
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  }) as ChildProcessWithoutNullStreams;
