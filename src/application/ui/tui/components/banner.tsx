/**
 * Banner — the wordmark. Rendered under the chrome on the Work root when it fits; everywhere else
 * it is absent (the tab bar's `ralphctl` text carries the brand). Two modes:
 *
 *  - `full` (Work root, when it fits — see {@link resolveBannerMode}): wordmark art inside a thin
 *    frame plus the Ralph quote rail.
 *  - `compact` (everywhere else): nothing. The old one-line strip is gone with the tab bar.
 *
 * Stable per process: rolling the gradient or the quote on every navigation reads as visual
 * jitter; one frozen value per launch keeps the chrome calm.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { banner, getRandomQuote } from '@src/application/ui/tui/theme/banner.ts';
import { paintMultiline, palettes } from '@src/application/ui/tui/theme/gradient.ts';
import { breakpoints, glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { CLI_METADATA } from '@src/business/version/cli-metadata.ts';

const STABLE_ART = paintMultiline(banner.art, palettes.donut);
const STABLE_QUOTE = getRandomQuote();

/** Wordmark frame height (art + quote + border) plus chrome — Home needs this many rows to still show its menu. */
const MIN_FULL_ROWS = 40;

/** Rows the full banner occupies (frame + art + quote). */
export const BANNER_FULL_ROWS = 11;

export type BannerMode = 'full' | 'compact';

/**
 * Pure banner-mode decision. The wordmark is reserved for Home and only when the terminal is wide
 * (`breakpoints.md`) AND tall enough that the content below it still fits; every other route — and
 * every smaller terminal — shows no banner. `userToggle` (`b` on Home) flips whichever mode the
 * auto rule picked, in both directions.
 */
export const resolveBannerMode = (args: {
  readonly routeId: string;
  readonly columns: number;
  readonly rows: number;
  readonly userToggle: boolean;
}): BannerMode => {
  const auto: BannerMode =
    args.routeId === 'home' && args.columns >= breakpoints.md && args.rows >= MIN_FULL_ROWS ? 'full' : 'compact';
  if (!args.userToggle || args.routeId !== 'home') return auto;
  return auto === 'full' ? 'compact' : 'full';
};

export interface BannerProps {
  /** Resolved mode — callers derive it with {@link resolveBannerMode}. */
  readonly mode: BannerMode;
}

export const Banner = ({ mode }: BannerProps): React.JSX.Element | null => {
  if (mode === 'compact') return null;
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
      <Box alignItems="center" justifyContent="center" marginTop={spacing.section}>
        <Text dimColor italic>
          {glyphs.quoteRail} &quot;{STABLE_QUOTE}&quot;
        </Text>
        <Text dimColor>
          {'   '}
          {glyphs.bullet} v{CLI_METADATA.currentVersion}
        </Text>
      </Box>
    </Box>
  );
};
