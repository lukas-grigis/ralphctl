/**
 * Bridges the Execute view's session-shaped data onto {@link buildNextSteps}' flat input bag, and
 * folds in the post-mortem paths from {@link useRunForensics}.
 *
 * The sprint side comes from the run's OWN pinned sprint (resolved by `usePinnedSprintContext`'s
 * existing `findById`, then re-read on the settle edge — see {@link useSprintAtSettle}) plus the
 * task list `useBaselineHealthData` polls — never from the global selection, which may point
 * elsewhere while several runs are open.
 *
 * `projectCount` / `sprintCount` are genuinely unknown on this surface (no snapshot loader here),
 * so they are pinned at 0. That only ever surfaces on a run with no sprint at all — where "create
 * the first sprint" is the right advice anyway — and is unreachable once a sprint is pinned.
 */

import React from 'react';
import { buildNextSteps, type NextSteps } from '@src/application/ui/shared/next-steps.ts';
import { useRunForensics } from '@src/application/ui/tui/views/execute-view-internals/use-run-forensics.ts';
import { useStorage } from '@src/application/ui/tui/runtime/storage-context.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';

/** Mirrors `state-snapshot.ts`'s definition of resumable — `todo` plus the `in_progress` resume case. */
const resumableCount = (tasks: readonly Task[] | undefined): number =>
  tasks === undefined ? 0 : tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress').length;

/** Display label of the leaf that failed — the trace's own `label` wins over the raw element name. */
const failedLeafLabelOf = (descriptor: SessionDescriptor | undefined): string | undefined => {
  const entry = [...(descriptor?.trace ?? [])].reverse().find((e) => e.status === 'failed');
  return entry === undefined ? undefined : (entry.label ?? entry.elementName);
};

/** A run only owes next steps once it has settled; `undefined` while it is still live. */
const settledStatusOf = (descriptor: SessionDescriptor | undefined): 'completed' | 'failed' | 'aborted' | undefined => {
  switch (descriptor?.status) {
    case 'completed':
    case 'failed':
    case 'aborted':
      return descriptor.status;
    default:
      return undefined;
  }
};

interface UseSprintAtSettleInput {
  readonly settled: boolean;
  readonly pinnedSprintId: SprintId | undefined;
  readonly sprintRepo: AppDeps['sprintRepo'] | undefined;
  /** The mount-time entity from the availability probe — used until (and unless) the re-read lands. */
  readonly fallback: Sprint | undefined;
}

/**
 * Re-reads the pinned sprint once, on the settle edge.
 *
 * The advice a finished run gives must describe the sprint the flow LEFT BEHIND: `plan` moves
 * draft → planned mid-run, `refine` flips tickets pending → approved, `implement` drives
 * planned → active → review. The availability probe in `use-pinned-sprint-context.ts` reads at
 * mount and never again, so without this the card recommends re-running the flow that just
 * succeeded.
 *
 * Why not just re-probe there: `pinnedSprintStale` is derived from the same read, and a
 * `close-sprint` run ends with the sprint `done` — which the probe scores `unavailable`. Flipping
 * that flag on settle would replace the tasks panel with "Sprint no longer available" on a run
 * that did exactly what it was asked to. The two reads want different lifetimes, so they stay
 * separate; the extra `findById` costs one call per settled run.
 */
const useSprintAtSettle = ({
  settled,
  pinnedSprintId,
  sprintRepo,
  fallback,
}: UseSprintAtSettleInput): Sprint | undefined => {
  const [fresh, setFresh] = React.useState<Sprint | undefined>(undefined);

  React.useEffect(() => {
    if (!settled || pinnedSprintId === undefined || sprintRepo === undefined) {
      setFresh(undefined);
      return undefined;
    }
    let cancelled = false;
    const reread = async (): Promise<void> => {
      try {
        const r = await sprintRepo.findById(pinnedSprintId);
        if (!cancelled && r.ok) setFresh(r.value);
      } catch {
        // Keep the mount-time entity — a stale recommendation still beats none.
      }
    };
    void reread();
    return (): void => {
      cancelled = true;
    };
  }, [settled, pinnedSprintId, sprintRepo]);

  return fresh ?? fallback;
};

export interface UseSettledNextStepsInput {
  readonly descriptor: SessionDescriptor | undefined;
  readonly pinnedSprint: Sprint | undefined;
  readonly pinnedSprintId: SprintId | undefined;
  readonly taskState: readonly Task[] | undefined;
  readonly sprintRepo: AppDeps['sprintRepo'] | undefined;
}

export const useSettledNextSteps = ({
  descriptor,
  pinnedSprint,
  pinnedSprintId,
  taskState,
  sprintRepo,
}: UseSettledNextStepsInput): NextSteps => {
  // Read straight from context: this is the only consumer of the paths in the Execute tree, so
  // threading them down from the orchestrator bought nothing but a wider signature.
  const storage = useStorage();
  const runStatus = settledStatusOf(descriptor);
  const flowId = descriptor?.flowId ?? '';
  const failedLeafLabel = failedLeafLabelOf(descriptor);

  const forensics = useRunForensics({
    // Only a failure owes a post-mortem — a completed run's artifacts are not news.
    enabled: runStatus === 'failed' || runStatus === 'aborted',
    pinnedSprintId,
    flowId,
    dataRoot: storage.dataRoot,
    runsRoot: storage.runsRoot,
  });

  // The sprint as the flow left it, not as it was when this view mounted.
  const sprint = useSprintAtSettle({
    settled: runStatus !== undefined,
    pinnedSprintId,
    sprintRepo,
    fallback: pinnedSprint,
  });

  const pendingTicketCount = sprint?.tickets.filter((t) => t.status === 'pending').length ?? 0;
  const approvedTicketCount = sprint?.tickets.filter((t) => t.status === 'approved').length ?? 0;
  const ticketCount = sprint?.tickets.length ?? 0;
  const resumableTaskCount = resumableCount(taskState);
  const sprintStatus = sprint?.status;
  const hasProject = descriptor?.pinnedProjectId !== undefined;

  // Memoized on primitives: `ResultFooter` is `React.memo`'d, and a fresh object every render
  // would silently defeat that on the 1 Hz clock tick.
  return React.useMemo(
    () =>
      buildNextSteps({
        ...(runStatus !== undefined ? { runStatus } : {}),
        ...(failedLeafLabel !== undefined ? { failedLeafLabel } : {}),
        hasProject,
        projectCount: 0,
        sprintCount: 0,
        ...(sprintStatus !== undefined ? { sprintStatus } : {}),
        ticketCount,
        pendingTicketCount,
        approvedTicketCount,
        resumableTaskCount,
        forensics,
      }),
    [
      runStatus,
      failedLeafLabel,
      hasProject,
      sprintStatus,
      ticketCount,
      pendingTicketCount,
      approvedTicketCount,
      resumableTaskCount,
      forensics,
    ]
  );
};
