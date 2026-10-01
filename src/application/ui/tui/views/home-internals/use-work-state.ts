/** Work's data: the snapshot (kept across reloads), the agenda built from it, and the menu seed. */

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useSessions } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { useAwaitingSessions } from '@src/application/ui/tui/runtime/use-awaiting-sessions.ts';
import { useAppStateSnapshot } from '@src/application/ui/tui/runtime/use-app-state-snapshot.ts';
import type { AsyncLoadState } from '@src/application/ui/tui/runtime/use-async-load.ts';
import {
  buildAgenda,
  initialAgendaRowId,
  type AgendaLaunchability,
  type AgendaRow,
} from '@src/application/ui/tui/views/home-internals/agenda.ts';
import { toAgendaSession } from '@src/application/ui/tui/views/home-internals/agenda-sessions.ts';
import { visibleFlowsFor } from '@src/application/ui/tui/views/flows-visibility.ts';
import { buildNextSteps, nextStepsInputFromSnapshot } from '@src/application/ui/shared/next-steps.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import type { InterruptedFacts } from '@src/application/ui/shared/interrupted-tasks.ts';

/** The last snapshot of the same selection survives a reload, so the agenda never blanks. */
const useStableSnapshot = (state: AsyncLoadState<AppStateSnapshot, unknown>, key: string) => {
  const lastRef = useRef<{ readonly key: string; readonly value: AppStateSnapshot } | undefined>(undefined);
  if (state.kind === 'ok') lastRef.current = { key, value: state.value };
  return lastRef.current?.key === key ? lastRef.current.value : undefined;
};

export interface WorkSnapshot {
  readonly state: AsyncLoadState<AppStateSnapshot, unknown>;
  readonly snapshot: AppStateSnapshot | undefined;
  readonly reload: () => void;
}

export const useWorkSnapshot = (): WorkSnapshot => {
  const selection = useSelection();
  const { state, reload } = useAppStateSnapshot({ liveTasks: true });
  const snapshot = useStableSnapshot(state, `${selection.projectId ?? ''}|${selection.sprintId ?? ''}`);

  // Flows move the sprint status on disk; refresh the cached chip from each load.
  const syncSprintStatus = selection.syncSprintStatus;
  const sprint = snapshot?.sprint;
  useEffect(() => {
    if (sprint !== undefined) syncSprintStatus(sprint.id, sprint.status);
  }, [sprint, syncSprintStatus]);

  return { state, snapshot, reload };
};

export interface WorkAgenda {
  readonly agenda: readonly AgendaRow[];
  readonly showAll: boolean;
  readonly toggleShowAll: () => void;
}

export const useWorkAgenda = (
  snapshot: AppStateSnapshot | undefined,
  launchability: (flowId: string) => AgendaLaunchability,
  interruptedFacts?: ReadonlyMap<string, InterruptedFacts>,
  sprintOwnedElsewhere = false
): WorkAgenda => {
  const sessions = useSessions();
  const awaitingSince = useAwaitingSessions();
  const [showAll, setShowAll] = useState(false);
  const hasProject = snapshot?.project !== undefined;
  const sprint = snapshot?.sprint;

  const agenda = useMemo<readonly AgendaRow[]>(() => {
    if (snapshot === undefined || !hasProject) return [];
    return buildAgenda({
      tasks: snapshot.tasks,
      sprintId: sprint?.id,
      sessions: sessions.map((r) => toAgendaSession(r.descriptor)),
      awaitingSince,
      nextSteps: buildNextSteps(nextStepsInputFromSnapshot(snapshot)).steps,
      visibleFlows: visibleFlowsFor({
        hasProject,
        ...(sprint !== undefined ? { sprintStatus: sprint.status } : {}),
        showAll,
      }),
      showAll,
      launchability,
      now: Date.now(),
      ...(interruptedFacts !== undefined ? { interruptedFacts } : {}),
      sprintOwnedElsewhere,
    });
  }, [
    snapshot,
    hasProject,
    sprint,
    sessions,
    awaitingSince,
    showAll,
    launchability,
    interruptedFacts,
    sprintOwnedElsewhere,
  ]);

  // Elapsed times tick while something runs.
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const hasRunning = agenda.some((r) => r.section === 'running');
  useEffect(() => {
    if (!hasRunning) return undefined;
    const id = setInterval(tick, 1000);
    return (): void => clearInterval(id);
  }, [hasRunning]);

  return { agenda, showAll, toggleShowAll: () => setShowAll((v) => !v) };
};

export interface MenuSeed {
  readonly seedIndex: number;
  /** Bumps when `n` re-enters Work, so the menu remounts and the seed applies again. */
  readonly epoch: number;
  readonly focus: 'flows' | undefined;
}

/** Cursor seed: first FLOWS row for `focus: 'flows'`, else NEEDS YOU → NEXT → FLOWS. */
export const useMenuSeed = (agenda: readonly AgendaRow[], focusProp: 'flows' | undefined): MenuSeed => {
  const router = useRouter();
  const entry = router.current;
  const focus = focusProp ?? (entry.props?.focus === 'flows' ? 'flows' : undefined);
  const populated = agenda.length > 0;

  const seedId = useMemo(
    () =>
      (focus === 'flows'
        ? agenda.find((r) => r.section === 'flows' && r.disabledReason === undefined)?.id
        : undefined) ?? initialAgendaRowId(agenda),
    // Only the first populated agenda seeds; later reloads never move the cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [populated, focus]
  );

  const [epoch, setEpoch] = useState(0);
  const lastEntryRef = useRef(entry);
  useEffect(() => {
    if (lastEntryRef.current === entry) return;
    lastEntryRef.current = entry;
    if (focus === 'flows') setEpoch((n) => n + 1);
  }, [entry, focus]);

  return {
    seedIndex: Math.max(
      0,
      agenda.findIndex((r) => r.id === seedId)
    ),
    epoch,
    focus,
  };
};
