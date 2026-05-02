/**
 * SessionsView — multi-chain switcher.
 *
 * Lists every session with status + age. Users can:
 *   - ↑/↓ to navigate
 *   - Enter to foreground (navigate to ExecuteView)
 *   - k to kill the selected session
 *   - Tab to cycle (global key, owned by router)
 *   - Ctrl+1..9 to direct-jump (global key)
 *   - Esc to go back
 */

import React, { useMemo } from 'react';
import { useViewInput } from './use-view-input.ts';
import { Box } from 'ink';
import { inkColors } from '@src/integration/ui/theme/tokens.ts';
import { ViewShell } from '@src/application/tui/components/view-shell.tsx';
import { ResultCard } from '@src/application/tui/components/result-card.tsx';
import { ListView, type ListColumn } from '@src/application/tui/components/list-view.tsx';
import { chipKindForSessionStatus } from '@src/application/tui/components/status-chip.tsx';
import { useViewHints } from './view-hints-context.tsx';
import { useRouter } from './router-context.ts';
import { useSessionEvents } from '@src/application/tui/runtime/hooks.ts';
import { getKeyFor } from '@src/application/tui/keyboard-map.ts';
import type { SessionManagerPort, SessionDescriptor } from '@src/application/runtime/session-manager-port.ts';

const SESSIONS_HINTS = [
  { key: '↑/↓', action: 'navigate' },
  { key: 'Enter', action: 'foreground' },
  { key: getKeyFor('sessions.kill'), action: 'kill' },
  { key: 'Tab', action: 'next session' },
  { key: 'Shift+Tab', action: 'previous session' },
  { key: 'Ctrl+1..9', action: 'jump to session' },
  { key: 'Esc', action: 'back' },
] as const;

function formatAge(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  if (ms < 60_000) return `${String(Math.floor(ms / 1000))}s`;
  if (ms < 3_600_000) return `${String(Math.floor(ms / 60_000))}m`;
  return `${String(Math.floor(ms / 3_600_000))}h`;
}

interface Props {
  readonly sessionManager: SessionManagerPort | null;
}

const COLUMNS: readonly ListColumn<SessionDescriptor>[] = [
  {
    header: '#',
    cell: () => '',
    width: 2,
  },
  {
    header: 'LABEL',
    cell: (row) => row.label,
    flex: true,
  },
  {
    header: 'STATUS',
    cell: (row) => row.status.toUpperCase(),
    width: 10,
    color: (row) => {
      const kind = chipKindForSessionStatus(row.status);
      if (kind === 'success') return inkColors.success;
      if (kind === 'warning') return inkColors.warning;
      if (kind === 'error') return inkColors.error;
      return inkColors.muted;
    },
  },
  {
    header: 'AGE',
    cell: (row) => formatAge(String(row.startedAt)),
    width: 6,
    align: 'right',
  },
];

export function SessionsView({ sessionManager }: Props): React.JSX.Element {
  useViewHints(SESSIONS_HINTS);
  const router = useRouter();
  const sessions = useSessionEvents(sessionManager);

  const [cursor, setCursor] = React.useState(0);

  const indexedColumns: readonly ListColumn<SessionDescriptor>[] = useMemo(
    () => [
      {
        header: '#',
        cell: (row) => {
          const idx = sessions.indexOf(row);
          return idx >= 0 ? String(idx + 1) : '';
        },
        width: 2,
      },
      ...COLUMNS.slice(1),
    ],
    [sessions]
  );

  // Replace instead of pushing when we're already on execute — the user
  // arrived here via Tab/Ctrl+N → execute → x → sessions, and pressing
  // Enter on a different session should swap, not stack two execute frames.
  function foreground(session: SessionDescriptor): void {
    if (sessionManager) {
      sessionManager.foreground(session.id);
    }
    const onExecute = router.current.id === 'execute';
    if (onExecute) {
      router.replace({ id: 'execute', props: { sessionId: session.id } });
    } else {
      router.push({ id: 'execute', props: { sessionId: session.id } });
    }
  }

  const KEY_KILL = getKeyFor('sessions.kill');

  function isTerminal(s: SessionDescriptor): boolean {
    return s.status === 'completed' || s.status === 'failed' || s.status === 'aborted';
  }

  useViewInput((_input, key) => {
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(sessions.length - 1, c + 1));
    else if (_input === KEY_KILL) {
      const session = sessions[cursor];
      // Kill is a no-op on a session that has already settled — there's
      // nothing to abort. Avoids the "I pressed k but nothing happened"
      // confusion on completed sessions.
      if (session && sessionManager && !isTerminal(session)) {
        sessionManager.kill(session.id);
        setCursor((c) => Math.min(c, Math.max(0, sessions.length - 2)));
      }
    }
  });

  return (
    <ViewShell title="SESSIONS">
      <Box flexDirection="column">
        {sessions.length === 0 ? (
          <ResultCard
            kind="info"
            title="No active sessions"
            nextSteps={[{ action: 'Start a sprint to begin a session' }]}
          />
        ) : (
          <ListView
            rows={sessions}
            columns={indexedColumns}
            onSelect={foreground}
            emptyLabel="No sessions"
            initialCursor={cursor}
            onCursorChange={(_row, idx) => {
              setCursor(idx);
            }}
          />
        )}
      </Box>
    </ViewShell>
  );
}
