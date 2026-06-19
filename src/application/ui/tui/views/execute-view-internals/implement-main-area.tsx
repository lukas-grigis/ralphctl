/**
 * ImplementMainArea — the right-hand main pane of the redesigned Implement view (≥140 col
 * breakpoint). A thin adapter over `TasksPanelHost` that owns input for the task cards and
 * reports the currently-focused card id upward so the sidebar minimap can reflect it.
 *
 * The passive-minimap model (v0.7.0):
 *   - This component is the SOLE input owner for the main-area cards (inputActive = its prop).
 *   - It surfaces `onFocusedCardChange` which `WideLayout` stores as `focusedTaskId` and passes
 *     to `ImplementSidebar`. The sidebar highlights whichever card is focused here — no separate
 *     sidebar cursor, no Tab toggle, no imperative handle.
 *   - `TasksPanelHost` continues to derive every other panel prop (criteria / blocked / warning
 *     maps), so this wrapper stays a pure passthrough plus the callback wiring.
 */

import React from 'react';
import { TasksPanelHost } from '@src/application/ui/tui/views/execute-view-internals/tasks-panel-host.tsx';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { Task } from '@src/domain/entity/task.ts';

export interface ImplementMainAreaProps {
  readonly bucketed: BucketedExecution | undefined;
  readonly descriptor: SessionDescriptor;
  readonly isRunning: boolean;
  readonly maxSignalsPerTask: number;
  /** Card-count budget for the windowed Tasks column (from `layout.tasksMaxBlocks`). */
  readonly maxTasks: number;
  readonly inputActive: boolean;
  readonly now: number;
  readonly taskState: readonly Task[] | undefined;
  /** Fired (deduped) when the focused card id changes — sidebar minimap listens. */
  readonly onFocusedCardChange?: (taskId: string | undefined) => void;
}

/**
 * @public — main pane for the redesigned Implement view; wired by `implement-layout.tsx`.
 */
export const ImplementMainArea = (props: ImplementMainAreaProps): React.JSX.Element | null => (
  // TODO (REQ-3 Esc-collapse): While a focused card is expanded in the main panel, Esc should
  // collapse it instead of popping the route. The correct wire-up:
  //   - `TasksPanel` detects `focusedCardExpanded` (already computed at ~tasks-panel.tsx:237).
  //   - Call `ui.claimEscape()` (from `useUiState()` in `ui-state-context.tsx`) when expanded,
  //     release on collapse / unmount.
  //   - `TasksPanel` is a generic component without TUI context; wiring requires either:
  //     (a) threading `claimEscape`/`releaseEscape` callbacks from `ImplementMainArea` into
  //         `TasksPanelHost` and then into `TasksPanel` (prop drilling), or
  //     (b) a new `onExpandedCardChange` prop on `TasksPanel` so `ImplementMainArea` can call
  //         `useUiState()` here and `claimEscape` / release based on that callback.
  //   Option (b) is cleanest; it mirrors the `onFocusedCardChange` pattern already in place.
  //   Deferred: the global Esc pops the route currently, which is acceptable but not ideal.
  <TasksPanelHost {...props} />
);
