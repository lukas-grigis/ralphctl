import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { crossPlatformSpawn } from '@src/integration/io/cross-platform-spawn.ts';

/**
 * Test seam shared by every interactive provider adapter — same shape as
 * `node:child_process.spawn` with `stdio: 'inherit'` (the user owns the terminal during the
 * session, so the spawn options are fixed: no piping, no detachment).
 *
 * Lives in `_engine/` so each per-tool `interactive.ts` (claude/copilot/codex) consumes one
 * canonical type and tests can build a fake without duplicating the signature three times.
 */
export type InteractiveSpawn = (
  command: string,
  args: readonly string[],
  options: {
    readonly stdio: 'inherit';
    readonly cwd: string;
    /**
     * Extra environment entries for a CLI that takes launch configuration through the environment
     * rather than through flags. These are OVERRIDES — merging them over `process.env` is
     * {@link defaultInteractiveSpawn}'s job, so a test fake sees exactly what the adapter declared
     * rather than the whole merged environment. OpenCode is the
     * only one today: it has no `--add-dir`, so the directory grant that lets it read the prompt
     * file arrives as `OPENCODE_CONFIG_CONTENT`. Absent for every other adapter, which then
     * inherits the parent environment untouched.
     */
    readonly env?: Readonly<Record<string, string>>;
  }
) => ChildProcess;

/**
 * Default `InteractiveSpawn` — routes through `crossPlatformSpawn` so `claude.cmd` shims resolve
 * on Windows and the positional prompt arg (which may contain spaces / shell metacharacters) is
 * escaped correctly without a shell. Each interactive adapter carried a byte-identical local copy;
 * this is the one shared impl. Tests inject a fake `spawn` to avoid launching a real binary.
 *
 * `env` is LAYERED over `process.env` rather than replacing it — a child launched with a bare
 * override would lose PATH, HOME, and the provider's own credential variables.
 */
export const defaultInteractiveSpawn: InteractiveSpawn = (command, args, options) =>
  crossPlatformSpawn(command, args, {
    stdio: options.stdio,
    cwd: options.cwd,
    ...(options.env !== undefined ? { env: { ...process.env, ...options.env } } : {}),
  });

/** Default prompt-file reader shared by the interactive adapters (tests inject a fake `readFile`). */
export const defaultReadFile = (path: string): Promise<string> => fs.readFile(path, 'utf8');
