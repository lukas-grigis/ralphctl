import type { Runner, RunnerEvent } from '@src/application/chain/run/runner.ts';
import type { RunActivityProbe } from '@src/business/_shared/run-activity-probe.ts';
import type { LiveRunMeta, LiveRunRecorder } from '@src/application/session/live-run-recorder.ts';

type TrackedRunner = Pick<Runner<unknown>, 'id' | 'status' | 'subscribe' | 'abort'>;

/** How long {@link InProcessRuns.abortAll} waits for runs to stop before it kills their AI CLI process groups. */
export const ABORT_ALL_TIMEOUT_MS = 5_000;

export interface AbortAllOutcome {
  readonly runs: number;
  /** The bounded wait ran out and the AI CLI process groups were killed. */
  readonly forced: boolean;
  readonly stuckFlows: readonly string[];
  readonly killed: number;
}

export interface AbortAllOptions {
  readonly timeoutMs?: number;
}

/**
 * Runners this process has handed to the TUI, as a {@link RunActivityProbe}: a run counts as active from `track()`
 * until its runner settles. Covers the flows that never take an advisory lock (plan, refine, ideate, …).
 *
 * Each tracked run also gets a live-run record for its lifetime, and {@link InProcessRuns.abortAll} is the clean stop
 * the TUI calls before quitting with runs still live.
 */
export interface InProcessRuns extends RunActivityProbe {
  track(runner: TrackedRunner, meta?: LiveRunMeta): void;
  /** Runs tracked and not yet settled. */
  liveCount(): number;
  /**
   * Abort every live run and resolve once each has settled, its AI CLI children have exited, and the run records are
   * gone from disk — or, after `timeoutMs`, kill the registered process groups and resolve with `forced`.
   */
  abortAll(reason?: string, opts?: AbortAllOptions): Promise<AbortAllOutcome>;
  /** Resolves once every queued live-run record write and removal has landed, or after `timeoutMs` (best effort). */
  flush(opts?: AbortAllOptions): Promise<void>;
}

export interface AbandonedRun {
  readonly sprintId: string;
  readonly since: number;
}

export interface InProcessRunsDeps {
  readonly recorder?: Pick<LiveRunRecorder, 'begin' | 'end' | 'idle'>;
  readonly children?: { whenNoChildren(): Promise<void>; killAll(): number };
  /** So an operator stop never reads as a crash on the next launch. */
  readonly settleAbandoned?: (run: AbandonedRun) => Promise<void>;
  readonly now?: () => number;
}

interface ActiveRun {
  readonly meta: LiveRunMeta;
  readonly settled: Promise<void>;
}

const isSettled = (status: Runner<unknown>['status']): boolean =>
  status === 'completed' || status === 'failed' || status === 'aborted';

const isTerminal = (event: RunnerEvent<unknown>): boolean =>
  event.type === 'completed' || event.type === 'failed' || event.type === 'aborted';

/** A caller-driven abort carries no error; an abort the chain raised itself does. */
const stoppedByCaller = (event: RunnerEvent<unknown>): boolean => event.type === 'aborted' && event.error === undefined;

const withinTimeout = (work: Promise<void>, timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
    void work.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      }
    );
  });

export const createInProcessRuns = (deps: InProcessRunsDeps = {}): InProcessRuns => {
  const active = new Map<TrackedRunner, ActiveRun>();
  const now = deps.now ?? Date.now;

  const abandonedWork = (meta: LiveRunMeta, since: number): Promise<void> | undefined => {
    if (deps.settleAbandoned === undefined || meta.flowId !== 'implement' || meta.sprintId === undefined) {
      return undefined;
    }
    // Best effort: an unsettled attempt is resumed as interrupted on the next launch.
    return deps.settleAbandoned({ sprintId: meta.sprintId, since }).catch(() => undefined);
  };

  return {
    track(runner, meta = { flowId: 'unknown' }) {
      if (isSettled(runner.status) || active.has(runner)) return;
      const since = now();
      deps.recorder?.begin(runner.id, meta);
      let settle!: () => void;
      active.set(runner, { meta, settled: new Promise<void>((resolve) => (settle = resolve)) });
      const close = (): void => {
        active.delete(runner);
        deps.recorder?.end(runner.id);
        settle();
      };
      const unsubscribe = runner.subscribe((event) => {
        if (!isTerminal(event)) return;
        unsubscribe();
        const work = stoppedByCaller(event) ? abandonedWork(meta, since) : undefined;
        if (work === undefined) close();
        else void work.then(close);
      });
    },
    liveCount: () => active.size,
    anyRunActive: () => Promise.resolve(active.size > 0),
    async abortAll(reason = 'quit', opts = {}) {
      const stopping = [...active.entries()];
      for (const [runner] of stopping) runner.abort(reason);
      const stopped = (async (): Promise<void> => {
        await Promise.all(stopping.map(([, run]) => run.settled));
        await deps.children?.whenNoChildren();
        await deps.recorder?.idle();
      })();
      if (await withinTimeout(stopped, opts.timeoutMs ?? ABORT_ALL_TIMEOUT_MS)) {
        return { runs: stopping.length, forced: false, stuckFlows: [], killed: 0 };
      }
      const stuckFlows = stopping.filter(([runner]) => active.has(runner)).map(([, run]) => run.meta.flowId);
      return { runs: stopping.length, forced: true, stuckFlows, killed: deps.children?.killAll() ?? 0 };
    },
    flush: async (opts = {}) => {
      if (deps.recorder === undefined) return;
      await withinTimeout(deps.recorder.idle(), opts.timeoutMs ?? ABORT_ALL_TIMEOUT_MS);
    },
  };
};
