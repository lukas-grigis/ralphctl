/**
 * Location line — row 1 of every frame. Left: where you are in the ACTIVE section's stack
 * (`▣ Sprints › ready to implement — subtitle`). Right: the working context the next action will
 * target (`Hello Python › ready to implement [ACTIVE]`, with `S switch` from `lg`).
 *
 * Fitting (subtitle → trail → status chip → names) lives in {@link layoutLocation}; this
 * component resolves the labels and paints the result. Always exactly one row. Hidden while no
 * section is active (the first-run wizard).
 *
 * The right side coalesces from ONE source: when an Execute view is focused, both labels come from
 * the run's pinned context; otherwise both come from the global selection — never one from each.
 * A project-only run (detect-scripts) therefore shows no sprint rather than a stale one.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { breakpoints, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useRouter, type ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import { useViewTitle } from '@src/application/ui/tui/runtime/view-title-context.tsx';
import { ROUTE_LABELS, sectionDef } from '@src/application/ui/tui/runtime/nav-tree.ts';
import { sprintStatusKind, type StatusKind } from '@src/application/ui/tui/components/status-chip.tsx';
import {
  layoutLocation,
  type LocationSegment,
  type LocationTone,
} from '@src/application/ui/tui/components/location-layout.ts';

/** Detail routes whose crumb is the entity's own name: the route prop that carries it, else the selection's label. */
const DETAIL_CRUMB: Readonly<Record<string, { readonly prop: string; readonly selected: 'project' | 'sprint' }>> = {
  'project-detail': { prop: 'projectName', selected: 'project' },
  'sprint-detail': { prop: 'sprintName', selected: 'sprint' },
};

const CHIP_COLOR: Readonly<Record<StatusKind, string>> = {
  success: inkColors.success,
  warning: inkColors.warning,
  error: inkColors.error,
  info: inkColors.info,
  muted: inkColors.muted,
  highlight: inkColors.highlight,
};

const toneProps = (
  tone: LocationTone,
  chipColor: string
): { readonly color?: string; readonly bold?: boolean; readonly dimColor?: boolean } => {
  switch (tone) {
    case 'badge':
      return { color: inkColors.primary, bold: true };
    case 'section':
      return { bold: true };
    case 'name':
      return { color: inkColors.primary, bold: true };
    case 'key':
      return { color: inkColors.highlight, bold: true };
    case 'chip':
      return { color: chipColor, bold: true };
    case 'trail':
      return {};
    case 'subtitle':
    case 'dim':
      return { dimColor: true };
  }
};

const Segments = ({
  segments,
  chipColor,
}: {
  readonly segments: readonly LocationSegment[];
  readonly chipColor: string;
}): React.JSX.Element => (
  <>
    {segments.map((seg, i) => (
      <Text key={`${String(i)}-${seg.text}`} {...toneProps(seg.tone, chipColor)}>
        {seg.text}
      </Text>
    ))}
  </>
);

type SelectionApi = ReturnType<typeof useSelection>;

/**
 * Right-hand context. A focused run pins BOTH labels (a project-only run shows no sprint); with no
 * run focused both come from the global selection. The status chip only ever comes from the
 * selection — the focused-run context carries labels only, so a stale lifecycle status never rides
 * along with a run's sprint.
 */
const useWorkingContext = (
  selection: SelectionApi
): {
  readonly project: string | undefined;
  readonly sprint: string | undefined;
  readonly status: string | undefined;
} => {
  const ui = useUiState();
  const runFocused = ui.focusedRunProjectLabel !== undefined;
  return {
    project: runFocused ? ui.focusedRunProjectLabel : selection.projectLabel,
    sprint: runFocused ? ui.focusedRunSprintLabel : selection.sprintLabel,
    status: runFocused ? undefined : selection.sprintStatus,
  };
};

/** Crumb for one stack entry: the entity's own name on detail routes, else the route label. */
const crumbFor = (entry: ViewEntry, selection: SelectionApi): string => {
  const detail = DETAIL_CRUMB[entry.id];
  if (detail === undefined) return ROUTE_LABELS[entry.id];
  const own = entry.props?.[detail.prop];
  if (typeof own === 'string') return own;
  return (detail.selected === 'project' ? selection.projectLabel : selection.sprintLabel) ?? ROUTE_LABELS[entry.id];
};

/** Labels for every entry above the section root; Execute's last crumb names the flow it runs. */
const trailFor = (
  stack: readonly ViewEntry[],
  current: ViewEntry,
  crumb: string | undefined,
  selection: SelectionApi
): string[] => {
  const trail = stack.slice(1).map((entry) => crumbFor(entry, selection));
  if (crumb !== undefined && current.id === 'execute' && trail.length > 0) trail[trail.length - 1] = crumb;
  return trail;
};

export const LocationBar = (): React.JSX.Element | null => {
  const router = useRouter();
  const selection = useSelection();
  const { columns } = useTerminalSize();
  const view = useViewTitle();
  const { project, sprint, status } = useWorkingContext(selection);
  if (router.activeSection === 'none') return null;

  const trail = trailFor(router.stack, router.current, view?.crumb, selection);

  const layout = layoutLocation({
    columns,
    wide: columns >= breakpoints.lg,
    section: sectionDef(router.activeSection)?.label ?? ROUTE_LABELS[router.stack[0]?.id ?? 'home'],
    trail,
    subtitle: view?.subtitle,
    ...(view?.right !== undefined && view.rightWidth !== undefined ? { leftExtraWidth: view.rightWidth } : {}),
    project,
    sprint,
    status,
  });
  const chipColor = CHIP_COLOR[sprintStatusKind(status)];

  return (
    <Box paddingX={spacing.indent} justifyContent="space-between" height={1}>
      <Box flexShrink={0}>
        <Text wrap="truncate-end">
          <Segments segments={layout.left} chipColor={chipColor} />
        </Text>
        {view?.right !== undefined && <Box marginLeft={1}>{view.right}</Box>}
      </Box>
      {layout.right.length > 0 && (
        <Box flexShrink={0}>
          <Text wrap="truncate-end">
            <Segments segments={layout.right} chipColor={chipColor} />
          </Text>
        </Box>
      )}
    </Box>
  );
};
