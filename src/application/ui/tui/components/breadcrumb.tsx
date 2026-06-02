/**
 * Breadcrumb strip — renders the router stack on the left so the user always knows where they
 * sit relative to the home view, and the active project + sprint on the right. Sits between
 * the banner and the section stamp so it reads as part of the page header, not the footer
 * chrome.
 *
 * Always renders (even on the root single-entry stack) so the active project label is a
 * stable anchor at the top of every screen.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';

const breadcrumbLabel = (id: string): string => {
  switch (id) {
    case 'home':
      return 'Home';
    case 'flows':
      return 'Flows';
    case 'projects':
      return 'Projects';
    case 'project-detail':
      return 'Project';
    case 'sprints':
      return 'Sprints';
    case 'sprint-detail':
      return 'Sprint';
    case 'tasks':
      return 'Tasks';
    case 'execute':
      return 'Implement';
    case 'sessions':
      return 'Sessions';
    case 'settings':
      return 'Settings';
    case 'doctor':
      return 'Doctor';
    case 'help':
      return 'Help';
    case 'welcome':
      return 'Welcome';
    case 'create-project':
      return 'New project';
    case 'add-repository':
      return 'Add repository';
    case 'add-ticket':
      return 'Add ticket';
    case 'pick-project':
      return 'Pick project';
    case 'pick-sprint':
      return 'Pick sprint';
    default:
      return id;
  }
};

export const Breadcrumb = (): React.JSX.Element => {
  const router = useRouter();
  const selection = useSelection();
  const ui = useUiState();
  // When an Execute view is focused, prefer its pinned project/sprint so the right-side
  // context reflects the run's own sprint rather than the mutable global selection.
  const effectiveProjectLabel = ui.focusedRunProjectLabel ?? selection.projectLabel;
  const effectiveSprintLabel = ui.focusedRunSprintLabel ?? selection.sprintLabel;
  // Substitute the concrete project / sprint name for the generic stack-id label so the
  // breadcrumb reads "Home → Projects → experience hub" instead of "… → Project". Selection
  // is set immediately before `router.push` in the list views, so it matches the entry that
  // was just pushed; the fallback to the generic label covers the rare case where the user
  // arrives via a path that didn't seed selection.
  const labelFor = (entry: { readonly id: string }): string => {
    if (entry.id === 'project-detail' && selection.projectLabel !== undefined) return selection.projectLabel;
    if (entry.id === 'sprint-detail' && selection.sprintLabel !== undefined) return selection.sprintLabel;
    return breadcrumbLabel(entry.id);
  };
  const path =
    router.stack.length > 1
      ? router.stack.map((e) => labelFor(e)).join(` ${glyphs.arrowRight} `)
      : labelFor(router.stack[0] ?? { id: 'home' });

  const right: string[] = [];
  if (effectiveProjectLabel !== undefined) right.push(effectiveProjectLabel);
  if (effectiveSprintLabel !== undefined) right.push(effectiveSprintLabel);

  return (
    <Box
      paddingX={spacing.indent}
      marginTop={spacing.section}
      marginBottom={spacing.section}
      justifyContent="space-between"
    >
      <Box>
        <Text dimColor>{path}</Text>
      </Box>
      {right.length > 0 && (
        <Box>
          <Text dimColor>project: </Text>
          <Text color={inkColors.primary} bold>
            {right[0]}
          </Text>
          <Text dimColor> </Text>
          <Text color={inkColors.highlight} bold>
            [P]
          </Text>
          {right[1] !== undefined && (
            <Text>
              <Text dimColor> {glyphs.bullet} sprint: </Text>
              <Text color={inkColors.primary} bold>
                {right[1]}
              </Text>
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
};
