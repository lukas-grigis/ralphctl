/**
 * Three effects scoped to a session's pinned project/sprint, extracted together because they
 * share the same descriptor fields (pinnedProjectId / pinnedSprintId / pinnedProjectLabel /
 * pinnedSprintLabel):
 *
 *  1. Probes `sprintRepo` to detect a closed/removed pin, surfaced as `pinnedSprintStale` so the
 *     caller can blank the panels that depend on it (see `execute-view.tsx`'s `deriveTasksPanel`).
 *  2. Registers this run's project/sprint as the focused-run context so the breadcrumb and
 *     progress overlay reflect the run's own sprint while the Execute view is mounted.
 *  3. Converges the global selection onto the pin once it's confirmed live — see
 *     `useConvergeSelectionOnFocus` below for the full rationale.
 */

import React from 'react';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { FocusedRunCtx } from '@src/application/ui/tui/runtime/ui-state-context.tsx';

/**
 * Tri-state so callers can tell "not yet known" apart from "confirmed available" — convergence
 * must not act on `'checking'`: converging before the probe settles risks landing on a pin that
 * resolves to `'unavailable'` a moment later, with nothing left to undo it.
 */
type PinnedSprintProbe = 'checking' | 'available' | 'unavailable';

interface UsePinnedSprintProbeInput {
  readonly pinnedSprintId: SprintId | undefined;
  readonly sprintRepo: AppDeps['sprintRepo'];
}

/** Availability probe — isolated so its polling logic doesn't crowd the effect below it. */
const usePinnedSprintProbe = ({ pinnedSprintId, sprintRepo }: UsePinnedSprintProbeInput): PinnedSprintProbe => {
  const [probe, setProbe] = React.useState<PinnedSprintProbe>('checking');

  React.useEffect(() => {
    // Nothing to probe — settle immediately so a descriptor without a pin (e.g. a create-sprint
    // run before its sprint exists) never blocks on a check that will never run.
    if (pinnedSprintId === undefined) {
      setProbe('available');
      return undefined;
    }
    let cancelled = false;
    const check = async (): Promise<void> => {
      try {
        const r = await sprintRepo.findById(pinnedSprintId);
        if (!cancelled) setProbe(r.ok && r.value.status !== 'done' ? 'available' : 'unavailable');
      } catch {
        // Keep available on error (absent repo in test harnesses, transient I/O failures).
        if (!cancelled) setProbe('available');
      }
    };
    void check();
    return (): void => {
      cancelled = true;
    };
  }, [pinnedSprintId, sprintRepo]);

  return probe;
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
 * Converges the global selection onto this run's pinned sprint whenever focus lands on a
 * session pinned to a DIFFERENT sprint (Tab / Ctrl+1..9 / Sessions-open, or the initial mount
 * right after a launch). Without this, `n → Flows` (and every other selection-reading surface)
 * still targets whatever was picked before the focus switch, not the run on screen.
 *
 * Only acts once `pinnedSprintProbe === 'available'` (undefined ids, an in-flight probe, and a
 * closed/removed pin all skip) and only when the pin differs from the live selection — the
 * latter also makes this loop-safe: the write below lands the two in sync on the next render, so
 * the guard trips and the effect goes quiet; it never re-fires from its own update.
 *
 * `followFocusedRun` (not `setProjectAndSprint`) is deliberately non-persisting: this fires from
 * a passive effect reacting to focus, not an explicit pick, so a purely exploratory Tab-cycle
 * through old sessions must never overwrite the next boot's default sprint. It still records
 * `lastSwitch` so Home's "✓ now on …" toast fires — the switch changes real behaviour (what the
 * next flow launch targets), so it must be visible, not silent.
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
  const pinnedSprintProbe = usePinnedSprintProbe({ pinnedSprintId, sprintRepo });

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

  return { pinnedSprintStale: pinnedSprintId !== undefined && pinnedSprintProbe === 'unavailable' };
};
