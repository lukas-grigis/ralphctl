/**
 * StatusBar — bottom-of-screen hint line listing the hotkeys active in the
 * current view. Each hint is a `key: action` pair.
 */

import React from 'react';
import { Box, Text } from 'ink';

interface Hint {
  key: string;
  action: string;
}

interface Props {
  hints: readonly Hint[];
}

export function StatusBar({ hints }: Props): React.JSX.Element {
  return (
    <Box>
      {hints.map((h, i) => (
        <React.Fragment key={h.key}>
          {i > 0 ? <Text dimColor>{'   '}</Text> : null}
          <Text bold>{h.key}</Text>
          <Text dimColor>{` ${h.action}`}</Text>
        </React.Fragment>
      ))}
    </Box>
  );
}
