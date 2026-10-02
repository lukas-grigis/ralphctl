/**
 * Sessions list — every runner the manager knows about, live + recent, plus runs an earlier
 * process left behind (interrupted). Selecting a session row reopens the execute view for it.
 *
 * The focus cursor is identity-based (keyed on the session id, not a list index) via
 * {@link useListWindow}, so it survives a live reorder or eviction of an earlier session instead
 * of jumping to whatever now sits at the old index.
 *
 * Local keys:
 *   ↑/↓  move the focus cursor
 *   ↵    open the execute view for the focused session (an interrupted run sends you Home to resume)
 *   c    abort the focused session (if it's running) after a confirm
 *   d    dismiss the focused interrupted run's record
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { EmptyState } from '@src/application/ui/tui/components/empty-state.tsx';
import { runnerStatusKind, StatusChip } from '@src/application/ui/tui/components/status-chip.tsx';
import { OverflowRow, useListWindow, type ListWindow } from '@src/application/ui/tui/components/windowed-list.tsx';
import { ConfirmPrompt } from '@src/application/ui/tui/prompts/confirm-prompt.tsx';
import { glyphs, inkColors, listCapacity, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { FeedbackLine, feedback, type StructuredFeedback } from '@src/application/ui/tui/components/feedback-line.tsx';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useAwaitingSessions } from '@src/application/ui/tui/runtime/use-awaiting-sessions.ts';
import { useInterruptedRuns } from '@src/application/ui/tui/runtime/use-interrupted-runs.ts';
import { useSessionManager, useSessions } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewKeys } from '@src/application/ui/tui/runtime/use-view-keys.ts';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import type { SessionRecord } from '@src/application/ui/tui/runtime/session-manager.ts';
import { fmtElapsed } from '@src/application/ui/tui/theme/duration.ts';
import { useBreakpoint } from '@src/application/ui/tui/runtime/use-breakpoint.ts';
import { flowIdToTitle } from '@src/application/ui/shared/flow-title.ts';
import type { InterruptedRun } from '@src/business/runs/detect-interrupted-runs.ts';

/** Non-list rows consumed by ViewShell chrome + column header + overflow rows + summary + feedback. */
const CHROME_ROWS = 9;
const FLOW_COL_WIDTH = 16;
const STATUS_COL_WIDTH = 14;
const ELAPSED_COL_WIDTH = 10;

/** A row of Sessions: a session this process knows, or a run an earlier process left behind. */
type RunItem =
  | { readonly kind: 'session'; readonly record: SessionRecord }
  | { readonly kind: 'interrupted'; readonly run: InterruptedRun };

const itemId = (item: RunItem): string =>
  item.kind === 'session' ? item.record.descriptor.id : `interrupted:${item.run.record.runId}`;

/** Column header above the session rows — widths mirror the row cells below. */
const SessionsHeader = (): React.JSX.Element => (
  <Box paddingX={spacing.indent}>
    <Text dimColor bold>
      {'  '}
    </Text>
    <Box flexGrow={1}>
      <Text dimColor bold>
        Session{'  '}
      </Text>
    </Box>
    <Box width={FLOW_COL_WIDTH}>
      <Text dimColor bold>
        Flow{'  '}
      </Text>
    </Box>
    <Box width={STATUS_COL_WIDTH}>
      <Text dimColor bold>
        Status{'  '}
      </Text>
    </Box>
    <Box width={ELAPSED_COL_WIDTH}>
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
      <Text color={focused ? inkColors.primary : inkColors.muted}>{focused ? glyphs.actionCursor : ' '} </Text>
      <Box flexGrow={1}>
        <Text bold={focused}>{facts.title}</Text>
        <Text> </Text>
      </Box>
      <Box width={FLOW_COL_WIDTH}>
        <Text bold={focused} dimColor>
          {facts.flow}
        </Text>
        <Text> </Text>
      </Box>
      <Box width={STATUS_COL_WIDTH}>
        <Text bold={focused}>
          <StatusChip label={facts.chip.label} kind={facts.chip.kind} />
        </Text>
        <Text> </Text>
      </Box>
      <Box width={ELAPSED_COL_WIDTH}>
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
        {glyphs.bullet} {total - interruptedCount} session(s)
        {interruptedCount > 0 ? ` ${glyphs.bullet} ${String(interruptedCount)} interrupted` : ''}
      </Text>
    </Box>
    <FeedbackLine text={sessionFeedback} />
  </Box>
);

const CancelConfirm = ({
  record,
  onSubmit,
  onCancel,
}: {
  readonly record: SessionRecord;
  readonly onSubmit: (value: boolean) => void;
  readonly onCancel: () => void;
}): React.JSX.Element => (
  <Box flexDirection="column" paddingX={spacing.indent}>
    <Text>
      Cancel <Text bold>{record.descriptor.title}</Text>?
    </Text>
    <Text dimColor>The runner stops at the next safe point; partial progress is retained on disk.</Text>
    <Box marginTop={spacing.section}>
      <ConfirmPrompt message="Cancel?" defaultYes={false} onSubmit={onSubmit} onCancel={onCancel} />
    </Box>
  </Box>
);

const dismissFeedback = (ok: boolean, flowId: string): StructuredFeedback =>
  ok
    ? feedback('success', `dismissed the interrupted ${flowIdToTitle(flowId)} run`)
    : feedback('error', 'could not remove the run record — check the state directory permissions');

interface SessionsKeysArgs {
  readonly target: RunItem | undefined;
  readonly active: boolean;
  readonly stopRun: (record: SessionRecord) => void;
  readonly setFeedback: (f: StructuredFeedback) => void;
  readonly dismiss: (runId: string) => Promise<boolean>;
}

/** ↵ open / resume, `c` cancel a live session, `d` dismiss an interrupted record — each only on its own row. */
const useSessionsKeys = ({ target, active, stopRun, setFeedback, dismiss }: SessionsKeysArgs): void => {
  useViewKeys(
    [
      { keys: ['↑', '↓'], hint: 'move' },
      { keys: ['↵'], hint: target?.kind === 'interrupted' ? 'resume on Home' : 'open' },
      {
        keys: ['c'],
        hint: 'cancel run',
        enabled: target?.kind !== 'interrupted',
        run: () => {
          if (target?.kind !== 'session') return;
          // A finished run has nothing to abort. The hint stays up because the answer depends on
          // the focused row, and a swallowed keystroke would read as a broken key — so the
          // handler says which state blocked it instead.
          if (target.record.descriptor.status !== 'running') {
            setFeedback(feedback('error', `session is ${target.record.descriptor.status}, nothing to cancel`));
            return;
          }
          stopRun(target.record);
        },
      },
      {
        keys: ['d'],
        hint: 'dismiss',
        enabled: target?.kind === 'interrupted',
        run: () => {
          if (target?.kind !== 'interrupted') return;
          const { record } = target.run;
          void dismiss(record.runId).then((ok) => setFeedback(dismissFeedback(ok, record.flowId)));
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
    // An interrupted run is resumed by Implement from Home, which names the task and offers it.
    onSubmit: (item) =>
      item.kind === 'session'
        ? router.push({ id: 'execute', props: { sessionId: item.record.descriptor.id } })
        : router.reset({ id: 'home' }),
  });

  // Claim the global-key mute while the confirm prompt is mounted.
  const claimPrompt = ui.claimPrompt;
  useEffect(() => (confirmCancel !== undefined ? claimPrompt() : undefined), [confirmCancel, claimPrompt]);

  useSessionsKeys({
    target: focusedItem ?? items[0],
    active: listActive,
    stopRun: setConfirmCancel,
    setFeedback: setSessionFeedback,
    dismiss: interrupted.dismiss,
  });

  const handleCancelConfirmed = (record: SessionRecord, confirmed: boolean): void => {
    setConfirmCancel(undefined);
    if (!confirmed) return;
    manager.abort(record.descriptor.id);
    setSessionFeedback(feedback('success', `requested cancel for ${record.descriptor.title}`));
  };

  return (
    <ViewShell title="Sessions" subtitle="every chain run, live and recent" suppressScrollArrows>
      {ui.helpOpen ? (
        <HelpOverlay />
      ) : confirmCancel !== undefined ? (
        <CancelConfirm
          record={confirmCancel}
          onSubmit={(value) => handleCancelConfirmed(confirmCancel, value)}
          onCancel={() => setConfirmCancel(undefined)}
        />
      ) : items.length === 0 ? (
        <Box flexDirection="column">
          <EmptyState title="No sessions yet" hint="Start a flow from the Flows screen (n)." />
          {/* Dismissing the last interrupted run lands here: the confirmation must not vanish with the row. */}
          <FeedbackLine text={sessionFeedback} />
        </Box>
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
