/**
 * Shutdown coordinator — runs registered cleanup callbacks on
 * SIGINT / SIGTERM / SIGHUP and on uncaught exceptions, then exits.
 *
 * Why this exists: Ink mounts the TUI with `exitOnCtrlC: false` so
 * keystrokes can be handled by views without Ctrl+C terminating the
 * process. That means SIGINT propagates to Node and the default
 * handler exits abruptly — without aborting in-flight chain runners,
 * without releasing file locks, without restoring the alt-screen.
 * This module is the single place that orchestrates a clean shutdown.
 *
 * Two-press semantics: first signal runs cleanup with a 5-second
 * budget; a second signal arriving during cleanup forces an immediate
 * hard exit. Users get one polite chance and then their second
 * Ctrl+C ends it for sure.
 *
 * Exit codes:
 *  - SIGINT  → 130 (canonical)
 *  - SIGTERM → 143
 *  - SIGHUP  → 129
 *  - uncaughtException → 1, after running cleanup
 *
 * Registration is order-preserved: handlers run in registration
 * order so callers can express dependencies (register the alt-screen
 * restore LAST so it runs after session-manager dispose has emitted
 * any final terminal output).
 */

type ShutdownFn = () => void | Promise<void>;
type ShutdownReason = NodeJS.Signals | 'uncaughtException';

interface Registration {
  readonly name: string;
  readonly fn: ShutdownFn;
}

const handlers: Registration[] = [];
let installed = false;
let shuttingDown = false;

/**
 * Cleanup budget. Anything slower than this gets cut short by a hard
 * exit — better to terminate than to hang the user's terminal waiting
 * on a stuck dispose. 5 seconds matches `claude` CLI's own kill grace
 * period for child processes.
 */
const SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Register a shutdown callback. Returns an unregister function that
 * the caller can invoke when its concern is no longer relevant (for
 * example, when an Ink mount finishes normally). Returning `undefined`
 * from the callback is fine; throwing is logged via stderr but does
 * not abort the rest of the chain.
 */
export function registerShutdown(name: string, fn: ShutdownFn): () => void {
  handlers.push({ name, fn });
  return () => {
    const i = handlers.findIndex((h) => h.fn === fn);
    if (i !== -1) handlers.splice(i, 1);
  };
}

/**
 * Install the SIGINT / SIGTERM / SIGHUP / uncaughtException listeners.
 * Idempotent — repeat calls are no-ops. Most callers don't need to
 * touch this directly: the Ink mount path calls it once.
 */
export function installShutdownHandlers(): void {
  if (installed) return;
  installed = true;

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      requestShutdown(sig);
    });
  }

  process.on('uncaughtException', (err) => {
    if (shuttingDown) {
      // Already cleaning up; let it finish or get killed by the timer.
      return;
    }
    shuttingDown = true;
    process.stderr.write(`uncaughtException: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    void runShutdown('uncaughtException');
  });
}

/**
 * Programmatic shutdown trigger. Used by the Ink TUI when it intercepts
 * Ctrl+C as a keypress (raw mode swallows the SIGINT signal). Same
 * two-press semantics as the signal path: first call runs cleanup with
 * the 5-second budget; second call hard-exits.
 */
export function requestShutdown(reason: ShutdownReason): void {
  if (shuttingDown) {
    process.exit(exitCodeFor(reason));
    return;
  }
  shuttingDown = true;
  void runShutdown(reason);
}

/**
 * Test seam — wipe state so the next test starts clean. Production
 * code never calls this; the process exit drops the module.
 */
export function __resetShutdownStateForTests(): void {
  handlers.length = 0;
  installed = false;
  shuttingDown = false;
}

async function runShutdown(reason: ShutdownReason): Promise<void> {
  // Hard-exit budget. If a handler hangs, we still terminate — the
  // user's shell shouldn't be held hostage.
  const timeout = setTimeout(() => process.exit(exitCodeFor(reason)), SHUTDOWN_TIMEOUT_MS);
  // Don't keep the event loop alive on the timer alone.
  if (typeof timeout.unref === 'function') timeout.unref();
  try {
    // Snapshot so a handler that calls registerShutdown / unregister
    // mid-flight doesn't reorder the list under us.
    for (const { name, fn } of [...handlers]) {
      try {
        await fn();
      } catch (err) {
        process.stderr.write(`shutdown[${name}] failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  } finally {
    clearTimeout(timeout);
    process.exit(exitCodeFor(reason));
  }
}

function exitCodeFor(reason: ShutdownReason): number {
  switch (reason) {
    case 'SIGINT':
      return 130;
    case 'SIGTERM':
      return 143;
    case 'SIGHUP':
      return 129;
    case 'uncaughtException':
      return 1;
    default:
      return 1;
  }
}
