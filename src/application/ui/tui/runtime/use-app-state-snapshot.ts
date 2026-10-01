/**
 * `useAppStateSnapshot` — loads the {@link AppStateSnapshot} for the current selection and keeps it fresh as the
 * selection changes.
 * @public
 */

import { useEffect, useRef } from 'react';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useAsyncLoad, type UseAsyncLoadResult } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { useSessionTransitionReload } from '@src/application/ui/tui/runtime/use-session-transition-reload.ts';
import { type AppStateSnapshot, loadAppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';

/** Trailing debounce for live task reloads — a burst of task events yields one disk read. */
export const LIVE_TASKS_DEBOUNCE_MS = 750;

export interface UseAppStateSnapshotOptions {
  /** Also reload (debounced) when a task of the selected sprint is evaluated or blocked. */
  readonly liveTasks?: boolean;
}

export const useAppStateSnapshot = (
  opts: UseAppStateSnapshotOptions = {}
): UseAsyncLoadResult<AppStateSnapshot, unknown> => {
  const deps = useDeps();
  const selection = useSelection();
  const result = useAsyncLoad<AppStateSnapshot>(
    () =>
      loadAppStateSnapshot(deps, {
        ...(selection.projectId !== undefined ? { projectId: selection.projectId } : {}),
        ...(selection.sprintId !== undefined ? { sprintId: selection.sprintId } : {}),
      }),
    [selection.projectId, selection.sprintId]
  );
  useSessionTransitionReload(result.reload);

  // Events carry a task id, not a sprint id — "this sprint" means the id is in the loaded task list.
  const taskIdsRef = useRef<ReadonlySet<string>>(new Set());
  if (result.state.kind === 'ok') taskIdsRef.current = new Set(result.state.value.tasks.map((t) => t.id));
  const reloadRef = useRef(result.reload);
  reloadRef.current = result.reload;
  const liveTasks = opts.liveTasks === true;
  useEffect(() => {
    if (!liveTasks) return undefined;
    let timer: NodeJS.Timeout | undefined;
    const unsubscribe = deps.eventBus.subscribe((event) => {
      if (event.type !== 'task-attempt-evaluated' && event.type !== 'task-blocked') return;
      if (!taskIdsRef.current.has(event.taskId)) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        reloadRef.current();
      }, LIVE_TASKS_DEBOUNCE_MS);
    });
    return (): void => {
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [deps.eventBus, liveTasks]);
  return result;
};
