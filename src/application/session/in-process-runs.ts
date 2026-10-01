import type { Runner } from '@src/application/chain/run/runner.ts';
import type { RunActivityProbe } from '@src/business/_shared/run-activity-probe.ts';

/**
 * Runners this process has handed to the TUI, as a {@link RunActivityProbe}: a run counts as active from `track()`
 * until its runner settles. Covers the flows that never take an advisory lock (plan, refine, ideate, …).
 */
export interface InProcessRuns extends RunActivityProbe {
  track(runner: Pick<Runner<unknown>, 'status' | 'subscribe'>): void;
}

const isSettled = (status: Runner<unknown>['status']): boolean =>
  status === 'completed' || status === 'failed' || status === 'aborted';

export const createInProcessRuns = (): InProcessRuns => {
  const active = new Set<object>();
  return {
    track(runner) {
      if (isSettled(runner.status) || active.has(runner)) return;
      active.add(runner);
      const unsubscribe = runner.subscribe((event) => {
        if (event.type === 'completed' || event.type === 'failed' || event.type === 'aborted') {
          active.delete(runner);
          unsubscribe();
        }
      });
    },
    anyRunActive: () => Promise.resolve(active.size > 0),
  };
};
