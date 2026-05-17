import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Stuck-process safeguard for headless AI spawns.
 *
 * Production AI sessions stream tokens continuously to stdout — even mid-tool-use, even mid-
 * thinking, the CLI prints _something_ every few seconds. A process that emits no stdio at
 * all for several minutes is wedged: the model server hung up, the CLI deadlocked on a
 * decision tree, the network stalled, etc. v2 has no wall-clock timeout (implement sessions
 * can legitimately run for hours, so we don't want one), so without an idle detector a stuck
 * child hangs the implement chain forever — operator's away, no rescue.
 *
 * The watchdog arms a timer that resets on every `data` chunk on stdout or stderr. When the
 * timer fires the child is killed with SIGTERM → SIGKILL escalation (matches v1's
 * `process-runner.ts` pattern). `onIdle` fires once at the moment of SIGTERM so the caller
 * can publish a log event before the child exits.
 *
 * The watchdog also re-uses the same kill ladder for `abortSignal` (user Ctrl-C, TUI cancel),
 * so a hung child that traps SIGTERM still dies after `graceMs`.
 *
 * `stop()` is idempotent and MUST be called on the success path so the timer doesn't keep
 * the event loop alive after the spawn completes.
 */

/** Hard cap on stdio silence before a session is presumed wedged. 5 minutes by default. */
export const DEFAULT_IDLE_MS = 5 * 60_000;

/** SIGTERM → SIGKILL grace, mirrors v1. */
export const DEFAULT_GRACE_MS = 10_000;

export interface IdleWatchdogOptions {
  /** Milliseconds of stdio silence before SIGTERM. */
  readonly idleMs: number;
  /** Grace before escalating to SIGKILL. Default 10s. */
  readonly graceMs?: number;
  /** Caller-controlled abort (Ctrl-C / TUI). Propagated through the same kill ladder. */
  readonly abortSignal?: AbortSignal;
  /** Fires once when the watchdog kills the child due to idle (NOT on abort or success). */
  readonly onIdle?: () => void;
}

export interface IdleWatchdog {
  /** Stop the timer. Idempotent; safe to call multiple times. Call on the success/exit path. */
  stop(): void;
}

export const installIdleWatchdog = (child: ChildProcessWithoutNullStreams, opts: IdleWatchdogOptions): IdleWatchdog => {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  let timer: NodeJS.Timeout | null = null;
  let killGraceTimer: NodeJS.Timeout | null = null;
  let killed = false;

  const escalate = (): void => {
    killGraceTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Child may already be dead (ESRCH) — best-effort.
      }
    }, graceMs);
  };

  const killIdle = (): void => {
    if (killed) return;
    killed = true;
    opts.onIdle?.();
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore — already dead
    }
    escalate();
  };

  const killAbort = (): void => {
    if (killed) return;
    killed = true;
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    escalate();
  };

  const resetIdleTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(killIdle, opts.idleMs);
  };

  // Re-install on every `data` chunk. Multiple listeners on the same EventEmitter are fine —
  // the adapter still attaches its own listener for buffer accumulation.
  child.stdout.on('data', resetIdleTimer);
  child.stderr.on('data', resetIdleTimer);

  const abortSignal = opts.abortSignal;
  if (abortSignal !== undefined) {
    abortSignal.addEventListener('abort', killAbort, { once: true });
  }

  // Arm the clock NOW — a child that never emits anything still has to die after `idleMs`.
  resetIdleTimer();

  return {
    stop(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (killGraceTimer !== null) {
        clearTimeout(killGraceTimer);
        killGraceTimer = null;
      }
      // Drop our `data` listeners so the child's stream EventEmitter doesn't keep them — and
      // the closures they capture — alive past the spawn. On a wedged child the streams may
      // outlive the spawn function (caller still holds references during error handling), so
      // an explicit `.off` is necessary; Node's `on('data')` without a matching `off` is a
      // long-run leak even after the process exits.
      child.stdout.off('data', resetIdleTimer);
      child.stderr.off('data', resetIdleTimer);
      // Same hazard on the AbortSignal: `{ once: true }` self-removes when the abort fires,
      // but if the spawn completes normally the listener never triggers and lingers on the
      // signal. A single AbortController is reused across many spawns in a session, so each
      // successful spawn would otherwise leave a dead listener behind. removeEventListener is
      // a no-op when the listener already self-removed via `{ once: true }`.
      abortSignal?.removeEventListener('abort', killAbort);
    },
  };
};
