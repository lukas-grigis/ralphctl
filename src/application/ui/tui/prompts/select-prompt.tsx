/**
 * Single-select prompt. Vertical list of `Choice<T>`; arrows navigate, Enter submits, Esc
 * cancels. Long option lists scroll within a fixed window so the prompt frame stays predictable.
 *
 * When the prompt message carries a body region longer than the viewport (see `ScrollableMessage`),
 * the body yields ↑/↓ to the option cursor (passed via `ownsArrows={false}`) so arrows behave the
 * same as everywhere else in the app. The body still scrolls — just via PgUp/PgDn (page) and
 * Ctrl+u/d (half-page), keys that don't conflict with option navigation.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Choice } from '@src/business/interactive/prompt.ts';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { ScrollableMessage } from '@src/application/ui/tui/prompts/scrollable-message.tsx';

const VISIBLE_ROWS = 8;

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

export interface SelectPromptProps {
  readonly message: string;
  readonly options: ReadonlyArray<Choice<unknown>>;
  readonly onSubmit: (value: unknown) => void;
  readonly onCancel: () => void;
}

export const SelectPrompt = ({ message, options, onSubmit, onCancel }: SelectPromptProps): React.JSX.Element => {
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return || input === ' ') {
      const opt = options[cursor];
      if (opt !== undefined) onSubmit(opt.value);
      return;
    }
    if (key.upArrow || input === 'k') setCursor((c) => clamp(c - 1, 0, options.length - 1));
    else if (key.downArrow || input === 'j') setCursor((c) => clamp(c + 1, 0, options.length - 1));
    else if (input === 'g') setCursor(0);
    else if (input === 'G') setCursor(options.length - 1);
  });

  const half = Math.floor(VISIBLE_ROWS / 2);
  const start = clamp(cursor - half, 0, Math.max(0, options.length - VISIBLE_ROWS));
  const end = Math.min(options.length, start + VISIBLE_ROWS);

  return (
    <Box flexDirection="column" paddingX={spacing.indent}>
      <ScrollableMessage message={message} ownsArrows={false} />
      <Box flexDirection="column" marginTop={1}>
        {options.slice(start, end).map((opt, localIdx) => {
          const i = start + localIdx;
          const focused = i === cursor;
          return (
            <Box key={`opt-${String(i)}`}>
              <Text color={focused ? inkColors.primary : inkColors.muted}>{focused ? glyphs.actionCursor : ' '} </Text>
              <Text bold={focused}>{opt.label}</Text>
              {opt.description !== undefined && (
                <Text dimColor>
                  {' '}
                  {glyphs.emDash} {opt.description}
                </Text>
              )}
            </Box>
          );
        })}
      </Box>
      {options.length > VISIBLE_ROWS && (
        <Text dimColor>
          {String(cursor + 1)} of {String(options.length)}
        </Text>
      )}
      <Text dimColor>↑/↓ navigate · ↵ submit · esc cancel</Text>
    </Box>
  );
};
