/**
 * Loaders + session-manager subscription wiring for the sprint-detail view.
 *
 * Hides three side effects behind one hook so the orchestrator only deals with the result:
 *
 *   1. `useAsyncLoad` fetches sprint + tasks in parallel keyed on `sprintId`.
 *   2. A session-manager subscription reloads whenever a tracked flow status transitions
 *      (registered, running → completed / failed / aborted, or removed) so cancelling or
 *      finishing a flow doesn't leave the view frozen on its mount-time snapshot. We diff
 *      session statuses rather than reloading on every notify() because the session manager
 *      fires on every chain `step` and the trace-only updates would otherwise hammer disk.
 *   3. A best-effort project lookup (no Result envelope leak) used to resolve
 *      `repositoryId → name` for task cards. Failures surface via `logger.warn` rather than
 *      breaking the view.
 */

import React, { useEffect, useState } from 'react';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { type AsyncLoadState, useAsyncLoad } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { useSessionManager } from '@src/application/ui/tui/runtime/sessions-context.tsx';

export interface SprintBundle {
  readonly sprint: Sprint;
  readonly tasks: readonly Task[];
}

interface UseSprintBundleArgs {
  readonly sprintId: SprintId;
  readonly deps: AppDeps;
}

interface UseSprintBundleReturn {
  readonly state: AsyncLoadState<SprintBundle, unknown>;
  readonly project: Project | undefined;
  readonly reload: () => void;
}

export const useSprintBundle = (args: UseSprintBundleArgs): UseSprintBundleReturn => {
  const { sprintId, deps } = args;

  const { state, reload } = useAsyncLoad<SprintBundle>(async () => {
    const [sprintR, tasksR] = await Promise.all([
      deps.sprintRepo.findById(sprintId),
      deps.taskRepo.findBySprintId(sprintId),
    ]);
    if (!sprintR.ok) throw new Error(sprintR.error.message);
    if (!tasksR.ok) throw new Error(tasksR.error.message);
    return { sprint: sprintR.value, tasks: tasksR.value };
  }, [sprintId]);

  // `reload` is a fresh closure each render (no useCallback in useAsyncLoad), so we route it
  // through a ref to keep the subscription stable.
  const sessionMgr = useSessionManager();
  const reloadRef = React.useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    const snapshot = (): Map<string, string> => {
      const m = new Map<string, string>();
      for (const rec of sessionMgr.list()) m.set(rec.descriptor.id, rec.descriptor.status);
      return m;
    };
    let prev = snapshot();
    return sessionMgr.subscribe(() => {
      const next = snapshot();
      let changed = prev.size !== next.size;
      if (!changed) {
        for (const [id, status] of next) {
          if (prev.get(id) !== status) {
            changed = true;
            break;
          }
        }
      }
      prev = next;
      if (changed) reloadRef.current();
    });
  }, [sessionMgr]);

  const [project, setProject] = useState<Project | undefined>(undefined);
  useEffect(() => {
    if (state.kind !== 'ok') {
      setProject(undefined);
      return undefined;
    }
    let cancelled = false;
    const lookup = async (): Promise<void> => {
      const finder = deps.projectRepo?.findById?.bind(deps.projectRepo);
      if (typeof finder !== 'function') return;
      const r = await finder(state.value.sprint.projectId);
      if (cancelled) return;
      if (r.ok) setProject(r.value);
      else {
        // Don't blow up the view — but surface the reason so an operator wondering why repo
        // names render as raw uuids can find it in the log instead of silently shrugging.
        deps.logger?.warn?.('sprint-detail: project lookup failed', {
          projectId: String(state.value.sprint.projectId),
          error: r.error.message,
        });
      }
    };
    lookup().catch((err: unknown) => {
      deps.logger?.warn?.('sprint-detail: project lookup threw', {
        projectId: String(state.value.sprint.projectId),
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [state, deps.projectRepo, deps.logger]);

  return { state, project, reload };
};
