/**
 * Three effects scoped to a session's pinned project/sprint, which share the same descriptor fields: probe whether the
 * pin was closed or removed, register it as the focused-run context, and converge the global selection onto it.
 */

import React from 'react';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { FocusedRunCtx } from '@src/application/ui/tui/runtime/ui-state-context.tsx';

/** Tri-state so callers can tell "not yet known" apart from "confirmed available". */
type PinnedSprintProbe = 'checking' | 'available' | 'unavailable';

interface PinnedSprintState {
  readonly probe: PinnedSprintProbe;
  /**
   * The resolved entity, retained rather than discarded: the settled footer needs the sprint's status + ticket counts
   * to say what to do next, and this `findById` already happens.
   */
  readonly sprint: Sprint | undefined;
}

interface UsePinnedSprintProbeInput {
  readonly pinnedSprintId: SprintId | undefined;
  readonly sprintRepo: AppDeps['sprintRepo'];
}

/** Availability probe — isolated so its polling logic doesn't crowd the effect below it. */
const usePinnedSprintProbe = ({ pinnedSprintId, sprintRepo }: UsePinnedSprintProbeInput): PinnedSprintState => {
  const [state, setState] = React.useState<PinnedSprintState>({ probe: 'checking', sprint: undefined });

  React.useEffect(() => {
    // Nothing to probe — settle immediately so a descriptor without a pin (e.g. a create-sprint
    // run before its sprint exists) never blocks on a check that will never run.
    if (pinnedSprintId === undefined) {
      setState({ probe: 'available', sprint: undefined });
      return undefined;
    }
    let cancelled = false;
    const check = async (): Promise<void> => {
      try {
        const r = await sprintRepo.findById(pinnedSprintId);
        if (cancelled) return;
        if (!r.ok) {
          setState({ probe: 'unavailable', sprint: undefined });
          return;
        }
        setState({ probe: r.value.status !== 'done' ? 'available' : 'unavailable', sprint: r.value });
      } catch {
        // Keep available on error (absent repo in test harnesses, transient I/O failures).
        if (!cancelled) setState({ probe: 'available', sprint: undefined });
      }
    };
    void check();
    return (): void => {
      cancelled = true;
    };
  }, [pinnedSprintId, sprintRepo]);

  return state;
};

interface UseConvergeSelectionOnFocusInput {
  readonly pinnedProjectId: ProjectId | undefined;
  readonly pinnedProjectLabel: string | undefined;
  readonly pinnedSprintId: SprintId | undefined;
  readonly pinnedSprintLabel: string | undefined;
  readonly pinnedSprintProbe: PinnedSprintProbe;
  readonly selectionSprintId: SprintId | undefined;
  readonly followFocusedRun: (
    projectId: ProjectId,
    projectLabel: string,
    sprintId: SprintId,
    sprintLabel: string
  ) => void;
}

/**
 * Converges the global selection onto this run's pinned sprint whenever focus lands on a session pinned to a
 * DIFFERENT sprint, so the next flow launch targets the run on screen. It never persists the pick.
 */
const useConvergeSelectionOnFocus = ({
  pinnedProjectId,
  pinnedProjectLabel,
  pinnedSprintId,
  pinnedSprintLabel,
  pinnedSprintProbe,
  selectionSprintId,
  followFocusedRun,
}: UseConvergeSelectionOnFocusInput): void => {
  React.useEffect(() => {
    if (pinnedProjectId === undefined || pinnedSprintId === undefined) return;
    if (pinnedSprintProbe !== 'available' || pinnedSprintId === selectionSprintId) return;
    followFocusedRun(
      pinnedProjectId,
      pinnedProjectLabel ?? String(pinnedProjectId),
      pinnedSprintId,
      pinnedSprintLabel ?? String(pinnedSprintId)
    );
  }, [
    pinnedProjectId,
    pinnedProjectLabel,
    pinnedSprintId,
    pinnedSprintLabel,
    pinnedSprintProbe,
    selectionSprintId,
    followFocusedRun,
  ]);
};

export interface UsePinnedSprintContextInput {
  readonly pinnedProjectId: ProjectId | undefined;
  readonly pinnedProjectLabel: string | undefined;
  readonly pinnedSprintId: SprintId | undefined;
  readonly pinnedSprintLabel: string | undefined;
  readonly sprintRepo: AppDeps['sprintRepo'];
  readonly setFocusedRunContext: (ctx: FocusedRunCtx | undefined) => void;
  readonly selectionSprintId: SprintId | undefined;
  readonly followFocusedRun: (
    projectId: ProjectId,
    projectLabel: string,
    sprintId: SprintId,
    sprintLabel: string
  ) => void;
}

export interface UsePinnedSprintContextResult {
  /** `true` once the pin has been confirmed closed or removed — see `deriveTasksPanel`. */
  readonly pinnedSprintStale: boolean;
  /** The resolved pinned sprint, when one exists on disk — feeds the settled footer's next steps. */
  readonly pinnedSprint: Sprint | undefined;
}

export const usePinnedSprintContext = ({
  pinnedProjectId,
  pinnedProjectLabel,
  pinnedSprintId,
  pinnedSprintLabel,
  sprintRepo,
  setFocusedRunContext,
  selectionSprintId,
  followFocusedRun,
}: UsePinnedSprintContextInput): UsePinnedSprintContextResult => {
  const { probe: pinnedSprintProbe, sprint: pinnedSprint } = usePinnedSprintProbe({ pinnedSprintId, sprintRepo });

  React.useEffect(() => {
    const ctx: FocusedRunCtx = {
      projectLabel: pinnedProjectLabel,
      sprintId: pinnedSprintId,
      sprintLabel: pinnedSprintLabel,
    };
    setFocusedRunContext(ctx);
    return (): void => {
      setFocusedRunContext(undefined);
    };
  }, [pinnedProjectLabel, pinnedSprintId, pinnedSprintLabel, setFocusedRunContext]);

  useConvergeSelectionOnFocus({
    pinnedProjectId,
    pinnedProjectLabel,
    pinnedSprintId,
    pinnedSprintLabel,
    pinnedSprintProbe,
    selectionSprintId,
    followFocusedRun,
  });

  return {
    pinnedSprintStale: pinnedSprintId !== undefined && pinnedSprintProbe === 'unavailable',
    pinnedSprint,
  };
};
