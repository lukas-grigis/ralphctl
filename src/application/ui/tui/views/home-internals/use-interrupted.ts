/** Work's interrupted tasks: the pure list from the snapshot, plus the disk facts and stale run records behind it. */

import { useEffect, useMemo, useState } from 'react';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useSessions } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import {
  interruptedTasksOf,
  loadInterruptedFacts,
  type InterruptedFacts,
  type InterruptedTask,
} from '@src/application/ui/shared/interrupted-tasks.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';

export interface InterruptedState {
  readonly tasks: readonly InterruptedTask[];
  readonly ids: ReadonlySet<string>;
  readonly facts: ReadonlyMap<string, InterruptedFacts>;
  /** Run records of this sprint whose owner is gone; resuming supersedes them. */
  readonly staleRunIds: readonly string[];
  /** Drops the stale records — called when the operator resumes. */
  readonly dismissStale: () => Promise<void>;
}

const NONE: ReadonlyMap<string, InterruptedFacts> = new Map();

export const useInterrupted = (snapshot: AppStateSnapshot | undefined): InterruptedState => {
  const deps = useDeps();
  const sessions = useSessions();
  const sprint = snapshot?.sprint;
  const implementRunning = sessions.some(
    (r) =>
      r.descriptor.status === 'running' &&
      r.descriptor.flowId === 'implement' &&
      r.descriptor.pinnedSprintId === sprint?.id
  );
  const tasks = useMemo(
    () => interruptedTasksOf(snapshot?.tasks ?? [], implementRunning),
    [snapshot?.tasks, implementRunning]
  );
  const ids = useMemo(() => new Set(tasks.map((t) => t.taskId)), [tasks]);

  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly facts: ReadonlyMap<string, InterruptedFacts>;
    readonly staleRunIds: readonly string[];
  }>({ key: '', facts: NONE, staleRunIds: [] });
  const key = `${sprint?.id ?? ''}|${tasks.map((t) => `${t.taskId}:${String(t.attemptN)}`).join(',')}`;
  const project = snapshot?.project;

  useEffect(() => {
    if (sprint === undefined || project === undefined || tasks.length === 0) return undefined;
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const [facts, detected] = await Promise.all([
          loadInterruptedFacts(
            { gitRunner: deps.gitRunner, dataRoot: deps.storage.dataRoot },
            project,
            sprint,
            snapshot?.tasks ?? [],
            tasks
          ),
          deps.detectInterruptedRuns.execute(),
        ]);
        if (cancelled) return;
        const records = detected.ok ? detected.value.map((d) => d.record).filter((r) => r.sprintId === sprint.id) : [];
        const since = records.reduce((latest, r) => Math.max(latest, Date.parse(r.updatedAt)), 0);
        const withSince = new Map<string, InterruptedFacts>(
          [...facts].map(([id, f]) => [id, since > 0 ? { ...f, since } : f])
        );
        setLoaded({ key, facts: withSince, staleRunIds: records.map((r) => r.runId) });
      } catch {
        // Facts are an enrichment: the row stands without them.
      }
    })();
    return (): void => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures what the probes depend on
  }, [key]);

  const current = loaded.key === key;
  const staleRunIds = current ? loaded.staleRunIds : [];
  const dismissStale = async (): Promise<void> => {
    if (staleRunIds.length === 0) return;
    try {
      await deps.dismissInterruptedRuns.execute(staleRunIds);
    } catch {
      // A record that outlives its resume is only clutter in Runs; never block the launch on it.
    }
  };

  return { tasks, ids, facts: current ? loaded.facts : NONE, staleRunIds, dismissStale };
};
