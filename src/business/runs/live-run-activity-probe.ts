import type { RunActivityProbe } from '@src/business/_shared/run-activity-probe.ts';
import { sameMachine, type LiveRunStore, type ProcessLiveness } from '@src/business/runs/live-run.ts';
import { ownerGone } from '@src/business/runs/detect-interrupted-runs.ts';

export interface LiveRunActivityProbeDeps {
  readonly store: Pick<LiveRunStore, 'list'>;
  readonly liveness: ProcessLiveness;
}

/**
 * Active while another live process on this machine owns a run record — covers lock-less flows
 * (plan / refine / ideate) started from a second terminal. This process's own runs are the
 * in-process probe's job.
 */
export const createLiveRunActivityProbe = (deps: LiveRunActivityProbeDeps): RunActivityProbe => ({
  async anyRunActive() {
    const listed = await deps.store.list();
    // Can't prove nothing runs — refuse the destructive operation rather than guess.
    if (!listed.ok) return true;
    const here = await deps.liveness.machine();
    for (const record of listed.value) {
      if (record.owner.pid === deps.liveness.selfPid || !sameMachine(record.owner, here)) continue;
      if (!(await ownerGone(record, deps.liveness))) return true;
    }
    return false;
  },
});
