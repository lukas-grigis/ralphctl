/**
 * Sessions list — every runner the manager knows about, live + recent. Selecting a row reopens
 * the execute view for that session.
 *
 * The focus cursor is identity-based (keyed on the session id, not a list index) via
 * {@link useListWindow}, so it survives a live reorder or eviction of an earlier session instead
 * of jumping to whatever now sits at the old index.
 *
 * Local keys:
 *   ↑/↓  move the focus cursor
 *   ↵    open the execute view for the focused session
 *   c    abort the focused session (if it's running) after a confirm
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { EmptyState } from '@src/application/ui/tui/components/empty-state.tsx';
import { runnerStatusKind, StatusChip } from '@src/application/ui/tui/components/status-chip.tsx';
import { OverflowRow, useListWindow, type ListWindow } from '@src/application/ui/tui/components/windowed-list.tsx';
import { ConfirmPrompt } from '@src/application/ui/tui/prompts/confirm-prompt.tsx';
import { glyphs, inkColors, listCapacity, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { FeedbackLine, feedback, type StructuredFeedback } from '@src/application/ui/tui/components/feedback-line.tsx';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useSessionManager, useSessions } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewKeys } from '@src/application/ui/tui/runtime/use-view-keys.ts';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import type { SessionRecord } from '@src/application/ui/tui/runtime/session-manager.ts';
import { fmtElapsed } from '@src/application/ui/tui/theme/duration.ts';
import { useBreakpoint } from '@src/application/ui/tui/runtime/use-breakpoint.ts';

/** Non-list rows consumed by ViewShell chrome + column header + overflow rows + summary + feedback. */
const CHROME_ROWS = 9;
const FLOW_COL_WIDTH = 16;
const STATUS_COL_WIDTH = 14;
const ELAPSED_COL_WIDTH = 10;

const sessionId = (s: SessionRecord): string => s.descriptor.id;

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

/** One session row: focus cursor, title, flow id, status chip, elapsed time. */
const SessionRow = ({
  record,
  focused,
}: {
  readonly record: SessionRecord;
  readonly focused: boolean;
}): React.JSX.Element => (
  <Box paddingX={spacing.indent}>
    <Text color={focused ? inkColors.primary : inkColors.muted}>{focused ? glyphs.actionCursor : ' '} </Text>
    <Box flexGrow={1}>
      <Text bold={focused}>{record.descriptor.title}</Text>
      <Text> </Text>
    </Box>
    <Box width={FLOW_COL_WIDTH}>
      <Text bold={focused} dimColor>
        {record.descriptor.flowId}
      </Text>
      <Text> </Text>
    </Box>
    <Box width={STATUS_COL_WIDTH}>
      <Text bold={focused}>
        <StatusChip label={record.descriptor.status} kind={runnerStatusKind(record.descriptor.status)} />
      </Text>
      <Text> </Text>
    </Box>
    <Box width={ELAPSED_COL_WIDTH}>
      <Text bold={focused} dimColor>
        {fmtElapsed(record.descriptor.startedAt, record.descriptor.finishedAt ?? Date.now())}
      </Text>
    </Box>
  </Box>
);

interface SessionsTableProps {
  readonly window: ListWindow;
  readonly visibleItems: readonly SessionRecord[];
  readonly focusedIndex: number;
  readonly total: number;
  readonly sessionFeedback: StructuredFeedback | undefined;
}

/** Header + windowed rows + count line + feedback — pure props in. */
const SessionsTable = ({
  window,
  visibleItems,
  focusedIndex,
  total,
  sessionFeedback,
}: SessionsTableProps): React.JSX.Element => (
  <Box flexDirection="column">
    <SessionsHeader />
    <OverflowRow direction="above" count={window.hiddenAbove} />
    {visibleItems.map((s, localIdx) => (
      <SessionRow key={s.descriptor.id} record={s} focused={window.start + localIdx === focusedIndex} />
    ))}
    <OverflowRow direction="below" count={window.hiddenBelow} />
    {/* Just the count — the key affordances live in the router's hint strip (`useViewKeys`),
        the single source of truth. A second hand-typed strip here would drift from it. */}
    <Box paddingX={spacing.indent} marginTop={spacing.section}>
      <Text dimColor>
        {glyphs.bullet} {total} session(s)
      </Text>
    </Box>
    <FeedbackLine text={sessionFeedback} />
  </Box>
);

export const SessionsView = (): React.JSX.Element => {
  const router = useRouter();
  const sessions = useSessions();
  const manager = useSessionManager();
  const ui = useUiState();
  const { rows } = useBreakpoint();

  const [confirmCancel, setConfirmCancel] = useState<SessionRecord | undefined>(undefined);
  const [sessionFeedback, setSessionFeedback] = useState<StructuredFeedback | undefined>(undefined);

  // List input is live only when no overlay / prompt is mounted; the global-key mute is claimed
  // separately while the confirm prompt is up.
  const listActive = !ui.modalOpen && confirmCancel === undefined;

  const { window, visibleItems, focusedIndex, focusedItem } = useListWindow<SessionRecord>({
    items: sessions,
    getId: sessionId,
    visibleRows: listCapacity(rows, { chromeRows: CHROME_ROWS, min: 5, max: 15 }),
    active: listActive,
    onSubmit: (s) => router.push({ id: 'execute', props: { sessionId: s.descriptor.id } }),
  });

  // Claim the global-key mute while the confirm prompt is mounted.
  const claimPrompt = ui.claimPrompt;
  useEffect(() => (confirmCancel !== undefined ? claimPrompt() : undefined), [confirmCancel, claimPrompt]);

  useViewKeys(
    [
      { keys: ['↑', '↓'], hint: 'move' },
      { keys: ['↵'], hint: 'open' },
      {
        keys: ['c'],
        hint: 'cancel run',
        run: () => {
          const target = focusedItem ?? sessions[0];
          if (target === undefined) return;
          // A finished run has nothing to abort. The hint stays up because the answer depends on
          // the focused row, and a swallowed keystroke would read as a broken key — so the
          // handler says which state blocked it instead.
          if (target.descriptor.status !== 'running') {
            setSessionFeedback(feedback('error', `session is ${target.descriptor.status}, nothing to cancel`));
            return;
          }
          setConfirmCancel(target);
        },
      },
    ],
    { active: listActive }
  );

  const handleCancelConfirmed = (target: SessionRecord, confirmed: boolean): void => {
    setConfirmCancel(undefined);
    if (!confirmed) return;
    manager.abort(target.descriptor.id);
    setSessionFeedback(feedback('success', `requested cancel for ${target.descriptor.title}`));
  };

  return (
    <ViewShell title="Sessions" subtitle="every chain run, live and recent" suppressScrollArrows>
      {ui.helpOpen ? (
        <HelpOverlay />
      ) : confirmCancel !== undefined ? (
        <Box flexDirection="column" paddingX={spacing.indent}>
          <Text>
            Cancel <Text bold>{confirmCancel.descriptor.title}</Text>?
          </Text>
          <Text dimColor>The runner stops at the next safe point; partial progress is retained on disk.</Text>
          <Box marginTop={spacing.section}>
            <ConfirmPrompt
              message="Cancel?"
              defaultYes={false}
              onSubmit={(value) => handleCancelConfirmed(confirmCancel, value)}
              onCancel={() => setConfirmCancel(undefined)}
            />
          </Box>
        </Box>
      ) : sessions.length === 0 ? (
        <EmptyState title="No sessions yet" hint="Start a flow from the Flows screen (n)." />
      ) : (
        <SessionsTable
          window={window}
          visibleItems={visibleItems}
          focusedIndex={focusedIndex}
          total={sessions.length}
          sessionFeedback={sessionFeedback}
        />
      )}
    </ViewShell>
  );
};
