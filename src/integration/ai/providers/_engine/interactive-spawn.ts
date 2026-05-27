import type { ChildProcess } from 'node:child_process';

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
