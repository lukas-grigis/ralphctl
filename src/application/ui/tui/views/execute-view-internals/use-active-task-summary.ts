/**
 * Registers the active-task summary provider with `UiState` and returns the Execute-local `y`
 * (yank) handler, which copies a markdown snapshot of whatever task the operator is currently
 * watching. The provider closes over the latest `currentTask` + display name; React
 * re-runs the effect each render they change, so the closure always reflects the current
 * frame.
 *
 * The registration setters are stable `useCallback`s, so passing them off the merged `ui` object does
 * not re-fire the effect when an unrelated overlay toggle changes that object's identity.
 *
 * Cleanup clears the registration on unmount or when the deps change — important because
 * the yank handler reads the provider through a ref and a stale closure would leak
 * yesterday's task name into copies.
 */

import { useEffect } from 'react';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { useYankTask } from '@src/application/ui/tui/views/execute-view-internals/use-yank-task.ts';
import type { TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import { renderActiveTaskSummary } from '@src/application/ui/tui/runtime/render-active-task-summary.ts';
import type { ActiveTaskSummaryProvider } from '@src/application/ui/tui/runtime/ui-state-context.tsx';

interface UseActiveTaskSummaryInput {
  readonly currentTask: TaskBucket | undefined;
  readonly currentTaskName: string | undefined;
  readonly setActiveTaskSummaryProvider: (provider: ActiveTaskSummaryProvider | undefined) => void;
  readonly getActiveTaskSummary: () => string | undefined;
  readonly eventBus: EventBus;
}

export const useActiveTaskSummary = ({
  currentTask,
  currentTaskName,
  setActiveTaskSummaryProvider,
  getActiveTaskSummary,
  eventBus,
}: UseActiveTaskSummaryInput): (() => void) => {
  useEffect(() => {
    if (currentTask === undefined || currentTaskName === undefined) {
      setActiveTaskSummaryProvider(undefined);
      return undefined;
    }
    const task = currentTask;
    const displayName = currentTaskName;
    setActiveTaskSummaryProvider(() => renderActiveTaskSummary({ task, displayName }));
    return () => {
      setActiveTaskSummaryProvider(undefined);
    };
  }, [currentTask, currentTaskName, setActiveTaskSummaryProvider]);
  return useYankTask({ eventBus, getSummary: getActiveTaskSummary });
};
