import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { installIdleWatchdog, DEFAULT_IDLE_MS } from '@src/integration/ai/providers/_engine/idle-watchdog.ts';

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
    // stdin: send the prompt (claude/codex) or close immediately (copilot reads from argv).
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();

    watchdog = installIdleWatchdog(child, {
      idleMs,
      ...(abortSignal !== undefined ? { abortSignal } : {}),
      ...(onIdle !== undefined ? { onIdle } : {}),
    });

    return await new Promise<SpawnExit>((resolve) => {
      child.once(resolveOn, (code, signal) => resolve({ code, signal }));
    });
  } finally {
    watchdog?.stop();
    detachListeners();
  }
};
