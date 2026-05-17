/**
 * Banner — the persistent header. Always rendered above every view so the user has a fixed
 * visual anchor as they navigate. Two modes:
 *
 *  - `full` (home view): wordmark art inside a thin frame plus the Ralph quote rail.
 *  - `compact` (everywhere else): a single typographic strip with a stable rule line below it,
 *    so the header is unmistakable but takes minimal vertical space.
 *
 * Stable per process: rolling the gradient or the quote on every navigation reads as visual
 * jitter; one frozen value per launch keeps the chrome calm.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { banner, getRandomQuote } from '@src/application/ui/tui/theme/banner.ts';
import { paintMultiline, palettes } from '@src/application/ui/tui/theme/gradient.ts';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import { Divider } from '@src/application/ui/tui/components/divider.tsx';
import { CLI_METADATA } from '@src/business/version/cli-metadata.ts';

const STABLE_ART = paintMultiline(banner.art, palettes.donut);
const STABLE_QUOTE = getRandomQuote();

/** Banner art is roughly 92 cells wide. Below this we auto-switch to compact. */
const MIN_FULL_WIDTH = 100;

export interface BannerProps {
  /**
   * When true, render the compact single-line strip even on home — useful for narrow shells.
   * When `undefined` the banner picks based on terminal width.
   */
  readonly compact?: boolean;
}

export const Banner = ({ compact }: BannerProps): React.JSX.Element => {
  const { columns } = useTerminalSize();
  const isCompact = compact ?? columns < MIN_FULL_WIDTH;
  if (isCompact) {
    return (
      <Box flexDirection="column">
        <Box paddingX={spacing.indent} justifyContent="space-between">
          <Box>
            <Text bold color={inkColors.primary}>
              ralphctl
            </Text>
            <Text dimColor>
              {'  '}
              {glyphs.bullet} {banner.tagline}
            </Text>
          </Box>
          <Text dimColor>v{CLI_METADATA.currentVersion}</Text>
        </Box>
        <Divider />
      </Box>
    );
  }
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={inkColors.primary}
      borderDimColor
      paddingX={6}
      paddingY={0}
    >
      <Box alignItems="center" justifyContent="center">
        <Text>{STABLE_ART}</Text>
      </Box>
      <Box alignItems="center" justifyContent="center" marginTop={1}>
        <Text dimColor italic>
          🍩 &quot;{STABLE_QUOTE}&quot;
        </Text>
        <Text dimColor>
          {'   '}
          {glyphs.bullet} v{CLI_METADATA.currentVersion}
        </Text>
      </Box>
    </Box>
  );
};
