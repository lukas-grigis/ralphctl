/**
 * StatusBar — bottom-of-screen chrome.
 *
 * Two zones:
 *   - Left:  breadcrumb (e.g. `Home › Settings`) showing the navigation stack
 *   - Right: hotkey hints (e.g. `esc back · h home · s settings`)
 *
 * Also shows the active session label when a session is foregrounded.
 * Both zones are optional.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors } from '../../../integration/ui/theme/tokens.ts';

interface Hint {
  key: string;
  action: string;
}

interface Props {
  readonly hints: readonly Hint[];
  /** Stack of view labels, root-first. Empty array hides the breadcrumb. */
  readonly breadcrumb?: readonly string[];
  /**
   * Active session label — shown as `[1/3] label` when a session is
   * foregrounded. Pass undefined to hide.
   */
  readonly activeSession?: { label: string; index: number; total: number } | null;
}

export function StatusBar({ hints, breadcrumb, activeSession }: Props): React.JSX.Element {
  return (
    <Box justifyContent="space-between" flexGrow={1}>
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
        {activeSession ? (
          <Box marginRight={2}>
            <Text color={inkColors.highlight} bold>
              [{String(activeSession.index + 1)}/{String(activeSession.total)}]{' '}
            </Text>
            <Text color={inkColors.highlight}>{activeSession.label}</Text>
          </Box>
        ) : null}
      </Box>
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
