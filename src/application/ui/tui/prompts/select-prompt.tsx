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
  /**
   * Optional dim line rendered between the option list and the navigation legend. Used by the
   * Settings provider picker to surface install guidance ("install codex CLI with …") so the
   * user can act on the gate without leaving the prompt.
   */
  readonly footer?: string;
}

const isEnabled = (opt: Choice<unknown> | undefined): boolean => opt !== undefined && opt.disabled !== true;

/**
 * Walk from `from` (exclusive) in `direction` (-1 or +1) and return the first enabled index.
 * Returns `from` unchanged when no enabled option exists in that direction so the cursor never
 * jumps onto a disabled row.
 */
const nextEnabledIndex = (options: ReadonlyArray<Choice<unknown>>, from: number, direction: -1 | 1): number => {
  for (let i = from + direction; i >= 0 && i < options.length; i += direction) {
    if (isEnabled(options[i])) return i;
  }
  return from;
};

const firstEnabledIndex = (options: ReadonlyArray<Choice<unknown>>): number => {
  for (let i = 0; i < options.length; i += 1) {
    if (isEnabled(options[i])) return i;
  }
  return 0;
};

const lastEnabledIndex = (options: ReadonlyArray<Choice<unknown>>): number => {
  for (let i = options.length - 1; i >= 0; i -= 1) {
    if (isEnabled(options[i])) return i;
  }
  return Math.max(0, options.length - 1);
};

export const SelectPrompt = ({
  message,
  options,
  onSubmit,
  onCancel,
  footer,
}: SelectPromptProps): React.JSX.Element => {
  // Seed the cursor on the first enabled option so the initial frame doesn't land on a
  // disabled row (e.g. when every provider's CLI is missing the picker still must show
  // something selectable — the caller is expected to provide at least one enabled option, but
  // we tolerate an all-disabled list by leaving the cursor at 0 with submission blocked).
  const [cursor, setCursor] = useState(() => firstEnabledIndex(options));

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      const opt = options[cursor];
      // Block submission of a disabled option — the renderer also surfaces the disabled
      // affordance visually, but we belt-and-brace here so a stale cursor cannot bypass the
      // gate.
      if (opt !== undefined && opt.disabled !== true) onSubmit(opt.value);
      return;
    }
    if (key.upArrow || input === 'k') setCursor((c) => clamp(nextEnabledIndex(options, c, -1), 0, options.length - 1));
    else if (key.downArrow || input === 'j')
      setCursor((c) => clamp(nextEnabledIndex(options, c, 1), 0, options.length - 1));
    else if (input === 'g') setCursor(firstEnabledIndex(options));
    else if (input === 'G') setCursor(lastEnabledIndex(options));
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
          const disabled = opt.disabled === true;
          // Disabled rows render dim with no cursor glyph even on the (rare) focused frame so
          // the visual affordance matches the keyboard behaviour — they aren't reachable.
          return (
            <Box key={`opt-${String(i)}`}>
              <Text color={focused && !disabled ? inkColors.primary : inkColors.muted}>
                {focused && !disabled ? glyphs.actionCursor : ' '}{' '}
              </Text>
              <Text bold={focused && !disabled} dimColor={disabled}>
                {opt.label}
              </Text>
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
      {footer !== undefined && <Text dimColor>{footer}</Text>}
      <Text dimColor>↑/↓ navigate · ↵ submit · esc cancel</Text>
    </Box>
  );
};
