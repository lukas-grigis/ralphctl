import spawn from 'cross-spawn';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

/**
 * The single cross-platform process-spawn primitive. Every adapter that launches an external
 * binary (`claude` / `codex` / `gh` / `glab` / `git`) MUST route through here instead of
 * calling `node:child_process.spawn` directly.
 *
 * Why this exists — Windows `.cmd` shims:
 *   npm / winget install the AI and SCM CLIs as `.cmd` (or `.ps1`) shims, not native `.exe`
 *   binaries. On Node ≥ 22 (the CVE-2024-27980 fix), a bare `spawn('claude', …)` of a
 *   `.cmd` / `.bat` file **throws `EINVAL`** unless `shell: true` is set — so direct spawns
 *   fail outright on Windows. The naive workaround (`shell: true` on win32) then re-parses
 *   argv through `cmd.exe`, which corrupts any argument containing a space
 *   (`C:\Users\First Last\repo` — the Windows norm) or a shell metacharacter (`& | % "`),
 *   and opens a command-injection seam.
 *
 *   `cross-spawn` solves both at once: it resolves the real shim target via `PATHEXT` and
 *   escapes arguments correctly **without** invoking a shell. It is the de-facto standard
 *   (npm, jest, execa all depend on it), so the Windows-quoting edge cases are handled by
 *   battle-tested code rather than re-implemented here.
 *
 * No behaviour change on macOS / Linux — cross-spawn delegates straight to
 * `child_process.spawn` for native binaries.
 *
 * The option shape mirrors `node:child_process.SpawnOptions`; callers pass their own narrowed
 * options (stdio tuple, `'inherit'`, `cwd`, `env`, `detached`, …) and cast the returned
 * `ChildProcess` to their adapter-local type, exactly as they previously did with `nodeSpawn`.
 *
 * NOTE: this is for the **binary + args** case. Running a user-authored shell command *string*
 * (e.g. `pnpm install && pnpm test` in the setup/verify-script runner) intentionally keeps
 * `shell: true` and does NOT route through here — that path needs shell interpretation.
 */
export const crossPlatformSpawn = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess =>
  spawn(command, [...args], options);
