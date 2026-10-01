/**
 * Runs list (the Runs section root) — every runner the manager knows about, live + recent. Selecting a row reopens
 * the execute view for that session.
 */

import React, { useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { EmptyState } from '@src/application/ui/tui/components/empty-state.tsx';
import { runnerStatusKind, StatusChip } from '@src/application/ui/tui/components/status-chip.tsx';
import { OverflowRow, useListWindow, type ListWindow } from '@src/application/ui/tui/components/windowed-list.tsx';
import { ConfirmCard } from '@src/application/ui/tui/components/confirm-card.tsx';
import { glyphs, inkColors, listCapacity, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { plural } from '@src/application/ui/shared/plural.ts';
import { FeedbackLine, feedback, type StructuredFeedback } from '@src/application/ui/tui/components/feedback-line.tsx';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useAwaitingSessions } from '@src/application/ui/tui/runtime/use-awaiting-sessions.ts';
import { useSessionManager, useSessions } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewKeys } from '@src/application/ui/tui/runtime/use-view-keys.ts';
import { listMoveBinding } from '@src/application/ui/tui/runtime/keyboard-map.ts';
import type { SessionRecord } from '@src/application/ui/tui/runtime/session-manager.ts';
import { fmtElapsed } from '@src/application/ui/tui/theme/duration.ts';
import { useBreakpoint } from '@src/application/ui/tui/runtime/use-breakpoint.ts';
import { useInterruptedRuns } from '@src/application/ui/tui/runtime/use-interrupted-runs.ts';
import { flowIdToTitle } from '@src/application/ui/shared/flow-title.ts';
import type { InterruptedRun } from '@src/business/runs/detect-interrupted-runs.ts';

/** Non-list rows consumed by ViewShell chrome + column header + overflow rows + summary + feedback. */
const CHROME_ROWS = 9;
const FLOW_COL_WIDTH = 16;
const STATUS_COL_WIDTH = 14;
const ELAPSED_COL_WIDTH = 10;

/** A row of Runs: a session this process knows, or a run an earlier process left behind. */
type RunItem =
  | { readonly kind: 'session'; readonly record: SessionRecord }
  | { readonly kind: 'interrupted'; readonly run: InterruptedRun };

const itemId = (item: RunItem): string =>
  item.kind === 'session' ? item.record.descriptor.id : `interrupted:${item.run.record.runId}`;

/** Column header above the session rows — widths mirror the row cells below. */
const SessionsHeader = (): React.JSX.Element => (
  <Box paddingX={spacing.indent}>
    <Box width={2} flexShrink={0} />
    <Box flexGrow={1} minWidth={0} marginRight={1}>
      <Text dimColor bold>
        Session
      </Text>
    </Box>
    <Box width={FLOW_COL_WIDTH} flexShrink={0}>
      <Text dimColor bold>
        Flow
      </Text>
    </Box>
    <Box width={STATUS_COL_WIDTH} flexShrink={0}>
      <Text dimColor bold>
        Status
      </Text>
    </Box>
    <Box width={ELAPSED_COL_WIDTH} flexShrink={0}>
      <Text dimColor bold>
        Elapsed
      </Text>
    </Box>
  </Box>
);

interface RowFacts {
  readonly title: string;
  readonly flow: string;
  readonly chip: { readonly label: string; readonly kind: ReturnType<typeof runnerStatusKind> };
  readonly elapsed: string;
}

const factsOf = (item: RunItem, waiting: boolean): RowFacts => {
  if (item.kind === 'interrupted') {
    const { record } = item.run;
    return {
      title: `${flowIdToTitle(record.flowId)} ${glyphs.emDash} interrupted`,
      flow: record.flowId,
      chip: { label: 'interrupted', kind: 'warning' },
      elapsed: fmtElapsed(Date.parse(record.startedAt), Date.parse(record.updatedAt)),
    };
  }
  const d = item.record.descriptor;
  return {
    title: d.title,
    flow: d.flowId,
    chip: { label: waiting ? 'waiting' : d.status, kind: waiting ? 'warning' : runnerStatusKind(d.status) },
    elapsed: fmtElapsed(d.startedAt, d.finishedAt ?? Date.now()),
  };
};

/** One row: focus cursor, title, flow id, status chip, elapsed time. */
const SessionRow = ({
  item,
  focused,
  waiting,
}: {
  readonly item: RunItem;
  readonly focused: boolean;
  readonly waiting: boolean;
}): React.JSX.Element => {
  const facts = factsOf(item, waiting);
  return (
    <Box paddingX={spacing.indent}>
      <Box flexShrink={0}>
        <Text color={focused ? inkColors.primary : inkColors.muted}>{focused ? glyphs.actionCursor : ' '} </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0} marginRight={1}>
        <Text bold={focused} wrap="truncate-end">
          {facts.title}
        </Text>
      </Box>
      <Box width={FLOW_COL_WIDTH} flexShrink={0}>
        <Text bold={focused} dimColor wrap="truncate-end">
          {facts.flow}
        </Text>
      </Box>
      <Box width={STATUS_COL_WIDTH} flexShrink={0}>
        <Text bold={focused}>
          <StatusChip label={facts.chip.label} kind={facts.chip.kind} />
        </Text>
      </Box>
      <Box width={ELAPSED_COL_WIDTH} flexShrink={0}>
        <Text bold={focused} dimColor>
          {facts.elapsed}
        </Text>
      </Box>
    </Box>
  );
};

interface SessionsTableProps {
  readonly window: ListWindow;
  readonly visibleItems: readonly RunItem[];
  readonly focusedIndex: number;
  readonly total: number;
  readonly interruptedCount: number;
  readonly sessionFeedback: StructuredFeedback | undefined;
  readonly awaiting: ReadonlyMap<string, number>;
}

/** Header + windowed rows + count line + feedback — pure props in. */
const SessionsTable = ({
  window,
  visibleItems,
  focusedIndex,
  total,
  interruptedCount,
  sessionFeedback,
  awaiting,
}: SessionsTableProps): React.JSX.Element => (
  <Box flexDirection="column">
    <SessionsHeader />
    <OverflowRow direction="above" count={window.hiddenAbove} />
    {visibleItems.map((s, localIdx) => (
      <SessionRow
        key={itemId(s)}
        item={s}
        focused={window.start + localIdx === focusedIndex}
        waiting={
          s.kind === 'session' && s.record.descriptor.status === 'running' && awaiting.has(s.record.descriptor.id)
        }
      />
    ))}
    <OverflowRow direction="below" count={window.hiddenBelow} />
    {/* Just the count — the key affordances live in the router's hint strip (`useViewKeys`),
        the single source of truth. A second hand-typed strip here would drift from it. */}
    <Box paddingX={spacing.indent} marginTop={spacing.section}>
      <Text dimColor>
        {glyphs.bullet} {plural(total - interruptedCount, 'session')}
        {interruptedCount > 0 ? ` ${glyphs.bullet} ${String(interruptedCount)} interrupted` : ''}
      </Text>
    </Box>
    <FeedbackLine text={sessionFeedback} />
  </Box>
);

const dismissFeedback = (ok: boolean, flowId: string): StructuredFeedback =>
  ok
    ? feedback('success', `dismissed the interrupted ${flowIdToTitle(flowId)} run`)
    : feedback('error', 'could not remove the run record — check the state directory permissions');

interface RunsKeysArgs {
  readonly itemCount: number;
  readonly sessions: readonly SessionRecord[];
  readonly focusedItem: RunItem | undefined;
  readonly active: boolean;
  readonly stopRun: (target: SessionRecord) => void;
  readonly dismiss: (run: InterruptedRun) => void;
}

/** Runs' keys: ↵ open / resume, `c` stop a live session, `d` dismiss an interrupted record — each only on its own row. */
const useRunsKeys = (args: RunsKeysArgs): void => {
  const { itemCount, sessions, focusedItem, active, stopRun, dismiss } = args;
  const kind = focusedItem?.kind;
  useViewKeys(
    [
      { ...listMoveBinding, enabled: itemCount > 0 },
      { keys: ['↵'], hint: kind === 'interrupted' ? 'resume in Work' : 'open', enabled: itemCount > 0 },
      {
        keys: ['c'],
        hint: 'stop run',
        enabled: sessions.length > 0 && kind === 'session',
        run: () => {
          const target = focusedItem?.kind === 'session' ? focusedItem.record : sessions[0];
          if (target !== undefined) stopRun(target);
        },
      },
      {
        keys: ['d'],
        hint: 'dismiss',
        enabled: kind === 'interrupted',
        run: () => {
          if (focusedItem?.kind === 'interrupted') dismiss(focusedItem.run);
        },
      },
    ],
    { active }
  );
};

export const SessionsView = (): React.JSX.Element => {
  const router = useRouter();
  const sessions = useSessions();
  const awaiting = useAwaitingSessions();
  const manager = useSessionManager();
  const ui = useUiState();
  const { rows } = useBreakpoint();
  const interrupted = useInterruptedRuns();

  const [confirmCancel, setConfirmCancel] = useState<SessionRecord | undefined>(undefined);
  const [sessionFeedback, setSessionFeedback] = useState<StructuredFeedback | undefined>(undefined);

  const items = useMemo<readonly RunItem[]>(
    () => [
      ...sessions.map((record): RunItem => ({ kind: 'session', record })),
      ...interrupted.runs.map((run): RunItem => ({ kind: 'interrupted', run })),
    ],
    [sessions, interrupted.runs]
  );

  // List input is live only when no overlay / prompt is mounted; the global-key mute is claimed
  // separately while the confirm prompt is up.
  const listActive = !ui.modalOpen && confirmCancel === undefined;

  const { window, visibleItems, focusedIndex, focusedItem } = useListWindow<RunItem>({
    items,
    getId: itemId,
    visibleRows: listCapacity(rows, { chromeRows: CHROME_ROWS, min: 5, max: 15 }),
    active: listActive,
    onSubmit: (item) =>
      item.kind === 'session'
        ? router.push({ id: 'execute', props: { sessionId: item.record.descriptor.id } })
        : router.reset({ id: 'home' }),
  });
  useRunsKeys({
    itemCount: items.length,
    sessions,
    focusedItem: focusedItem ?? items[0],
    active: listActive,
    stopRun: (target) => {
      // A finished run has nothing to abort.
      if (target.descriptor.status !== 'running') {
        setSessionFeedback(feedback('error', `session is ${target.descriptor.status}, nothing to stop`));
        return;
      }
      setConfirmCancel(target);
    },
    dismiss: ({ record }) => {
      void interrupted.dismiss(record.runId).then((ok) => setSessionFeedback(dismissFeedback(ok, record.flowId)));
    },
  });

  const handleCancelConfirmed = (target: SessionRecord, confirmed: boolean): void => {
    setConfirmCancel(undefined);
    if (!confirmed) return;
    manager.abort(target.descriptor.id);
    setSessionFeedback(feedback('success', `requested stop for ${target.descriptor.title}`));
  };

  return (
    <ViewShell title="Runs" subtitle="every chain run, live and recent" suppressScrollArrows>
      {confirmCancel !== undefined ? (
        <ConfirmCard
          verb="Stop run"
          target={confirmCancel.descriptor.title}
          body={<Text dimColor>The runner stops at the next safe point; partial progress is retained on disk.</Text>}
          onSubmit={(value) => handleCancelConfirmed(confirmCancel, value)}
          onCancel={() => setConfirmCancel(undefined)}
        />
      ) : items.length === 0 ? (
        <EmptyState title="No sessions yet" hint="Start a flow from Work (1)." />
      ) : (
        <SessionsTable
          window={window}
          visibleItems={visibleItems}
          focusedIndex={focusedIndex}
          total={items.length}
          interruptedCount={interrupted.runs.length}
          sessionFeedback={sessionFeedback}
          awaiting={awaiting}
        />
      )}
    </ViewShell>
  );
};
