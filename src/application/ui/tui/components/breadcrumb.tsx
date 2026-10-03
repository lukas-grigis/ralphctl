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
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import { chipCellsFor, fitBreadcrumbRight, type FitResult } from '@src/application/ui/tui/components/breadcrumb-fit.ts';
import { useShortTerminal } from '@src/application/ui/tui/runtime/use-short-terminal.ts';
import { useBreakpoint } from '@src/application/ui/tui/runtime/use-breakpoint.ts';

/** Route-id → display label for the breadcrumb path. Anything absent falls back to the raw id. */
const ROUTE_LABELS: Record<string, string> = {
  home: 'Home',
  flows: 'Flows',
  projects: 'Projects',
  'project-detail': 'Project',
  sprints: 'Sprints',
  'sprint-detail': 'Sprint',
  tasks: 'Tasks',
  execute: 'Implement',
  sessions: 'Sessions',
  settings: 'Settings',
  doctor: 'Doctor',
  housekeeping: 'Housekeeping',
  help: 'Help',
  welcome: 'Welcome',
  'create-project': 'New project',
  'add-repository': 'Add repository',
  'add-ticket': 'Add ticket',
  'pick-project': 'Pick project',
  'pick-sprint': 'Pick sprint',
};

const breadcrumbLabel = (id: string): string => ROUTE_LABELS[id] ?? id;

const RightSide = ({
  fit,
  status,
}: {
  readonly fit: FitResult;
  readonly status: string | undefined;
}): React.JSX.Element => (
  <Box flexShrink={0}>
    <Text wrap="truncate-end">
      <Text dimColor>project: </Text>
      <Text color={inkColors.primary} bold>
        {fit.project}
      </Text>
      <Text dimColor> </Text>
      <Text color={inkColors.highlight} bold>
        [P]
      </Text>
      {fit.sprint !== undefined && (
        <>
          <Text dimColor> {glyphs.bullet} sprint: </Text>
          <Text color={inkColors.primary} bold>
            {fit.sprint}
          </Text>
          <Text dimColor> </Text>
          <Text color={inkColors.highlight} bold>
            [S]
          </Text>
          {fit.showChip && status !== undefined && (
            <>
              <Text>{' '.repeat(spacing.gutter)}</Text>
              <StatusChip label={status} kind={sprintStatusKind(status)} />
            </>
          )}
        </>
      )}
    </Text>
  </Box>
);

export const Breadcrumb = (): React.JSX.Element => {
  const router = useRouter();
  const selection = useSelection();
  const ui = useUiState();
  const { atLeast } = useBreakpoint();
  const short = useShortTerminal();
  const { columns } = useTerminalSize();
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

  // The path keeps its start; the right side is fitted to what is left, clipping names (not hints or the badge) first.
  const chipCells = chipCellsFor(right[1] !== undefined && atLeast('md') ? effectiveSprintStatus : undefined);
  const fit =
    right[0] === undefined
      ? undefined
      : fitBreadcrumbRight({
          budget: columns - 2 * spacing.indent - [...path].length - 1,
          project: right[0],
          sprint: right[1],
          chipCells,
        });

  return (
    <Box
      paddingX={spacing.indent}
      marginTop={short ? 0 : spacing.section}
      marginBottom={short ? 0 : spacing.section}
      justifyContent="space-between"
    >
      <Box flexShrink={1} minWidth={0} marginRight={1}>
        <Text dimColor wrap="truncate-end">
          {path}
        </Text>
      </Box>
      {fit !== undefined && <RightSide fit={fit} status={effectiveSprintStatus} />}
    </Box>
  );
};
