/**
 * Sessions list — every runner the manager knows about, live + recent. Selecting a row reopens
 * the execute view for that session.
 *
 * The focus cursor is identity-based (keyed on the session id, not a list index) via
 * {@link useListWindow}, so it survives a live reorder or eviction of an earlier session instead
 * of jumping to whatever now sits at the old index (audit L7).
 *
 * Local keys:
 *   ↑/↓  move the focus cursor
 *   ↵    open the execute view for the focused session
 *   c    abort the focused session (if it's running) after a confirm
 */

import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { EmptyState } from '@src/application/ui/tui/components/empty-state.tsx';
import { runnerStatusKind, StatusChip } from '@src/application/ui/tui/components/status-chip.tsx';
import { OverflowRow, useListWindow } from '@src/application/ui/tui/components/windowed-list.tsx';
import { ConfirmPrompt } from '@src/application/ui/tui/prompts/confirm-prompt.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { FeedbackLine, feedback, type StructuredFeedback } from '@src/application/ui/tui/components/feedback-line.tsx';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useSessionManager, useSessions } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import type { SessionRecord } from '@src/application/ui/tui/runtime/session-manager.ts';
import { fmtElapsed } from '@src/application/ui/tui/theme/duration.ts';

const VISIBLE_ROWS = 10;
const FLOW_COL_WIDTH = 16;
const STATUS_COL_WIDTH = 14;
const ELAPSED_COL_WIDTH = 10;

const sessionId = (s: SessionRecord): string => s.descriptor.id;

export const SessionsView = (): React.JSX.Element => {
  const router = useRouter();
  const sessions = useSessions();
  const manager = useSessionManager();
  const ui = useUiState();
  useViewHints([
    { keys: '↑/↓', label: 'move' },
    { keys: '↵', label: 'open' },
    { keys: 'c', label: 'cancel run' },
  ]);

  const [confirmCancel, setConfirmCancel] = useState<SessionRecord | undefined>(undefined);
  const [sessionFeedback, setSessionFeedback] = useState<StructuredFeedback | undefined>(undefined);

  // List input is live only when no overlay / prompt is mounted; the global-key mute is claimed
  // separately while the confirm prompt is up.
  const listActive = !ui.helpOpen && !ui.promptActive && confirmCancel === undefined;

  const { window, visibleItems, focusedIndex, focusedItem } = useListWindow<SessionRecord>({
    items: sessions,
    getId: sessionId,
    visibleRows: VISIBLE_ROWS,
    active: listActive,
    onSubmit: (s) => router.push({ id: 'execute', props: { sessionId: s.descriptor.id } }),
  });

  // Claim the global-key mute while the confirm prompt is mounted.
  const claimPrompt = ui.claimPrompt;
  useEffect(() => (confirmCancel !== undefined ? claimPrompt() : undefined), [confirmCancel, claimPrompt]);

  useInput((input) => {
    if (!listActive) return;
    if (input === 'c') {
      const target = focusedItem ?? sessions[0];
      if (target === undefined) return;
      if (target.descriptor.status !== 'running') {
        setSessionFeedback(feedback('error', `session is ${target.descriptor.status}, nothing to cancel`));
        return;
      }
      setConfirmCancel(target);
    }
  });

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
          <Box marginTop={1}>
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
        <Box flexDirection="column">
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
          <OverflowRow direction="above" count={window.start} />
          {visibleItems.map((s, localIdx) => {
            const focused = window.start + localIdx === focusedIndex;
            return (
              <Box key={s.descriptor.id} paddingX={spacing.indent}>
                <Text color={focused ? inkColors.primary : inkColors.muted}>
                  {focused ? glyphs.actionCursor : ' '}{' '}
                </Text>
                <Box flexGrow={1}>
                  <Text bold={focused}>{s.descriptor.title}</Text>
                  <Text> </Text>
                </Box>
                <Box width={FLOW_COL_WIDTH}>
                  <Text bold={focused} dimColor>
                    {s.descriptor.flowId}
                  </Text>
                  <Text> </Text>
                </Box>
                <Box width={STATUS_COL_WIDTH}>
                  <Text bold={focused}>
                    <StatusChip label={s.descriptor.status} kind={runnerStatusKind(s.descriptor.status)} />
                  </Text>
                  <Text> </Text>
                </Box>
                <Box width={ELAPSED_COL_WIDTH}>
                  <Text bold={focused} dimColor>
                    {fmtElapsed(s.descriptor.startedAt, s.descriptor.finishedAt ?? Date.now())}
                  </Text>
                </Box>
              </Box>
            );
          })}
          <OverflowRow direction="below" count={sessions.length - window.end} />
          <Box paddingX={spacing.indent} marginTop={spacing.section}>
            <Text dimColor>
              {glyphs.bullet} {sessions.length} session(s) {glyphs.bullet} ↵ open {glyphs.bullet} c cancel
            </Text>
          </Box>
          <FeedbackLine text={sessionFeedback} />
        </Box>
      )}
    </ViewShell>
  );
};
