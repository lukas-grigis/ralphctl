/**
 * Context switcher — the one overlay for "which project and sprint am I working on?". It never navigates.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { AsyncListFrame } from '@src/application/ui/tui/components/async-list-frame.tsx';
import { EmptyState } from '@src/application/ui/tui/components/empty-state.tsx';
import { FooterBar } from '@src/application/ui/tui/components/status-bar.tsx';
import type { FitHint } from '@src/application/ui/tui/components/hint-budget.ts';
import {
  borderGlyphs,
  breakpoints,
  glyphs,
  inkColors,
  listCapacity,
  spacing,
} from '@src/application/ui/tui/theme/tokens.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useUiState, type SwitcherFocus } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useLaunchCreateSprint } from '@src/application/ui/tui/runtime/use-launch-create-sprint.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { CursorRow, PickerData } from '@src/application/ui/tui/components/context-switcher-internals/types.ts';
import {
  cursorableRows,
  preferredCursorId,
} from '@src/application/ui/tui/components/context-switcher-internals/group-builder.ts';
import { PickerRowList } from '@src/application/ui/tui/components/context-switcher-internals/row-views.tsx';
import { usePickerRows } from '@src/application/ui/tui/components/context-switcher-internals/use-picker-rows.ts';

/** The widest the box grows on a big terminal. */
const MAX_BOX_WIDTH = 96;
/** Rows the frame spends outside the list: tab bar, location line, rule, footer (2), box border (2), summary (1). */
const CHROME_ROWS = 9;
/** Border (2) + horizontal padding (2). */
const BOX_FRAME_WIDTH = 4;

const CREATE_SPRINT_BANNER_ID = 'switcher-create-sprint';

const TITLES: Readonly<Record<SwitcherFocus, { readonly key: string; readonly title: string }>> = {
  sprint: { key: 'S', title: 'switch sprint or project' },
  project: { key: 'P', title: 'switch project' },
};

/** `╭─ S switch sprint or project ───╮` — the title sits in the top border; Ink borders cannot. */
const TopBorder = ({ width, focus }: { readonly width: number; readonly focus: SwitcherFocus }): React.JSX.Element => {
  const { key, title } = TITLES[focus];
  const { tl, tr, h } = borderGlyphs.round;
  const used = [...`${tl}${h} ${key} ${title} `].length + 1;
  return (
    <Text color={inkColors.primary}>
      {`${tl}${h} `}
      <Text bold>{key}</Text>
      {` ${title} `}
      {h.repeat(Math.max(0, width - used))}
      {tr}
    </Text>
  );
};

interface SummaryProps {
  readonly sprintCount: number;
  readonly projectCount: number;
  readonly scopeAll: boolean;
  readonly hideDone: boolean;
  readonly wide: boolean;
}

const Summary = ({ sprintCount, projectCount, scopeAll, hideDone, wide }: SummaryProps): React.JSX.Element => (
  <Box justifyContent="space-between">
    <Text dimColor>
      {String(sprintCount)} sprint{sprintCount === 1 ? '' : 's'} {glyphs.bullet} {String(projectCount)} project
      {projectCount === 1 ? '' : 's'} {glyphs.bullet} scope: {scopeAll ? (wide ? 'all projects' : 'all') : 'current'}
    </Text>
    <Text dimColor>
      t scope {glyphs.bullet} f hide done: {hideDone ? 'on' : 'off'}
    </Text>
  </Box>
);

export interface ContextSwitcherProps {
  readonly focus: SwitcherFocus;
}

type SelectionApi = ReturnType<typeof useSelection>;

/** What each row does on `↵` (and what `c` / `esc` do), as one hook. */
const useSwitcherActions = (
  selection: SelectionApi,
  data: PickerData,
  setFeedback: (text: string | undefined) => void
): {
  readonly onSubmit: (row: CursorRow) => void;
  readonly createSprint: () => void;
  readonly createProject: () => void;
} => {
  const closeOverlay = useUiState().closeOverlay;
  const router = useRouter();
  const deps = useDeps();
  // The overlay closes before the launch settles, so a launch failure goes to the view's banner, not local feedback.
  const onLaunchError = useCallback(
    (text: string): void => {
      const bus = deps.eventBus;
      if (bus === undefined) return;
      bus.publish({
        type: 'banner-show',
        id: CREATE_SPRINT_BANNER_ID,
        tier: 'error',
        message: text,
        at: IsoTimestamp.now(),
      });
    },
    [deps.eventBus]
  );
  const launchCreateSprint = useLaunchCreateSprint({
    onError: onLaunchError,
    noProjectMessage: NO_PROJECT_MESSAGE,
  });
  const createSprint = (): void => {
    if (selection.projectId === undefined) {
      setFeedback(NO_PROJECT_MESSAGE);
      return;
    }
    // Close first: the launch pushes the Execute view (and may raise prompts) onto the stack.
    closeOverlay();
    void launchCreateSprint();
  };

  const createProject = (): void => {
    closeOverlay();
    router.push({ id: 'create-project' });
  };

  const onSubmit = (row: CursorRow): void => {
    if (row.kind === 'create') {
      createSprint();
      return;
    }
    if (row.kind === 'create-project') {
      createProject();
      return;
    }
    if (row.kind === 'header') {
      if (row.projectId !== undefined) selection.setProject(row.projectId, row.label);
      closeOverlay();
      return;
    }
    const sprint = row.sprint;
    const project = data.projectsById.get(sprint.projectId);
    // Orphan sprint (its project was deleted): fall back to a plain sprint switch — it surfaces
    // under whatever project the selection still points at, or none.
    if (project !== undefined) {
      selection.setProjectAndSprint(project.id, project.displayName, sprint.id, sprint.name, sprint.status);
    } else {
      selection.setSprint(sprint.id, sprint.name, sprint.status);
    }
    closeOverlay();
  };
  return { onSubmit, createSprint, createProject };
};

const switcherHints = (canCreate: boolean): FitHint[] => [
  { keys: '↑/↓', label: 'move' },
  { keys: '↵', label: 'switch' },
  ...(canCreate ? [{ keys: 'c', label: 'new sprint' }] : []),
  { keys: 'n', label: 'new project' },
  { keys: 't', label: 'scope' },
  { keys: 'f', label: 'hide done' },
  { keys: 'esc', label: 'close' },
];

const NO_PROJECT_MESSAGE = `${glyphs.cross} select a project first`;

const EmptyBody = ({
  hiddenByDoneFilter,
  scopeAll,
}: {
  readonly hiddenByDoneFilter: boolean;
  readonly scopeAll: boolean;
}): React.JSX.Element =>
  hiddenByDoneFilter ? (
    <EmptyState title="All sprints here are done (hidden)." hint="Press f to show them, or c to create a new one." />
  ) : (
    <EmptyState
      title="No sprints yet."
      hint={scopeAll ? 'Press c to create one.' : 'Press t to show all projects, or c to create one.'}
    />
  );

export const ContextSwitcher = ({ focus }: ContextSwitcherProps): React.JSX.Element => {
  const deps = useDeps();
  const selection = useSelection();
  const ui = useUiState();
  const { columns, rows: termRows } = useTerminalSize();
  const [feedback, setFeedback] = useState<string | undefined>(undefined);

  const picker = usePickerRows(deps, selection.projectId);
  const { state, data, rows, sprintCount, projectCount, hiddenByDoneFilter, scopeAll, hideDone } = picker;
  const { onSubmit, createSprint, createProject } = useSwitcherActions(selection, data, setFeedback);

  const closeOverlay = ui.closeOverlay;
  useInput((input, key) => {
    if (key.ctrl || key.meta) return;
    if (key.escape) {
      closeOverlay();
      return;
    }
    if (input === 't') picker.toggleScope();
    else if (input === 'f') picker.toggleHideDone();
    else if (input === 'c' || input === '+') createSprint();
    else if (input === 'n') createProject();
  });

  const wide = columns >= breakpoints.md;
  // Same two-column inset at every width, so the box never touches the screen edge.
  const boxWidth = Math.min(MAX_BOX_WIDTH, columns - 4);
  const initialCursorId = useMemo(
    () => preferredCursorId(rows, { focus, sprintId: selection.sprintId, projectId: selection.projectId }),
    [rows, focus, selection.sprintId, selection.projectId]
  );
  const hasCursorRows = useMemo(
    () => cursorableRows(rows).some((r) => r.kind === 'sprint' || r.kind === 'header'),
    [rows]
  );

  const hints = switcherHints(selection.projectId !== undefined);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="column" flexGrow={1} marginLeft={spacing.indent}>
        <TopBorder width={boxWidth} focus={focus} />
        <Box
          flexDirection="column"
          width={boxWidth}
          borderStyle="round"
          borderTop={false}
          borderColor={inkColors.primary}
          paddingX={1}
        >
          <Summary
            sprintCount={sprintCount}
            projectCount={projectCount}
            scopeAll={scopeAll}
            hideDone={hideDone}
            wide={wide}
          />
          <AsyncListFrame<PickerData>
            state={state}
            loadingLabel="Loading sprints…"
            errorMessage="Failed to load sprints."
            errorColor={inkColors.error}
            isEmpty={!hasCursorRows}
            empty={<EmptyBody hiddenByDoneFilter={hiddenByDoneFilter} scopeAll={scopeAll} />}
          >
            <PickerRowList
              // Remount (re-seating the cursor) on an explicit scope toggle only; the `f` filter keeps a
              // surviving row focused through `useListWindow`'s own id resolution.
              key={`${String(scopeAll)}-${focus}`}
              rows={rows}
              visibleRows={listCapacity(termRows, { chromeRows: CHROME_ROWS, min: 4 })}
              active
              initialCursorId={initialCursorId}
              currentSprintId={selection.sprintId}
              createLabel={selection.projectLabel}
              onSubmit={onSubmit}
              taskHealthBySprintId={data.taskHealthBySprintId}
              innerWidth={boxWidth - BOX_FRAME_WIDTH}
            />
          </AsyncListFrame>
          {feedback !== undefined && <Text color={inkColors.error}>{feedback}</Text>}
        </Box>
      </Box>
      <FooterBar hints={hints} columns={columns} />
    </Box>
  );
};
