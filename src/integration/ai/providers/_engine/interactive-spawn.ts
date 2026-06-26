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
  options: { readonly stdio: 'inherit'; readonly cwd: string }
) => ChildProcess;

/**
 * Default `InteractiveSpawn` — routes through `crossPlatformSpawn` so `claude.cmd` shims resolve
 * on Windows and the positional prompt arg (which may contain spaces / shell metacharacters) is
 * escaped correctly without a shell. Each interactive adapter carried a byte-identical local copy;
 * this is the one shared impl. Tests inject a fake `spawn` to avoid launching a real binary.
 */
export const defaultInteractiveSpawn: InteractiveSpawn = (command, args, options) =>
  crossPlatformSpawn(command, args, { stdio: options.stdio, cwd: options.cwd });

/** Default prompt-file reader shared by the interactive adapters (tests inject a fake `readFile`). */
export const defaultReadFile = (path: string): Promise<string> => fs.readFile(path, 'utf8');
