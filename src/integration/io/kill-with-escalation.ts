import type { ChildProcess } from 'node:child_process';
import { killProcessTree, processGroupOf } from '@src/integration/io/kill-process-tree.ts';

/**
 * SIGTERM → grace → SIGKILL grace window. Mirrors the AI-provider engine's `DEFAULT_GRACE_MS`
 * (`idle-watchdog.ts` / `abort-kill.ts`) so every external-process kill in the codebase escalates
 * on the same 10s cadence. Kept separate from the provider constant because this seam lives in
 * `integration/io/` (git / gh / probe runners), which must not import the AI-provider engine
 * (sibling isolation).
 */
export const DEFAULT_KILL_GRACE_MS = 10_000;

/**
 * Escalating child-process kill for the external-command runners (`run-cli`, `run-command`,
 * `git-runner`). Sends `SIGTERM` immediately, then `SIGKILL` after `graceMs` — to the child's whole
 * process group when it leads one, else to the child alone.
 *
 * Why: a `git` / `gh` child that traps or ignores SIGTERM would otherwise linger and can hold
 * `.git/index.lock` indefinitely, wedging every later git operation. This mirrors the
 * SIGTERM→grace→SIGKILL ladder the AI-provider engine uses (`installIdleWatchdog` /
 * `attachAbortKill`).
 *
 * This does NOT delay the caller's resolution; it only guarantees the child eventually dies. The
 * escalation timer is `unref`'d so it never keeps the event loop (or a test worker) alive on its
 * own. A lone child's escalation is cleared the moment it emits `exit`, so a recycled pid is never
 * signalled; a group's is not, because a hook the leader forked can outlive it.
 */
export const killWithEscalation = (child: ChildProcess, graceMs: number = DEFAULT_KILL_GRACE_MS): void => {
  killProcessTree(child, 'SIGTERM');
  const escalation = setTimeout(() => {
    killProcessTree(child, 'SIGKILL');
  }, graceMs);
  escalation.unref();
  if (processGroupOf(child) === undefined) child.once('exit', () => clearTimeout(escalation));
};
