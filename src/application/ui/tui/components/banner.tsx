/**
 * Banner — the wordmark, shown on the Work root in three tiers: the full boxed original, the same art compacted (no
 * box, quote and version beside or under it), or nothing — where the tab bar's gradient `ralphctl` carries the brand.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { banner, getRandomQuote } from '@src/application/ui/tui/theme/banner.ts';
import { paintLine, paintMultiline, palettes } from '@src/application/ui/tui/theme/gradient.ts';
import { breakpoints, glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import { isColorDisabled } from '@src/application/ui/tui/runtime/use-no-color.ts';
import { CLI_METADATA } from '@src/business/version/cli-metadata.ts';

const STABLE_QUOTE = getRandomQuote();

const artRows = banner.art.split('\n').filter((l) => l.trim() !== '');
const indent = Math.min(...artRows.map((l) => l.length - l.trimStart().length));
const COMPACT_ART = artRows.map((l) => l.slice(indent));
const ART_WIDTH = Math.max(...COMPACT_ART.map((l) => l.length));
const ART_HEIGHT = COMPACT_ART.length;

/** Rows the full frame occupies: border, the art block with its two blank rows, the quote row and its gap. */
export const BANNER_FULL_ROWS = 12;

const FULL_MIN_ROWS = 45;
const COMPACT_MIN_ROWS = 30;
const COMPACT_MIN_COLS = ART_WIDTH + 4;
/** Quote and version sit beside the art from here; below it they take one line under the art. */
const SIDE_MIN_COLS = ART_WIDTH + 30;
/** Narrowest terminal the boxed art (indent, frame, padding) fits without wrapping. */
const FULL_FITS_COLS = 86;

export type BannerMode = 'full' | 'compact' | 'none';

/** Pure banner-mode decision. `userToggle` (`b` on Work) steps one tier: full and compact swap, none → compact. */
export const resolveBannerMode = (args: {
  readonly routeId: string;
  readonly columns: number;
  readonly rows: number;
  readonly userToggle: boolean;
}): BannerMode => {
  if (args.routeId !== 'home') return 'none';
  const { columns, rows } = args;
  const compactFits = columns >= COMPACT_MIN_COLS;
  let auto: BannerMode = 'none';
  if (columns >= breakpoints.md && rows >= FULL_MIN_ROWS) auto = 'full';
  else if (compactFits && rows >= COMPACT_MIN_ROWS) auto = 'compact';
  if (!args.userToggle) return auto;
  if (auto === 'full') return 'compact';
  if (columns >= FULL_FITS_COLS) return 'full';
  return compactFits ? 'compact' : 'none';
};

/** Rows the banner takes in the given mode at this width, for views budgeting the space below it. */
export const bannerRows = (mode: BannerMode, columns: number): number => {
  if (mode === 'full') return BANNER_FULL_ROWS;
  if (mode === 'compact') return columns >= SIDE_MIN_COLS ? ART_HEIGHT : ART_HEIGHT + 1;
  return 0;
};

export interface BannerProps {
  /** Resolved mode — callers derive it with {@link resolveBannerMode}. */
  readonly mode: BannerMode;
}

const Signature = (): React.JSX.Element => (
  <Text dimColor wrap="truncate-end">
    <Text italic>
      {glyphs.quoteRail} &quot;{STABLE_QUOTE}&quot;
    </Text>
    <Text>
      {'  '}
      {glyphs.bullet} v{CLI_METADATA.currentVersion}
    </Text>
  </Text>
);

export const Banner = ({ mode }: BannerProps): React.JSX.Element | null => {
  const { columns } = useTerminalSize();
  const noColor = isColorDisabled();
  const full = paintMultiline(banner.art, palettes.donut);
  const rows = COMPACT_ART.map((l) => (noColor ? l : paintLine(l, palettes.donut)));
  if (mode === 'none') return null;
  if (mode === 'compact') {
    const side = columns >= SIDE_MIN_COLS;
    return (
      <Box flexDirection={side ? 'row' : 'column'} paddingX={spacing.indent}>
        <Box flexDirection="column" flexShrink={0} width={ART_WIDTH}>
          {rows.map((line, i) => (
            <Text key={String(i)} wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
        {side ? (
          <Box flexDirection="column" justifyContent="center" marginLeft={3} flexShrink={1}>
            <Text dimColor italic>
              {glyphs.quoteRail} &quot;{STABLE_QUOTE}&quot;
            </Text>
            <Text dimColor>
              {glyphs.bullet} v{CLI_METADATA.currentVersion}
            </Text>
          </Box>
        ) : (
          <Signature />
        )}
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
        <Text>{full}</Text>
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
