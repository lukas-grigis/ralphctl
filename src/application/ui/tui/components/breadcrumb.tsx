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
import { StatusChip, sprintStatusKind } from '@src/application/ui/tui/components/status-chip.tsx';
import { ROUTE_LABELS } from '@src/application/ui/tui/runtime/nav-tree.ts';
import { useBreakpoint } from '@src/application/ui/tui/runtime/use-breakpoint.ts';

/** Detail routes whose crumb is the entity's own name: the route prop that carries it, else the selection's label. */
const DETAIL_CRUMB: Readonly<Record<string, { readonly prop: string; readonly selected: 'project' | 'sprint' }>> = {
  'project-detail': { prop: 'projectName', selected: 'project' },
  'sprint-detail': { prop: 'sprintName', selected: 'sprint' },
};

const breadcrumbLabel = (id: string): string => (ROUTE_LABELS as Record<string, string | undefined>)[id] ?? id;

export const Breadcrumb = (): React.JSX.Element => {
  const router = useRouter();
  const selection = useSelection();
  const ui = useUiState();
  const { atLeast } = useBreakpoint();
  // When an Execute view is focused, BOTH right-side labels coalesce from its pinned context
  // as a single unit — never one from the run and the other from the mutable global selection.
  // A run always pins a project label, so its presence is the canonical "run focused" signal.
  // Gating the two lookups independently let a project-only run (e.g. detect-scripts, no
  // sprint) pair the run's project with a stale global sprint label; gating them together
  // means a focused run with no sprint shows no sprint label at all (the correct outcome).
  const runFocused = ui.focusedRunProjectLabel !== undefined;
  const effectiveProjectLabel = runFocused ? ui.focusedRunProjectLabel : selection.projectLabel;
  const effectiveSprintLabel = runFocused ? ui.focusedRunSprintLabel : selection.sprintLabel;
  // Status chip: only available from the global selection (focused-run context carries labels
  // only — the sprint lifecycle may change while a run is in progress so no stale status leaks).
  const effectiveSprintStatus = runFocused ? undefined : selection.sprintStatus;
  // Substitute the concrete project / sprint name for the generic stack-id label so the
  // breadcrumb reads "Home → Projects → experience hub" instead of "… → Project". Selection
  // is set immediately before `router.push` in the list views, so it matches the entry that
  // was just pushed; the fallback to the generic label covers the rare case where the user
  // arrives via a path that didn't seed selection.
  //
  // A detail route that carries its own `projectName` / `sprintName` prop labels itself from it —
  // browsing a sprint that is NOT the current one must not show the current sprint's name.
  const labelFor = (entry: { readonly id: string; readonly props?: Readonly<Record<string, unknown>> }): string => {
    const detail = DETAIL_CRUMB[entry.id];
    if (detail === undefined) return breadcrumbLabel(entry.id);
    const own = entry.props?.[detail.prop];
    if (typeof own === 'string') return own;
    return (
      (detail.selected === 'project' ? selection.projectLabel : selection.sprintLabel) ?? breadcrumbLabel(entry.id)
    );
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
            <Box>
              <Text dimColor> {glyphs.bullet} sprint: </Text>
              <Text color={inkColors.primary} bold>
                {right[1]}
              </Text>
              <Text dimColor> </Text>
              <Text color={inkColors.highlight} bold>
                [S]
              </Text>
              {atLeast('md') && effectiveSprintStatus !== undefined && (
                <Box marginLeft={spacing.gutter}>
                  <StatusChip label={effectiveSprintStatus} kind={sprintStatusKind(effectiveSprintStatus)} />
                </Box>
              )}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};
