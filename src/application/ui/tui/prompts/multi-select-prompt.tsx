/**
 * Multi-select prompt. Space toggles the focused option; Enter submits the current selection;
 * `a` selects all; `n` clears selection. Esc cancels with empty. Long option lists scroll
 * within a fixed window so the prompt frame stays predictable; `picked` keeps original-index
 * references so toggling survives scrolling.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Choice } from '@src/business/interactive/prompt.ts';
import { glyphs, inkColors, PROMPT_VISIBLE_ROWS, spacing } from '@src/application/ui/tui/theme/tokens.ts';

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

export interface MultiSelectPromptProps {
  readonly message: string;
  readonly options: ReadonlyArray<Choice<unknown>>;
  readonly onSubmit: (values: readonly unknown[]) => void;
  readonly onCancel: () => void;
}

export const MultiSelectPrompt = ({
  message,
  options,
  onSubmit,
  onCancel,
}: MultiSelectPromptProps): React.JSX.Element => {
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());

  const toggle = (idx: number): void => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      const values = [...picked]
        .sort((a, b) => a - b)
        .map((i) => options[i]?.value)
        .filter((v): v is unknown => v !== undefined);
      onSubmit(values);
      return;
    }
    if (input === ' ') {
      toggle(cursor);
      return;
    }
    if (input === 'a') {
      const all = new Set<number>();
      for (let i = 0; i < options.length; i++) all.add(i);
      setPicked(all);
      return;
    }
    if (input === 'n') {
      setPicked(new Set());
      return;
    }
    if (key.upArrow || input === 'k') setCursor((c) => clamp(c - 1, 0, options.length - 1));
    else if (key.downArrow || input === 'j') setCursor((c) => clamp(c + 1, 0, options.length - 1));
  });

  const half = Math.floor(PROMPT_VISIBLE_ROWS / 2);
  const start = clamp(cursor - half, 0, Math.max(0, options.length - PROMPT_VISIBLE_ROWS));
  const end = Math.min(options.length, start + PROMPT_VISIBLE_ROWS);

  return (
    <Box flexDirection="column" paddingX={spacing.indent}>
      <Text color={inkColors.primary} bold>
        {glyphs.actionCursor} {message}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {options.slice(start, end).map((opt, localIdx) => {
          const i = start + localIdx;
          const focused = i === cursor;
          const checked = picked.has(i);
          return (
            <Box key={`opt-${String(i)}`}>
              <Text color={focused ? inkColors.primary : inkColors.muted}>{focused ? glyphs.actionCursor : ' '} </Text>
              <Text color={checked ? inkColors.success : inkColors.muted} bold>
                [{checked ? glyphs.check : ' '}]
              </Text>
              <Text bold={focused}> {opt.label}</Text>
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
      {options.length > PROMPT_VISIBLE_ROWS && (
        <Text dimColor>
          {String(cursor + 1)} of {String(options.length)}
        </Text>
      )}
      <Text dimColor>
        space toggle · a select-all · n clear · ↵ submit ({String(picked.size)} selected) · esc cancel
      </Text>
    </Box>
  );
};
