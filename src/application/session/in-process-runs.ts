import type { Runner } from '@src/application/chain/run/runner.ts';
import type { RunActivityProbe } from '@src/business/_shared/run-activity-probe.ts';
import type { LiveRunMeta, LiveRunRecorder } from '@src/application/session/live-run-recorder.ts';

type TrackedRunner = Pick<Runner<unknown>, 'id' | 'status' | 'subscribe' | 'abort'>;

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
   * gone from disk.
   */
  abortAll(reason?: string): Promise<void>;
}

export interface InProcessRunsDeps {
  readonly recorder?: Pick<LiveRunRecorder, 'begin' | 'end' | 'idle'>;
  readonly children?: { whenNoChildren(): Promise<void> };
}

const isSettled = (status: Runner<unknown>['status']): boolean =>
  status === 'completed' || status === 'failed' || status === 'aborted';

export const createInProcessRuns = (deps: InProcessRunsDeps = {}): InProcessRuns => {
  const active = new Map<TrackedRunner, Promise<void>>();
  return {
    track(runner, meta) {
      if (isSettled(runner.status) || active.has(runner)) return;
      deps.recorder?.begin(runner.id, meta ?? { flowId: 'unknown' });
      let settle!: () => void;
      active.set(runner, new Promise<void>((resolve) => (settle = resolve)));
      const unsubscribe = runner.subscribe((event) => {
        if (event.type === 'completed' || event.type === 'failed' || event.type === 'aborted') {
          active.delete(runner);
          deps.recorder?.end(runner.id);
          settle();
          unsubscribe();
        }
      });
    },
    liveCount: () => active.size,
    anyRunActive: () => Promise.resolve(active.size > 0),
    async abortAll(reason = 'quit') {
      const settled = [...active.values()];
      for (const runner of [...active.keys()]) runner.abort(reason);
      await Promise.all(settled);
      await deps.children?.whenNoChildren();
      await deps.recorder?.idle();
    },
  };
};
