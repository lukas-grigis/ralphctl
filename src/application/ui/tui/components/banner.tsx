/**
 * Banner — the wordmark. Rendered under the chrome on the Work root when it fits; everywhere else it is absent (the
 * tab bar's `ralphctl` text carries the brand).
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

/** Pure banner-mode decision. */
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
