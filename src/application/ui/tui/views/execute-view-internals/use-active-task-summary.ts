/**
 * Registers the active-task summary provider with `UiState` and returns the Execute-local `y` (yank) handler, which
 * copies a markdown snapshot of whatever task the operator is currently watching.
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
