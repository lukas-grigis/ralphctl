/**
 * `useAppStateSnapshot` — loads the {@link AppStateSnapshot} for the current selection and keeps
 * it fresh as the selection changes. Wraps the `useAsyncLoad(() => loadAppStateSnapshot(deps,
 * selection), [selection.projectId, selection.sprintId])` boilerplate that both flows-view and
 * home-view carried verbatim.
 *
 * `AppDeps` structurally satisfies {@link LoadSnapshotDeps}, so the repo trio is passed straight
 * through — no `{ projectRepo, sprintRepo, taskRepo }` wrapper. The selection ids are forwarded
 * with the same `exactOptionalPropertyTypes`-safe conditional spread (omit the key when the id
 * is `undefined`) the call sites used.
 *
 * Also wires {@link useSessionTransitionReload} so every consumer — flows-view, home-view, and
 * any future view built on this hook — refreshes the snapshot the moment a tracked flow
 * completes, fails, or aborts, rather than only on the next selection change or manual `r`.
 *
 * Returns the same `{ state, reload }` shape as {@link useAsyncLoad} so callers narrow on
 * `state.kind` exactly as before.
 *
 * @public
 */

import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useAsyncLoad, type UseAsyncLoadResult } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { useSessionTransitionReload } from '@src/application/ui/tui/runtime/use-session-transition-reload.ts';
import { type AppStateSnapshot, loadAppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';

export const useAppStateSnapshot = (): UseAsyncLoadResult<AppStateSnapshot, unknown> => {
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
  return result;
};
