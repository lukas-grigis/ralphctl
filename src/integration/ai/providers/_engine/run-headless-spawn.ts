import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { DEFAULT_IDLE_MS, installIdleWatchdog } from '@src/integration/ai/providers/_engine/idle-watchdog.ts';

/**
 * Shared lifecycle scaffold for headless AI provider spawns. Three adapters (claude / codex /
 * copilot) were stamping the same try/finally + named-listener + idle-watchdog choreography;
 * every bug in one had to be fixed in the other two. Centralising the scaffold means a
 * resource-cleanup change is a one-file edit and the per-provider call sites only carry the
 * bits that genuinely differ:
 *
 *  - what to do with each stdout chunk (raw accumulate, line-parse, session-id extract …)
 *  - whether to send a prompt down stdin (and which one)
 *  - which exit event to wait on (`'exit'` vs `'close'`)
 *
 * Everything else — listener attach/detach, watchdog install/stop, abort handling, idle
 * warning emission — lives here. Listeners are detached in a `finally` that wraps everything
 * after attach so a throw in `stdin.end` or `installIdleWatchdog` can't leave buffer closures
 * pinned to the child's stream EventEmitters.
 */

export interface RunHeadlessSpawnOptions {
  readonly child: ChildProcessWithoutNullStreams;
  /** Called for each utf-8 stdout chunk. Buffer closure captured for the spawn's lifetime. */
  readonly onStdout: (chunk: string) => void;
  /** Called for each utf-8 stderr chunk. */
  readonly onStderr: (chunk: string) => void;
  /**
   * Optional prompt body. When defined the helper writes it to stdin and closes; when omitted
   * (copilot passes the prompt via argv) the helper closes stdin immediately so the child
   * doesn't hang waiting for input.
   */
  readonly stdin?: string;
  /**
   * Which child exit event to await. `'close'` waits for streams to flush (claude needs this
   * so the final stdout chunk is captured); `'exit'` is sufficient for copilot/codex which
   * stream their tokens incrementally to the on-stdout handler.
   */
  readonly resolveOn: 'exit' | 'close';
  /** Stdio-silence cap before SIGTERM. Defaults to `DEFAULT_IDLE_MS`. */
  readonly idleMs?: number;
  /** Caller-controlled abort (Ctrl-C / TUI cancel). Threaded into the watchdog kill ladder. */
  readonly abortSignal?: AbortSignal;
  /** Fires once when the watchdog kills the child due to idle. Useful for logging. */
  readonly onIdle?: () => void;
}

export interface SpawnExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /**
   * Set when the child raised an `'error'` event (the binary could not be spawned — ENOENT /
   * EACCES — or it died before stdin drained). Mutually exclusive with a real exit: on a spawn
   * error the child never exits, so `code` / `signal` stay `null` and this carries the cause.
   * `classifySpawnExit` maps it to an `InvalidStateError` so a missing / upgraded CLI surfaces
   * as a typed failure instead of crashing the whole Node process via an unhandled event.
   */
  readonly spawnError?: NodeJS.ErrnoException;
}

export const runHeadlessSpawn = async (opts: RunHeadlessSpawnOptions): Promise<SpawnExit> => {
  const { child, onStdout, onStderr, stdin, resolveOn, abortSignal, onIdle } = opts;
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', onStdout);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', onStderr);
  const detachListeners = (): void => {
    child.stdout.off('data', onStdout);
    child.stderr.off('data', onStderr);
  };

  let watchdog: ReturnType<typeof installIdleWatchdog> | undefined;
  try {
    return await new Promise<SpawnExit>((resolve) => {
      // A failed spawn (missing / non-executable binary, ENOENT/EACCES) or a child that dies
      // before stdin drains raises an `'error'` event. Without a listener Node treats it as an
      // unhandled error and kills the whole process — a single upgraded `claude` binary mid-
      // sprint would take ralphctl down. Resolve the exit promise with the captured error so
      // the classifier converts it to an InvalidStateError instead. Latched: an `'error'` and a
      // real exit can both fire, but the first resolve wins.
      let settled = false;
      const settle = (exit: SpawnExit): void => {
        if (settled) return;
        settled = true;
        resolve(exit);
      };
      child.once('error', (err: NodeJS.ErrnoException) => settle({ code: null, signal: null, spawnError: err }));
      child.once(resolveOn, (code, signal) => settle({ code, signal }));

      // stdin: send the prompt (claude/codex) or close immediately (copilot reads from argv).
      // The write goes against a child that may already be dead (raced the spawn `'error'`):
      // an unhandled EPIPE on the stdin stream is itself a process-killer, so swallow it — the
      // `'error'` event above carries the real cause and drives the outcome. `child.stdin` is a
      // Writable in production (always has `.on`); the optional-call guard keeps the helper
      // resilient to minimal stdin stubs that only implement `end()`.
      child.stdin.on?.('error', () => {
        // EPIPE / ECONNRESET against a dead child — the spawn `'error'` path owns the failure.
      });
      try {
        if (stdin !== undefined) child.stdin.end(stdin);
        else child.stdin.end();
      } catch {
        // Synchronous throw from `end()` on a destroyed stream — swallow; the `'error'` event
        // (already wired) surfaces the real spawn failure.
      }

      watchdog = installIdleWatchdog(child, {
        idleMs,
        ...(abortSignal !== undefined ? { abortSignal } : {}),
        ...(onIdle !== undefined ? { onIdle } : {}),
      });
    });
  } finally {
    watchdog?.stop();
    detachListeners();
  }
};
