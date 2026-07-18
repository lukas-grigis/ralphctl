/**
 * ImplementMainArea — the right-hand main pane of the redesigned Implement view (≥140 col
 * breakpoint). A thin typed wrapper over `TasksPanelHost` that forwards every prop unchanged
 * (`ImplementMainAreaProps` omits only `onExpandedCardChange`, which this component owns) and
 * exists only to give the wide-layout main pane its own named seam.
 *
 * Passive-minimap model (v0.7.0): the main-area cards are the sole input owner (via the forwarded
 * `inputActive`), and `onFocusedCardChange` is what `WideLayout` stores as `focusedTaskId` and
 * passes to `ImplementSidebar` so the sidebar highlights the focused card — no separate sidebar
 * cursor, no Tab toggle, no imperative handle.
 *
 * Esc-collapse-before-pop: while the focused card is expanded, this component claims `esc` via
 * `useUiState().claimEscape()` so the global `router.pop()` (`use-global-keys.ts`) stands down
 * and `TasksPanel`'s own `useInput` handler (`handleEscapeCollapse` in
 * `tasks-panel-internals/keymap.ts`) collapses the card instead. The claim is released the
 * instant the card collapses (or the focused card changes to a collapsed one) and on unmount —
 * see the `useEffect` below, which mirrors the `claimEscape` usage in `sprint-detail-view.tsx`.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  TasksPanelHost,
  type TasksPanelHostProps,
} from '@src/application/ui/tui/views/execute-view-internals/tasks-panel-host.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';

export type ImplementMainAreaProps = Omit<TasksPanelHostProps, 'onExpandedCardChange'>;

/**
 * @public — main pane for the redesigned Implement view; wired by `implement-layout.tsx`.
 */
export const ImplementMainArea = (props: ImplementMainAreaProps): React.JSX.Element | null => {
  const ui = useUiState();
  const claimEscape = ui.claimEscape;
  const [focusedCardExpanded, setFocusedCardExpanded] = useState(false);
  const onExpandedCardChange = useCallback((expanded: boolean) => {
    setFocusedCardExpanded(expanded);
  }, []);

  // Claim `esc` while (and only while) the focused card is expanded. The effect's cleanup —
  // run on every dep change AND on unmount — releases the claim, so toggling collapsed↔expanded
  // repeatedly never double-claims or leaks a stale claim past this component's lifetime.
  useEffect(() => (focusedCardExpanded ? claimEscape() : undefined), [focusedCardExpanded, claimEscape]);

  return <TasksPanelHost {...props} onExpandedCardChange={onExpandedCardChange} />;
};
