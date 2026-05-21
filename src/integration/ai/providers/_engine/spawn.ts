import type { ChildProcessWithoutNullStreams } from 'node:child_process';

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
