import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Fabricate a child process that behaves like a spawned AI CLI without spawning anything.
 *
 * Two callers want the same object for different reasons, which is why this lives in `src/`
 * rather than in a test fixture:
 *
 *  - the provider conformance suites drive every real adapter over a scripted transcript, so a
 *    port-contract regression (prompt inlined into argv, a dropped root, a missing kill rung)
 *    fails at `pnpm test` instead of during a live session;
 *  - the shipped demo replays a canned generator → evaluator transcript through the real claude
 *    adapter, so a first-run user sees the actual harness rather than a mock of it.
 *
 * The builder is deliberately amnesiac: it emits what the {@link SpawnScript} says and forwards
 * stdin / kill signals to the caller's hooks, but records nothing itself. Recording is the
 * caller's concern — the test fixture keeps a per-call log, the demo keeps a transcript cursor —
 * and baking one shape in here would force the other to work around it.
 *
 * @public
 */
export interface SpawnScript {
  /** utf-8 chunks emitted on stdout, in order, one macrotask after construction. */
  readonly stdoutChunks?: readonly string[];
  /** utf-8 chunks emitted on stderr, after the stdout chunks. */
  readonly stderrChunks?: readonly string[];
  /** Exit code reported on `exit` / `close`. Defaults to `0`. */
  readonly exitCode?: number | null;
  /** Signal reported alongside the exit code. Defaults to `null`. */
  readonly exitSignal?: NodeJS.Signals | null;
  /** Delay between the last chunk and the exit, in ms. Defaults to `0`. */
  readonly exitDelayMs?: number;
  /** Emit the chunks and then never exit — the wedged-child shape the idle watchdog exists for. */
  readonly hang?: boolean;
  /**
   * Swallow `SIGTERM` and die only on `SIGKILL`, modelling a child that traps the polite signal.
   * Without it the first rung of the kill ladder ends the process and the `SIGTERM → grace →
   * SIGKILL` escalation is unobservable, because the caller cancels the grace timer on exit.
   */
  readonly trapsSigterm?: boolean;
}

/**
 * A script, or a thunk resolved at emission time — one macrotask after construction, which is
 * after the adapter has written the prompt to stdin. The thunk form is what lets a caller decide
 * the response from what the session actually asked for (parse the prompt off stdin, pick the next
 * transcript beat, write the files the AI is contractually meant to write) instead of pinning the
 * whole conversation up front.
 *
 * @public
 */
export type SpawnScriptSource = SpawnScript | (() => SpawnScript);

/** @public */
export interface ScriptedChildHooks {
  /** Every utf-8 chunk the adapter writes to the child's stdin, including the final `end()` payload. */
  readonly onStdin?: (chunk: string) => void;
  /** Every signal the adapter sends, in order — the seam the kill-ladder assertions read. */
  readonly onKill?: (signal: NodeJS.Signals) => void;
}

/** Minimal `Writable`-shaped stdin: adapters only ever `end()` it and listen for `'error'`. */
const createScriptedStdin = (onStdin: ((chunk: string) => void) | undefined): EventEmitter => {
  const stdin = new EventEmitter();
  const record = (data?: unknown): void => {
    if (typeof data === 'string') onStdin?.(data);
    else if (data instanceof Buffer) onStdin?.(data.toString('utf8'));
  };
  return Object.assign(stdin, {
    write: (data?: unknown): boolean => {
      record(data);
      return true;
    },
    end: (data?: unknown): void => {
      record(data);
    },
    destroy: (): void => {
      // no-op — nothing holds an OS handle here.
    },
  });
};

/** `setEncoding` is called by `runHeadlessSpawn` before it attaches its `data` listener. */
const createScriptedStream = (): EventEmitter => {
  const stream = new EventEmitter();
  return Object.assign(stream, {
    setEncoding: (): void => {
      // The fabricated chunks are already utf-8 strings.
    },
  });
};

/**
 * Build one scripted child. The chunks are emitted asynchronously (one macrotask after
 * construction) so the adapter has attached its stdout / stderr listeners first, exactly as a real
 * spawn behaves.
 *
 * A kill that arrives before the script has been resolved ends the child immediately regardless of
 * `trapsSigterm` — a process that has not started cannot trap anything.
 *
 * @public
 */
export const createScriptedChild = (
  source: SpawnScriptSource,
  hooks: ScriptedChildHooks = {}
): ChildProcessWithoutNullStreams => {
  const child = new EventEmitter();
  const stdout = createScriptedStream();
  const stderr = createScriptedStream();
  const stdin = createScriptedStdin(hooks.onStdin);

  let resolved: SpawnScript | undefined;
  let exited = false;

  const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (exited) return;
    exited = true;
    child.emit('exit', code, signal);
    // Real children flush their streams between `exit` and `close`; adapters wait on one or the
    // other (`resolveOn`), so both have to fire and in that order.
    setTimeout(() => child.emit('close', code, signal), 0);
  };

  Object.assign(child, {
    stdout,
    stderr,
    stdin,
    pid: 0,
    killed: false,
    kill: (signal?: NodeJS.Signals | number): boolean => {
      const named: NodeJS.Signals = typeof signal === 'number' || signal === undefined ? 'SIGTERM' : signal;
      hooks.onKill?.(named);
      if (named === 'SIGTERM' && resolved?.trapsSigterm === true) return true;
      setTimeout(() => finish(null, named), 0);
      return true;
    },
  });

  setTimeout(() => {
    resolved = typeof source === 'function' ? source() : source;
    for (const chunk of resolved.stdoutChunks ?? []) stdout.emit('data', chunk);
    for (const chunk of resolved.stderrChunks ?? []) stderr.emit('data', chunk);
    if (resolved.hang === true) return;
    const { exitCode = 0, exitSignal = null, exitDelayMs = 0 } = resolved;
    setTimeout(() => finish(exitCode, exitSignal), exitDelayMs);
  }, 0);

  return child as unknown as ChildProcessWithoutNullStreams;
};
