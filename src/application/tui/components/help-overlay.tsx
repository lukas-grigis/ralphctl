/**
 * HelpOverlay — full-screen keyboard reference, generated from
 * `keyboard-map.ts`.
 *
 * Toggled by `?` (the universal terminal-app help convention). The overlay
 * is rendered by `<ViewRouter />` as a sibling of the active view — when
 * open it dims (or replaces) the surrounding view's input via the same
 * shadow-the-globals seam used by the sticky notification.
 *
 * Sections appear in `HELP_AREA_ORDER` from the map; rows inside each
 * section appear in declaration order. Aliases (e.g. `↑` / `k`) are joined
 * with `/`. The closing keys (`?` toggle / Esc) are listed in the help
 * area at the bottom of the overlay so the user always sees how to dismiss.
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import { glyphs, inkColors, spacing } from '../../../integration/ui/theme/tokens.ts';
import { AREA_LABEL, HELP_AREA_ORDER, getBindingsByArea, getKeyFor, type BindingArea } from '../keyboard-map.ts';

interface Props {
  readonly onClose: () => void;
}

export function HelpOverlay({ onClose }: Props): React.JSX.Element {
  // The overlay owns Esc + `?` directly. The router's global handler is
  // shadowed while the overlay is open (see `use-global-keys.ts`).
  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (input === getKeyFor('global.help')) {
      onClose();
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={inkColors.primary}
      paddingX={spacing.cardPadX}
      paddingY={0}
      marginBottom={spacing.section}
    >
      <Box>
        <Text color={inkColors.primary} bold>
          {glyphs.badge} Keyboard reference
        </Text>
      </Box>
      <Box marginTop={spacing.section} flexDirection="column">
        {HELP_AREA_ORDER.map((area) => (
          <AreaSection key={area} area={area} />
        ))}
      </Box>
      <Box marginTop={spacing.section}>
        <Text dimColor>
          press <Text bold>{getKeyFor('global.help')}</Text>
          <Text dimColor>{` or `}</Text>
          <Text bold>esc</Text>
          <Text dimColor>{` to close`}</Text>
        </Text>
      </Box>
    </Box>
  );
}

function AreaSection({ area }: { readonly area: BindingArea }): React.JSX.Element | null {
  const bindings = getBindingsByArea(area);
  if (bindings.length === 0) return null;
  return (
    <Box flexDirection="column" marginBottom={spacing.section}>
      <Text color={inkColors.muted} bold>
        {AREA_LABEL[area].toUpperCase()}
      </Text>
      {bindings.map(({ action, binding }) => (
        <Box key={action} paddingLeft={spacing.indent}>
          <Text bold>{padKeys(binding.keys.join(' / '), 12)}</Text>
          <Text dimColor>{`  ${binding.label}`}</Text>
        </Box>
      ))}
    </Box>
  );
}

function padKeys(text: string, width: number): string {
  if (text.length >= width) return text;
  return text + ' '.repeat(width - text.length);
}
