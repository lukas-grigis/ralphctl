/**
 * StatusBar — bottom-of-screen chrome.
 *
 * Two zones:
 *   - Left:  breadcrumb (e.g. `Home › Settings`) showing the navigation stack
 *   - Right: hotkey hints (e.g. `esc back · h home · s settings`)
 *
 * Both are optional. Views can render their own status bar without a
 * breadcrumb if the router isn't in play; the router renders the breadcrumb
 * + global hints persistently across all views.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs } from '@src/integration/ui/theme/tokens.ts';

interface Hint {
  key: string;
  action: string;
}

interface Props {
  hints: readonly Hint[];
  /** Stack of view labels, root-first. Empty array hides the breadcrumb. */
  breadcrumb?: readonly string[];
}

export function StatusBar({ hints, breadcrumb }: Props): React.JSX.Element {
  return (
    <Box>
      {breadcrumb && breadcrumb.length > 0 ? (
        <Box marginRight={2}>
          {breadcrumb.map((label, i) => (
            <React.Fragment key={`${String(i)}-${label}`}>
              {i > 0 ? <Text dimColor>{` ${glyphs.selectMarker} `}</Text> : null}
              <Text bold={i === breadcrumb.length - 1} dimColor={i !== breadcrumb.length - 1}>
                {label}
              </Text>
            </React.Fragment>
          ))}
        </Box>
      ) : null}
      <Box>
        {hints.map((h, i) => (
          <React.Fragment key={`${String(i)}-${h.key}`}>
            {i > 0 ? <Text dimColor>{'   '}</Text> : null}
            <Text bold>{h.key}</Text>
            <Text dimColor>{` ${h.action}`}</Text>
          </React.Fragment>
        ))}
      </Box>
    </Box>
  );
}
