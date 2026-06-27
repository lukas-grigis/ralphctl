import type { ChildProcess } from 'node:child_process';
import { DEFAULT_GRACE_MS } from '@src/integration/ai/providers/_engine/idle-watchdog.ts';

/**
 * Wire a caller {@link AbortSignal} to a SIGTERM → grace → SIGKILL kill ladder for a
 * `stdio: 'inherit'` child (mirrors `installIdleWatchdog`'s abort path, minus idle detection).
 *
 * Shared by the interactive claude / codex / copilot adapters: each spawns with inherited stdio,
 * so the harness keeps no read-side handle on the child once `run` returns — the abort signal is
 * the only cancel lever a TUI-side stop has against a `stdio: 'inherit'` session. (Idle detection
 * is a separate concern that stays in `idle-watchdog.ts`; only the grace constant is shared.)
 *
 * Returns a cleanup fn the caller MUST invoke once the child has exited — it cancels the pending
 * SIGKILL escalation and drops the abort listener so a reused AbortController never fires kill
 * against the now-dead pid. A signal already aborted when called kills the child immediately.
 */
export const attachAbortKill = (child: ChildProcess, abortSignal: AbortSignal | undefined): (() => void) => {
  let graceTimer: NodeJS.Timeout | null = null;
  const kill = (): void => {
    try {
      child.kill('SIGTERM');
    } catch {
      // Child may already be dead (ESRCH) — best-effort.
    }
    graceTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already dead — best-effort.
      }
    }, DEFAULT_GRACE_MS);
  };
  const cleanup = (): void => {
    if (graceTimer !== null) clearTimeout(graceTimer);
    abortSignal?.removeEventListener('abort', kill);
  };
  if (abortSignal === undefined) return cleanup;
  if (abortSignal.aborted) kill();
  else abortSignal.addEventListener('abort', kill, { once: true });
  return cleanup;
};
