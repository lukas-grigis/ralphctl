import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { CheckboxOptions } from '@src/business/ports/prompt.ts';
import { emoji, glyphs, inkColors } from '@src/integration/ui/theme/tokens.ts';

interface CheckboxPromptProps {
  options: CheckboxOptions<unknown>;
  onSubmit: (value: unknown[]) => void;
  onCancel: () => void;
}

/**
 * Self-contained checkbox prompt. Shares the rendering conventions of
 * `<SelectPrompt>` — `›` cursor + highlight color for focus, dimmed rows for
 * disabled — so multi-select visually matches single-select.
 */
export function CheckboxPrompt({ options, onSubmit, onCancel }: CheckboxPromptProps): React.JSX.Element {
  const initialFocus = options.choices.findIndex((c) => !isDisabled(c));
  const [focusedIdx, setFocusedIdx] = useState(initialFocus >= 0 ? initialFocus : 0);
  const [checked, setChecked] = useState<Set<number>>(() => seedCheckedSet(options));

  useInput((input, key) => {
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
    if (input === ' ') {
      const choice = options.choices[focusedIdx];
      if (choice && !isDisabled(choice)) {
        setChecked((prev) => {
          const next = new Set(prev);
          if (next.has(focusedIdx)) next.delete(focusedIdx);
          else next.add(focusedIdx);
          return next;
        });
      }
      return;
    }
    if (key.return) {
      const picked = [...checked]
        .sort((a, b) => a - b)
        .map((i) => options.choices[i]?.value)
        .filter((v): v is unknown => v !== undefined);
      onSubmit(picked);
    }
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text>
          {emoji.donut} {options.message} <Text dimColor>(space toggles, enter submits)</Text>
        </Text>
      </Box>
      <Box marginLeft={2} flexDirection="column">
        {options.choices.map((choice, i) => {
          const isFocused = i === focusedIdx;
          const disabled = isDisabled(choice);
          const color = disabled ? inkColors.muted : isFocused ? inkColors.highlight : undefined;
          const cursor = isFocused ? glyphs.actionCursor : ' ';
          const mark = checked.has(i) ? glyphs.check : glyphs.phasePending;
          return (
            <Box key={`${String(i)}-${choice.label}`}>
              <Text color={color} bold={isFocused}>
                {`${cursor} ${mark} ${choice.label}`}
              </Text>
              {typeof choice.disabled === 'string' ? <Text dimColor>{`  (${choice.disabled})`}</Text> : null}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function isDisabled(choice: CheckboxOptions<unknown>['choices'][number]): boolean {
  return choice.disabled === true || typeof choice.disabled === 'string';
}

function seedCheckedSet(options: CheckboxOptions<unknown>): Set<number> {
  const defaults = options.defaults ?? [];
  const set = new Set<number>();
  for (const v of defaults) {
    const idx = options.choices.findIndex((c) => c.value === v);
    if (idx >= 0) set.add(idx);
  }
  return set;
}

function stepFocus(choices: CheckboxOptions<unknown>['choices'], from: number, delta: -1 | 1): number {
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
