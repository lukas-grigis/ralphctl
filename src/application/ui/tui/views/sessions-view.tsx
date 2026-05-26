/**
 * Sessions list — every runner the manager knows about, live + recent. Selecting a row reopens
 * the execute view for that session.
 *
 * Local keys:
 *   ↑/↓  move the focus cursor
 *   ↵    open the execute view for the focused session
 *   c    abort the focused session (if it's running) after a confirm
 */

import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { ListView, type ListColumn } from '@src/application/ui/tui/components/list-view.tsx';
import { EmptyState } from '@src/application/ui/tui/components/empty-state.tsx';
import { StatusChip, runnerStatusKind } from '@src/application/ui/tui/components/status-chip.tsx';
import { ConfirmPrompt } from '@src/application/ui/tui/prompts/confirm-prompt.tsx';
import { spacing, glyphs, inkColors } from '@src/application/ui/tui/theme/tokens.ts';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useSessions, useSessionManager } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import type { SessionRecord } from '@src/application/ui/tui/runtime/session-manager.ts';
import { fmtElapsed } from '@src/application/ui/tui/theme/duration.ts';

export const SessionsView = (): React.JSX.Element => {
  const router = useRouter();
  const sessions = useSessions();
  const manager = useSessionManager();
  const ui = useUiState();
  useViewHints([
    { keys: '↵', label: 'open' },
    { keys: 'c', label: 'cancel run' },
  ]);

  const [cursorId, setCursorId] = useState<string | undefined>(undefined);
  const [confirmCancel, setConfirmCancel] = useState<SessionRecord | undefined>(undefined);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);

  // Claim the global-key mute while the confirm prompt is mounted.
  const claimPrompt = ui.claimPrompt;
  useEffect(() => (confirmCancel !== undefined ? claimPrompt() : undefined), [confirmCancel, claimPrompt]);

  useInput((input) => {
    if (ui.helpOpen || ui.promptActive || confirmCancel !== undefined) return;
    if (input === 'c') {
      const target = sessions.find((s) => s.descriptor.id === cursorId) ?? sessions[0];
      if (target === undefined) return;
      if (target.descriptor.status !== 'running') {
        setFeedback(`✗ session is ${target.descriptor.status}, nothing to cancel`);
        return;
      }
      setConfirmCancel(target);
    }
  });

  const handleCancelConfirmed = (target: SessionRecord, confirmed: boolean): void => {
    setConfirmCancel(undefined);
    if (!confirmed) return;
    manager.abort(target.descriptor.id);
    setFeedback(`✓ requested cancel for ${target.descriptor.title}`);
  };

  const columns: ReadonlyArray<ListColumn<SessionRecord>> = [
    {
      key: 'title',
      header: 'Session',
      grow: true,
      render: (s) => <Text>{s.descriptor.title}</Text>,
    },
    {
      key: 'flow',
      header: 'Flow',
      width: 16,
      render: (s) => <Text dimColor>{s.descriptor.flowId}</Text>,
    },
    {
      key: 'status',
      header: 'Status',
      width: 14,
      render: (s) => <StatusChip label={s.descriptor.status} kind={runnerStatusKind(s.descriptor.status)} />,
    },
    {
      key: 'elapsed',
      header: 'Elapsed',
      width: 10,
      render: (s) => <Text dimColor>{fmtElapsed(s.descriptor.startedAt, s.descriptor.finishedAt ?? Date.now())}</Text>,
    },
  ];

  return (
    <ViewShell title="Sessions" subtitle="every chain run, live and recent">
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
          <ListView
            items={sessions}
            columns={columns}
            onSelect={(s): void => {
              router.push({ id: 'execute', props: { sessionId: s.descriptor.id } });
            }}
            onCursor={(s): void => setCursorId(s.descriptor.id)}
            visibleRows={10}
            active={!ui.promptActive && confirmCancel === undefined}
          />
          <Box paddingX={spacing.indent} marginTop={spacing.section}>
            <Text dimColor>
              {glyphs.bullet} {sessions.length} session(s) {glyphs.bullet} ↵ open {glyphs.bullet} c cancel
            </Text>
          </Box>
          {feedback !== undefined && (
            <Box paddingX={spacing.indent} marginTop={1}>
              <Text color={feedback.startsWith('✗') ? inkColors.error : inkColors.primary}>{feedback}</Text>
            </Box>
          )}
        </Box>
      )}
    </ViewShell>
  );
};
