/**
 * Memoised `projectFlowProgress` for one session. The descriptor keeps a stable reference while
 * its trace and `live` map mutate in place, so the memo keys on the cheap change markers instead:
 * `live.version`, the trace length and its last entry (the length alone stalls once the runner's
 * ring buffer is full).
 */

import { useMemo } from 'react';
import { flowProgressOf, type FlowProgress } from '@src/application/ui/tui/runtime/flow-progress.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import { roundVerdictLookup, type TaskVerdicts } from '@src/application/ui/tui/runtime/use-task-round-verdicts.ts';

export interface UseFlowProgressInput {
  readonly descriptor: SessionDescriptor | undefined;
  /** The session is blocked on an operator prompt. */
  readonly awaiting: boolean;
  /** From `useTaskRoundVerdicts`; its identity is the verdicts' version. */
  readonly verdicts?: ReadonlyMap<string, TaskVerdicts>;
}

export const useFlowProgress = ({ descriptor, awaiting, verdicts }: UseFlowProgressInput): FlowProgress | undefined => {
  const planTree = descriptor?.planTree;
  const liveVersion = descriptor?.live?.version;
  const traceLength = descriptor?.trace.length;
  const lastEntry = descriptor?.trace[(traceLength ?? 0) - 1];
  const status = descriptor?.status;
  return useMemo(
    () => {
      if (descriptor === undefined || planTree === undefined) return undefined;
      return flowProgressOf(descriptor, awaiting, verdicts === undefined ? undefined : roundVerdictLookup(verdicts));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- descriptor mutates in place; the markers below are its change signal
    [planTree, liveVersion, traceLength, lastEntry, status, awaiting, verdicts]
  );
};
