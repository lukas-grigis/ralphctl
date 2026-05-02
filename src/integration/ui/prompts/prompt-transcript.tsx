/**
 * Renders the resolved-prompt history as dim lines above the active prompt.
 *
 * Each entry mirrors the shape of its live prompt component (`🍩 message: value`)
 * so the user sees a coherent transcript of their answers rather than each
 * prompt erasing the previous one. Format per kind:
 *
 *   confirm    → `🍩 Continue?: yes` / `no`
 *   input      → `🍩 Display name: ralphctl`
 *   select     → `🍩 Pick a project: ralphctl`     (resolves choice → name)
 *   checkbox   → `🍩 Repos: alpha, beta`
 *   editor     → `🍩 Sprint description: (3 lines)` or `(empty)` / `(cancelled)`
 *   fileBrowser → `🍩 Pick a directory: /abs/path` or `(cancelled)`
 *
 * History clears automatically when the queue idles past `SEQUENCE_IDLE_MS`
 * (see prompt-queue.ts), so each fresh workflow starts with an empty
 * transcript.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { DONUT_EMOJI } from '@src/integration/ui/theme/tokens.ts';
import type { ResolvedPrompt } from './prompt-queue.ts';

interface Props {
  readonly history: readonly ResolvedPrompt[];
}

export function PromptTranscript({ history }: Props): React.JSX.Element | null {
  if (history.length === 0) return null;
  return (
    <Box flexDirection="column">
      {history.map((entry, i) => (
        <Box key={i}>
          <Text dimColor>
            {DONUT_EMOJI} {entry.options.message}: {renderValue(entry)}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function renderValue(entry: ResolvedPrompt): string {
  switch (entry.kind) {
    case 'confirm':
      return entry.value ? 'yes' : 'no';
    case 'input':
      return entry.value === '' ? '(empty)' : entry.value;
    case 'select': {
      const choice = entry.options.choices.find((c) => c.value === entry.value);
      return choice?.label ?? String(entry.value);
    }
    case 'checkbox': {
      if (entry.value.length === 0) return '(none)';
      const labels = entry.value.map((v) => {
        const choice = entry.options.choices.find((c) => c.value === v);
        return choice?.label ?? String(v);
      });
      return labels.join(', ');
    }
    case 'editor':
      if (entry.value === null) return '(cancelled)';
      if (entry.value === '') return '(empty)';
      return summariseMultiline(entry.value);
    case 'fileBrowser':
      return entry.value ?? '(cancelled)';
  }
}

function summariseMultiline(text: string): string {
  const lines = text.split('\n');
  if (lines.length === 1) {
    const first = lines[0] ?? '';
    return first.length > 60 ? `${first.slice(0, 57)}…` : first;
  }
  return `(${String(lines.length)} lines)`;
}
