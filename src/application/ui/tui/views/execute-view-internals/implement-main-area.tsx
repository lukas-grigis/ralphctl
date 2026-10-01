/** ImplementMainArea — the right-hand main pane of the redesigned Implement view (≥140 col breakpoint). */

import React, { useCallback, useEffect, useState } from 'react';
import {
  TasksPanelHost,
  type TasksPanelHostProps,
} from '@src/application/ui/tui/views/execute-view-internals/tasks-panel-host.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';

export type ImplementMainAreaProps = Omit<TasksPanelHostProps, 'onExpandedCardChange'>;

/** @public — main pane for the redesigned Implement view; wired by `implement-layout.tsx`. */
export const ImplementMainArea = (props: ImplementMainAreaProps): React.JSX.Element | null => {
  const ui = useUiState();
  const claimEscape = ui.claimEscape;
  const [focusedCardExpanded, setFocusedCardExpanded] = useState(false);
  const onExpandedCardChange = useCallback((expanded: boolean) => {
    setFocusedCardExpanded(expanded);
  }, []);

  // Claim `esc` while (and only while) the focused card is expanded.
  useEffect(() => (focusedCardExpanded ? claimEscape() : undefined), [focusedCardExpanded, claimEscape]);

  return <TasksPanelHost {...props} onExpandedCardChange={onExpandedCardChange} />;
};
