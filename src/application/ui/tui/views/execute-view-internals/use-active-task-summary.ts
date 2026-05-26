/**
 * Registers the active-task summary provider with `UiState` so the global `y` (yank)
 * hotkey can copy a markdown snapshot of whatever task the operator is currently
 * watching. The provider closes over the latest `currentTask` + display name; React
 * re-runs the effect each render they change, so the closure always reflects the current
 * frame.
 *
 * Cleanup clears the registration on unmount or when the deps change — important because
 * the global handler reads the provider through a ref and a stale closure would leak
 * yesterday's task name into copies.
 */

import { useEffect } from 'react';
import type { TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import { renderActiveTaskSummary } from '@src/application/ui/tui/runtime/render-active-task-summary.ts';
import type { ActiveTaskSummaryProvider } from '@src/application/ui/tui/runtime/ui-state-context.tsx';

interface UseActiveTaskSummaryInput {
  readonly currentTask: TaskBucket | undefined;
  readonly currentTaskName: string | undefined;
  readonly setActiveTaskSummaryProvider: (provider: ActiveTaskSummaryProvider | undefined) => void;
}

export const useActiveTaskSummary = ({
  currentTask,
  currentTaskName,
  setActiveTaskSummaryProvider,
}: UseActiveTaskSummaryInput): void => {
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
};
