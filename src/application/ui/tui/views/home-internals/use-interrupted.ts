/** Work's interrupted tasks: the pure list from the snapshot, plus the disk facts and stale run records behind it. */

import { useEffect, useMemo, useState } from 'react';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useSessions } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import {
  interruptedTasksOf,
  stoppedTaskIds,
  loadInterruptedFacts,
  type InterruptedFacts,
  type InterruptedTask,
} from '@src/application/ui/shared/interrupted-tasks.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';

export interface InterruptedState {
  readonly tasks: readonly InterruptedTask[];
  readonly ids: ReadonlySet<string>;
  /** In-progress tasks whose last attempt was stopped, with nothing running them. */
  readonly stoppedIds: ReadonlySet<string>;
  readonly facts: ReadonlyMap<string, InterruptedFacts>;
  /** Run records of this sprint whose owner is gone; resuming supersedes them. */
  readonly staleRunIds: readonly string[];
  /** Another live ralphctl process works the sprint, or that is still being checked — nothing is interrupted then. */
  readonly ownedElsewhere: boolean;
  /** Drops the stale records — called when the operator resumes. */
  readonly dismissStale: () => Promise<void>;
}

const NONE: ReadonlyMap<string, InterruptedFacts> = new Map();
const NO_TASKS: readonly InterruptedTask[] = [];

/** Re-check so the tasks surface once the other process dies. */
const OWNER_RECHECK_MS = 5_000;

interface Loaded {
  readonly key: string;
  readonly ownedElsewhere: boolean;
  readonly facts: ReadonlyMap<string, InterruptedFacts>;
  readonly staleRunIds: readonly string[];
}

const loadFacts = async (
  deps: Pick<AppDeps, 'gitRunner' | 'storage' | 'detectInterruptedRuns'>,
  project: Project,
  sprint: Sprint,
  tasks: readonly Task[],
  candidates: readonly InterruptedTask[]
): Promise<Pick<Loaded, 'facts' | 'staleRunIds'>> => {
  const [facts, detected] = await Promise.all([
    loadInterruptedFacts(
      { gitRunner: deps.gitRunner, dataRoot: deps.storage.dataRoot },
      project,
      sprint,
      tasks,
      candidates
    ),
    deps.detectInterruptedRuns.execute(),
  ]);
  const records = detected.ok ? detected.value.map((d) => d.record).filter((r) => r.sprintId === sprint.id) : [];
  const since = records.reduce((latest, r) => Math.max(latest, Date.parse(r.updatedAt)), 0);
  return {
    facts: new Map([...facts].map(([id, f]) => [id, since > 0 ? { ...f, since } : f])),
    staleRunIds: records.map((r) => r.runId),
  };
};

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
  const candidates = useMemo(
    () => interruptedTasksOf(snapshot?.tasks ?? [], implementRunning),
    [snapshot?.tasks, implementRunning]
  );

  const stoppedIds = useMemo(
    () => stoppedTaskIds(snapshot?.tasks ?? [], implementRunning),
    [snapshot?.tasks, implementRunning]
  );

  const [loaded, setLoaded] = useState<Loaded>({ key: '', ownedElsewhere: false, facts: NONE, staleRunIds: [] });
  const [recheck, setRecheck] = useState(0);
  const key = `${sprint?.id ?? ''}|${candidates.map((t) => `${t.taskId}:${String(t.startedAt)}`).join(',')}`;
  const project = snapshot?.project;

  useEffect(() => {
    if (sprint === undefined || project === undefined || candidates.length === 0) return undefined;
    let cancelled = false;
    void (async (): Promise<void> => {
      // Unknown ownership must not paint a live run as a crash: the rows stay hidden and the check repeats.
      const owner = await deps.findLiveSprintOwner.execute(sprint).catch(() => undefined);
      const elsewhere = owner === undefined || !owner.ok || owner.value !== undefined;
      if (cancelled) return;
      setLoaded({ key, ownedElsewhere: elsewhere, facts: NONE, staleRunIds: [] });
      if (elsewhere) return;
      try {
        const found = await loadFacts(deps, project, sprint, snapshot?.tasks ?? [], candidates);
        if (!cancelled) setLoaded({ key, ownedElsewhere: false, ...found });
      } catch {
        // Facts are an enrichment: the row stands without them.
      }
    })();
    return (): void => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures what the probes depend on
  }, [key, recheck]);

  const current = loaded.key === key;
  const ownedElsewhere = candidates.length > 0 && (!current || loaded.ownedElsewhere);

  useEffect(() => {
    if (!current || !loaded.ownedElsewhere) return undefined;
    const timer = setTimeout(() => setRecheck((n) => n + 1), OWNER_RECHECK_MS);
    return (): void => clearTimeout(timer);
  }, [current, loaded]);

  const tasks = ownedElsewhere ? NO_TASKS : candidates;
  const ids = useMemo(() => new Set(tasks.map((t) => t.taskId)), [tasks]);
  const staleRunIds = current && !ownedElsewhere ? loaded.staleRunIds : [];
  const dismissStale = async (): Promise<void> => {
    if (staleRunIds.length === 0) return;
    try {
      await deps.dismissInterruptedRuns.execute(staleRunIds);
    } catch {
      // A record that outlives its resume is only clutter in Runs; never block the launch on it.
    }
  };

  return {
    tasks,
    ids,
    stoppedIds,
    facts: current && !ownedElsewhere ? loaded.facts : NONE,
    staleRunIds,
    ownedElsewhere,
    dismissStale,
  };
};
