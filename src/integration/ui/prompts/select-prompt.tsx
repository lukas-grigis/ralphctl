import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { SelectOptions } from '@src/business/ports/prompt.ts';
import { emoji, glyphs, inkColors } from '@src/integration/ui/theme/tokens.ts';

interface SelectPromptProps {
  options: SelectOptions<unknown>;
  onSubmit: (value: unknown) => void;
  onCancel: () => void;
}

/**
 * A small self-contained select prompt.
 *
 * We deliberately don't use `@inkjs/ui`'s `<Select>` here: its internal
 * state keeps the initial focus on the first option regardless of
 * `defaultValue`, and its `onChange` only fires when the committed value
 * changes — which made Enter-on-default silently submit whatever was at
 * index 0 instead of the option the user actually highlighted. Owning the
 * focused index locally lets us honour `options.default`, step over
 * disabled items, and emit exactly `choices[focusedIdx].value` on Enter.
 */
export function SelectPrompt({ options, onSubmit, onCancel }: SelectPromptProps): React.JSX.Element {
  const initialIdx = findInitialIdx(options);
  const [focusedIdx, setFocusedIdx] = useState(initialIdx);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setFocusedIdx((i) => stepFocus(options.choices, i, -1));
      return;
    }
    if (key.downArrow) {
      setFocusedIdx((i) => stepFocus(options.choices, i, 1));
      return;
    }
    if (key.return) {
      const picked = options.choices[focusedIdx];
      if (picked && !isDisabled(picked)) {
        onSubmit(picked.value);
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text>
          {emoji.donut} {options.message}
        </Text>
      </Box>
      <Box marginLeft={2} flexDirection="column">
        {options.choices.map((choice, i) => {
          const isFocused = i === focusedIdx;
          const disabled = isDisabled(choice);
          const color = disabled ? inkColors.muted : isFocused ? inkColors.highlight : undefined;
          const prefix = isFocused ? glyphs.actionCursor : ' ';
          return (
            <Box key={`${String(i)}-${choice.label}`}>
              <Text color={color} bold={isFocused}>
                {`${prefix} ${choice.label}`}
              </Text>
              {typeof choice.disabled === 'string' ? <Text dimColor>{`  (${choice.disabled})`}</Text> : null}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function isDisabled(choice: SelectOptions<unknown>['choices'][number]): boolean {
  return choice.disabled === true || typeof choice.disabled === 'string';
}

function findInitialIdx(options: SelectOptions<unknown>): number {
  if (options.default !== undefined) {
    const idx = options.choices.findIndex((c) => c.value === options.default);
    const chosen = options.choices[idx];
    if (idx >= 0 && chosen && !isDisabled(chosen)) return idx;
  }
  // Fall back to the first non-disabled choice.
  const firstEnabled = options.choices.findIndex((c) => !isDisabled(c));
  return firstEnabled >= 0 ? firstEnabled : 0;
}

/**
 * Move the focus by `delta` (-1 or +1), skipping disabled rows. Wraps to the
 * opposite end when it falls off, so navigation is always responsive.
 */
function stepFocus(choices: SelectOptions<unknown>['choices'], from: number, delta: -1 | 1): number {
  const len = choices.length;
  if (len === 0) return from;
  let next = from;
  for (let i = 0; i < len; i++) {
    next = (next + delta + len) % len;
    const candidate = choices[next];
    if (candidate && !isDisabled(candidate)) return next;
  }
  return from;
}
