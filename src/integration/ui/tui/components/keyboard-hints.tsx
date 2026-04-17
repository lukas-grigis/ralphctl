/**
 * KeyboardHints — renders the view-local keyboard hints strip.
 *
 * Subscribes to the `ViewHintsProvider` and displays whatever the current
 * view published via `useViewHints([...])`. Keys are bold, actions dim,
 * separated by a mid-dot.
 *
 * Rendered by `<ViewShell>` just below the view body, *above* the StatusBar.
 * Views never render this component directly.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs } from '@src/integration/ui/theme/tokens.ts';
import { useActiveHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';

export function KeyboardHints(): React.JSX.Element | null {
  const hints = useActiveHints();
  if (hints.length === 0) return null;
  return (
    <Box>
      {hints.map((h, i) => (
        <React.Fragment key={`${String(i)}-${h.key}`}>
          {i > 0 ? <Text dimColor>{` ${glyphs.inlineDot} `}</Text> : null}
          <Text bold>{h.key}</Text>
          <Text dimColor>{` ${h.action}`}</Text>
        </React.Fragment>
      ))}
    </Box>
  );
}
