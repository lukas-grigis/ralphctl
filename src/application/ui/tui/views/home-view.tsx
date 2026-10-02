/**
 * Work — the cockpit for the current sprint: the sprint header strip plus ONE agenda (NEEDS YOU → RUNNING → NEXT →
 * FLOWS) where ↵ does the focused row's job.
 */

import React, { useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { ActionMenu, type MenuItem } from '@src/application/ui/tui/components/action-menu.tsx';
import { bannerRows, resolveBannerMode } from '@src/application/ui/tui/components/banner.tsx';
import { SprintHeaderStrip } from '@src/application/ui/tui/components/sprint-header-strip.tsx';
import type { StructuredFeedback } from '@src/application/ui/tui/components/feedback-line.tsx';
import { breakpoints, fluid, glyphs, listCapacity, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useBreakpoint } from '@src/application/ui/tui/runtime/use-breakpoint.ts';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useFlowLauncher } from '@src/application/ui/tui/runtime/use-flow-launcher.ts';
import { StateCard } from '@src/application/ui/tui/views/home-internals/state-card.tsx';
import type { AgendaRow, AgendaSectionId } from '@src/application/ui/tui/views/home-internals/agenda.ts';
import { useInterrupted } from '@src/application/ui/tui/views/home-internals/use-interrupted.ts';
import { GlanceColumn, RECENT_SPRINT_ROWS } from '@src/application/ui/tui/views/home-internals/glance-column.tsx';
import { useFlash, useSwitchToast } from '@src/application/ui/tui/views/home-internals/use-work-feedback.ts';
import {
  useMenuSeed,
  useWorkAgenda,
  useWorkSnapshot,
} from '@src/application/ui/tui/views/home-internals/use-work-state.ts';
import { useResumeAwareLaunch, useWorkActions } from '@src/application/ui/tui/views/home-internals/use-work-actions.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';

const SECTION_LABEL: Readonly<Record<AgendaSectionId, string>> = {
  'needs-you': 'NEEDS YOU',
  running: 'RUNNING',
  next: 'NEXT',
  flows: 'FLOWS',
};

const GLANCE_GAP = 4;
const OVERFLOW_SUFFIX = ':overflow';
/** App chrome: tab bar, location line, two rules, hint row. */
const CHROME_ROWS = 5;

/** Header counts — an overflow row stands for N tasks, not one. */
const sectionCounts = (rows: readonly AgendaRow[]): Readonly<Record<string, number>> => {
  const counts: Record<string, number> = {};
  for (const section of ['needs-you', 'running'] as const) {
    const inSection = rows.filter((r) => r.section === section);
    if (inSection.length === 0) continue;
    const overflows = inSection.filter((r) => r.id.endsWith(OVERFLOW_SUFFIX));
    const hidden = overflows.reduce((sum, r) => sum + Number.parseInt(r.label, 10), 0);
    counts[SECTION_LABEL[section]] = inSection.length - overflows.length + hidden;
  }
  return counts;
};

const rightFact = (row: AgendaRow): { readonly right: string } | Record<string, never> => {
  if (row.fact !== undefined) return { right: row.fact };
  // The create-sprint row shows the chord that does the same.
  return row.action.kind === 'launch-flow' && row.action.flowId === 'create-sprint' ? { right: 'c' } : {};
};

const toMenuItem = (row: AgendaRow, onSelect: () => void): MenuItem => ({
  id: row.id,
  section: SECTION_LABEL[row.section],
  label: row.label,
  onSelect,
  ...(row.glyph !== undefined ? { leading: { glyph: row.glyph, tone: row.tone } } : {}),
  ...rightFact(row),
  ...(row.note !== undefined ? { note: row.note } : {}),
  ...(row.detail !== undefined ? { detail: row.detail } : {}),
  ...(row.costHint !== undefined ? { costHint: row.costHint } : {}),
  ...(row.disabledReason !== undefined ? { disabledReason: row.disabledReason } : {}),
});

const AllFlowsHint = ({ showAll }: { readonly showAll: boolean }): React.JSX.Element => (
  <Box paddingX={spacing.indent}>
    <Text dimColor wrap="truncate-end">
      {glyphs.bullet} v{' '}
      {showAll
        ? 'fewer flows — hides the unavailable ones'
        : 'all flows — adds the unavailable ones, each with its reason'}
    </Text>
  </Box>
);

export interface HomeViewProps {
  /** `flows`: land with the cursor on the first FLOWS row (the `n` accelerator and the `flows` alias). */
  readonly focus?: 'flows';
}

/** Column split and the row budgets of the agenda menu and the task minimap. */
const useWorkLayout = (agenda: readonly AgendaRow[]) => {
  const { rows, columns } = useBreakpoint();
  const router = useRouter();
  const ui = useUiState();
  const bannerHeight = bannerRows(
    resolveBannerMode({ routeId: router.current.id, columns, rows, userToggle: ui.bannerCompact }),
    columns
  );
  const sectionHeaders = new Set(agenda.map((r) => r.section)).size;
  return {
    wide: columns >= breakpoints.lg,
    glanceWidth: fluid(columns, { min: 44, max: 56, ratio: 0.34 }),
    // Chrome + strip (2) + gap + headers + the focused row's detail line + the `v` hint.
    menuRows: listCapacity(rows, { chromeRows: CHROME_ROWS + bannerHeight + 3 + sectionHeaders + 2, min: 3 }),
    taskRows: listCapacity(rows, {
      chromeRows: CHROME_ROWS + bannerHeight + 4 + RECENT_SPRINT_ROWS + 2,
      min: 3,
      max: 10,
    }),
  };
};

export const HomeView = ({ focus: focusProp }: HomeViewProps = {}): React.JSX.Element => {
  const ui = useUiState();
  const selection = useSelection();

  const { state, snapshot, reload } = useWorkSnapshot();
  const launcher = useFlowLauncher({ snapshot, reload });
  const interrupted = useInterrupted(snapshot);
  const { agenda, showAll, toggleShowAll } = useWorkAgenda(
    snapshot,
    launcher.launchability,
    interrupted.facts,
    interrupted.ownedElsewhere
  );
  const { seedIndex, epoch } = useMenuSeed(agenda, focusProp);
  const { flash, show } = useFlash();
  const switchToast = useSwitchToast(selection);
  const [focusedId, setFocusedId] = useState<string | undefined>(undefined);
  const launch = useResumeAwareLaunch(launcher.launch, interrupted.dismissStale);
  const run = useWorkActions({
    snapshot,
    agenda,
    focusedId,
    showAll,
    toggleShowAll,
    launch,
    reload,
    show,
  });

  const items = useMemo(() => agenda.map((row) => toMenuItem(row, () => run(row))), [agenda, run]);

  const sprint = snapshot?.sprint;
  const { wide, glanceWidth, menuRows, taskRows } = useWorkLayout(agenda);

  const feedback: StructuredFeedback | undefined =
    flash ?? (launcher.launchError !== undefined ? { tone: 'error', text: launcher.launchError } : switchToast);

  const agendaBody =
    snapshot?.project === undefined ? null : (
      <Box flexDirection="column">
        {agenda.length > 0 && (
          <ActionMenu
            key={epoch}
            items={items}
            active={!ui.modalOpen}
            initialIndex={seedIndex}
            visibleRows={menuRows}
            sectionCounts={sectionCounts(agenda)}
            sectionGap={0}
            onFocusChange={setFocusedId}
          />
        )}
        {(agenda.some((r) => r.section === 'flows') || showAll) && <AllFlowsHint showAll={showAll} />}
      </Box>
    );

  return (
    <ViewShell
      title="Work"
      subtitle="move the current sprint forward"
      suppressScrollArrows
      {...(feedback !== undefined ? { feedback } : {})}
    >
      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1}>
          <WorkMain state={state} snapshot={snapshot} agendaBody={agendaBody} />
        </Box>
        {wide && snapshot !== undefined && sprint !== undefined && (
          <>
            <Box width={GLANCE_GAP} flexShrink={0} />
            <GlanceColumn
              snapshot={snapshot}
              width={glanceWidth}
              taskRows={taskRows}
              interruptedIds={interrupted.ids}
              stoppedIds={interrupted.stoppedIds}
            />
          </>
        )}
      </Box>
    </ViewShell>
  );
};

const WorkMain = ({
  state,
  snapshot,
  agendaBody,
}: {
  readonly state: ReturnType<typeof useWorkSnapshot>['state'];
  readonly snapshot: AppStateSnapshot | undefined;
  readonly agendaBody: React.JSX.Element | null;
}): React.JSX.Element => {
  if (snapshot === undefined) {
    return state.kind === 'error' ? (
      <Card tone="error" title="Could not load Work">
        <Text>Reading the sprint failed. Press r to retry.</Text>
      </Card>
    ) : (
      <StateCard state={undefined} loading />
    );
  }
  if (snapshot.sprint === undefined) {
    return (
      <Box flexDirection="column">
        <StateCard state={snapshot} loading={false} />
        {agendaBody !== null && <Box marginTop={spacing.section}>{agendaBody}</Box>}
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Box marginBottom={spacing.section}>
        <Box flexGrow={1} flexDirection="column">
          <SprintHeaderStrip snapshot={snapshot} variant="work" />
        </Box>
      </Box>
      {agendaBody}
    </Box>
  );
};
