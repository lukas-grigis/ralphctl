/**
 * ImplementMainArea — the right-hand main pane of the redesigned Implement view (≥140 col
 * breakpoint). A thin typed wrapper over `TasksPanelHost`: it forwards every prop unchanged
 * (its `ImplementMainAreaProps` is an alias of `TasksPanelHostProps`) and exists only to give the
 * wide-layout main pane its own named seam.
 *
 * Passive-minimap model (v0.7.0): the main-area cards are the sole input owner (via the forwarded
 * `inputActive`), and `onFocusedCardChange` is what `WideLayout` stores as `focusedTaskId` and
 * passes to `ImplementSidebar` so the sidebar highlights the focused card — no separate sidebar
 * cursor, no Tab toggle, no imperative handle.
 */

import React from 'react';
import {
  TasksPanelHost,
  type TasksPanelHostProps,
} from '@src/application/ui/tui/views/execute-view-internals/tasks-panel-host.tsx';

export type ImplementMainAreaProps = TasksPanelHostProps;

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
