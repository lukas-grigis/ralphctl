import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { SelectOptions } from '@src/business/ports/prompt-port.ts';
import { DONUT_EMOJI, glyphs, inkColors } from '@src/integration/ui/theme/tokens.ts';

interface SelectPromptProps {
  options: SelectOptions<unknown>;
  onSubmit: (value: unknown) => void;
  onCancel: () => void;
}

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
          {DONUT_EMOJI} {options.message}:
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
  const firstEnabled = options.choices.findIndex((c) => !isDisabled(c));
  return firstEnabled >= 0 ? firstEnabled : 0;
}

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
