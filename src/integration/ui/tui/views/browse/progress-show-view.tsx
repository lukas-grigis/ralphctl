/**
 * ProgressShowView — renders the current sprint's `progress.md` log inline.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { getProgress } from '@src/integration/persistence/progress.ts';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';

type State =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'ready'; content: string }
  | { kind: 'error'; message: string };

/** Render at most this many trailing lines to keep the frame responsive. */
const MAX_TAIL = 80;

const TITLE = 'Progress Log' as const;
const HINTS = [] as const;

interface Props {
  readonly sprintId?: string;
}

export function ProgressShowView({ sprintId }: Props = {}): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  useViewHints(HINTS);

  useEffect(() => {
    const ctl = { cancelled: false };
    void (async () => {
      try {
        const content = await getProgress(sprintId);
        if (ctl.cancelled) return;
        if (!content.trim()) setState({ kind: 'empty' });
        else setState({ kind: 'ready', content });
      } catch (err) {
        if (!ctl.cancelled) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      ctl.cancelled = true;
    };
  }, [sprintId]);

  return (
    <ViewShell title={TITLE}>
      {state.kind === 'loading' ? (
        <Spinner label="Loading progress…" />
      ) : state.kind === 'empty' ? (
        <ResultCard kind="info" title="No progress entries yet" />
      ) : state.kind === 'error' ? (
        <ResultCard kind="error" title="Could not load progress" lines={[state.message]} />
      ) : (
        renderContent(state.content)
      )}
    </ViewShell>
  );
}

function renderContent(content: string): React.JSX.Element {
  const lines = content.split('\n');
  const tail = lines.length > MAX_TAIL ? lines.slice(-MAX_TAIL) : lines;
  return (
    <Box flexDirection="column">
      {lines.length > MAX_TAIL ? (
        <Text dimColor>
          Showing last {String(MAX_TAIL)} lines ({String(lines.length)} total)
        </Text>
      ) : null}
      {tail.map((line, i) => (
        <Text key={i} dimColor={line.trim().length === 0}>
          {line.length > 0 ? line : ' '}
        </Text>
      ))}
    </Box>
  );
}
