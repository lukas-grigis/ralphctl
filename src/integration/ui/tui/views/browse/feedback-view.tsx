/**
 * FeedbackView — user feedback events logged to `progress.md`.
 *
 * Entries are delimited by `---` in the progress log; we parse out the ones
 * whose body matches `User feedback: …` and render them as a compact
 * timestamp + preview list. Read-only.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { getProgress } from '@src/integration/persistence/progress.ts';
import { inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';

interface Props {
  readonly sprintId?: string;
}

interface FeedbackEntry {
  readonly timestamp: string;
  readonly preview: string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'ready'; entries: readonly FeedbackEntry[] }
  | { kind: 'error'; message: string };

const TITLE = 'Feedback' as const;
const HINTS = [] as const;

export function FeedbackView({ sprintId }: Props): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  useViewHints(HINTS);

  useEffect(() => {
    const ctl = { cancelled: false };
    void (async () => {
      try {
        const content = await getProgress(sprintId);
        if (ctl.cancelled) return;
        const entries = extractFeedback(content);
        if (entries.length === 0) setState({ kind: 'empty' });
        else setState({ kind: 'ready', entries });
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
        <Spinner label="Loading feedback…" />
      ) : state.kind === 'empty' ? (
        <ResultCard
          kind="info"
          title="No feedback yet"
          lines={['Feedback is captured during the post-execution loop.']}
        />
      ) : state.kind === 'error' ? (
        <ResultCard kind="error" title="Could not load feedback" lines={[state.message]} />
      ) : (
        <Box flexDirection="column">
          {state.entries.map((entry, i) => (
            <Box key={i} marginTop={i === 0 ? 0 : spacing.section} flexDirection="column">
              <Text color={inkColors.muted} bold>
                {entry.timestamp}
              </Text>
              <Text>{entry.preview}</Text>
            </Box>
          ))}
        </Box>
      )}
    </ViewShell>
  );
}

/** Exported for unit testing. */
export function extractFeedback(progress: string): readonly FeedbackEntry[] {
  if (!progress.trim()) return [];
  const entries = progress.split(/\n---\n/).filter((e) => e.trim());
  const out: FeedbackEntry[] = [];
  for (const entry of entries) {
    const match = /User feedback:\s*([\s\S]+)/.exec(entry);
    if (!match?.[1]) continue;
    const tsMatch = /^##\s+(.+)$/m.exec(entry);
    const timestamp = tsMatch?.[1]?.trim() ?? 'unknown';
    const preview =
      match[1]
        .split('\n')
        .find((l) => l.trim().length > 0)
        ?.trim() ?? '';
    out.push({ timestamp, preview });
  }
  return out;
}
