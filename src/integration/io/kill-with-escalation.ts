import type { ChildProcess } from 'node:child_process';

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
 * `git-runner`). Sends `SIGTERM` immediately, then `SIGKILL` after `graceMs` if the child hasn't
 * exited on its own.
 *
 * Why: those runners settle their result promise the instant the timeout trips (bare
 * `child.kill('SIGTERM')`), then return. A `git` / `gh` child that traps or ignores SIGTERM is
 * therefore never reaped — it lingers and can hold `.git/index.lock` indefinitely, wedging every
 * later git operation. This mirrors the SIGTERM→grace→SIGKILL ladder the AI-provider engine
 * already uses (`installIdleWatchdog` / `attachAbortKill`) so a wedged child always dies.
 *
 * **Promise semantics are unchanged.** This does NOT delay the caller's resolution — the caller
 * settles as before; this only guarantees the child eventually dies in the background. The
 * escalation timer is `unref`'d so it never keeps the event loop (or a test worker) alive on its
 * own, and it's cleared the moment the child emits `exit` so a recycled pid is never signalled.
 */
export const killWithEscalation = (child: ChildProcess, graceMs: number = DEFAULT_KILL_GRACE_MS): void => {
  try {
    child.kill('SIGTERM');
  } catch {
    // Child may already be dead (ESRCH) — best-effort.
  }
  const escalation = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already dead — best-effort.
    }
  }, graceMs);
  // Don't hold the event loop open solely for the SIGKILL escalation — the caller has already
  // settled. If the process is otherwise exiting before the grace elapses, the reap is skipped.
  escalation.unref();
  // A child that honours SIGTERM exits before the grace elapses; cancel the pending SIGKILL so we
  // never signal a pid the OS may have recycled.
  child.once('exit', () => clearTimeout(escalation));
};
