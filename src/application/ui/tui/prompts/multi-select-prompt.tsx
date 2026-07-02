/**
 * Multi-select prompt. Space toggles the focused option; Enter submits the current selection;
 * `a` selects all (enabled options only); `n` clears selection. Esc cancels with empty. Long
 * option lists scroll within a fixed window so the prompt frame stays predictable; `picked`
 * keeps original-index references so toggling survives scrolling.
 *
 * Disabled options (`Choice.disabled`) render dim, are skipped by cursor movement, and reject
 * both a direct toggle and `a` select-all — same gating contract as {@link SelectPrompt}'s
 * single-select cursor, extended here to the toggle set.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Choice } from '@src/business/interactive/prompt.ts';
import { glyphs, inkColors, PROMPT_VISIBLE_ROWS, spacing } from '@src/application/ui/tui/theme/tokens.ts';

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

const isEnabled = (opt: Choice<unknown> | undefined): boolean => opt !== undefined && opt.disabled !== true;

/** Walk from `from` (exclusive) in `direction`, returning the first enabled index (or `from`). */
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

/** Pure: the initial `picked` index set from `initialSelectedValues` (disabled rows excluded). */
const computeInitialPicked = (
  options: ReadonlyArray<Choice<unknown>>,
  initialSelectedValues: readonly unknown[] | undefined
): ReadonlySet<number> => {
  if (initialSelectedValues === undefined || initialSelectedValues.length === 0) return new Set();
  const preselected = new Set<number>();
  options.forEach((opt, i) => {
    if (isEnabled(opt) && initialSelectedValues.includes(opt.value)) preselected.add(i);
  });
  return preselected;
};

interface UseMultiSelectKeysArgs {
  readonly options: ReadonlyArray<Choice<unknown>>;
  readonly cursor: number;
  readonly setCursor: React.Dispatch<React.SetStateAction<number>>;
  readonly picked: ReadonlySet<number>;
  readonly setPicked: React.Dispatch<React.SetStateAction<ReadonlySet<number>>>;
  readonly onSubmit: (values: readonly unknown[]) => void;
  readonly onCancel: () => void;
}

/** Sole `useInput` registration for the prompt — cursor move, toggle, select-all/clear, submit/cancel. */
const useMultiSelectKeys = ({
  options,
  cursor,
  setCursor,
  picked,
  setPicked,
  onSubmit,
  onCancel,
}: UseMultiSelectKeysArgs): void => {
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
      if (!isEnabled(options[cursor])) return;
      setPicked((prev) => {
        const next = new Set(prev);
        if (next.has(cursor)) next.delete(cursor);
        else next.add(cursor);
        return next;
      });
      return;
    }
    if (input === 'a') {
      const all = new Set<number>();
      options.forEach((opt, i) => {
        if (isEnabled(opt)) all.add(i);
      });
      setPicked(all);
      return;
    }
    if (input === 'n') {
      setPicked(new Set());
      return;
    }
    if (key.upArrow || input === 'k') setCursor((c) => clamp(nextEnabledIndex(options, c, -1), 0, options.length - 1));
    else if (key.downArrow || input === 'j')
      setCursor((c) => clamp(nextEnabledIndex(options, c, 1), 0, options.length - 1));
  });
};

interface OptionRowProps {
  readonly opt: Choice<unknown>;
  readonly focused: boolean;
  readonly checked: boolean;
}

/** One option row: cursor glyph, checkbox, label, optional description — dimmed when disabled. */
const OptionRow = ({ opt, focused, checked }: OptionRowProps): React.JSX.Element => {
  const disabled = opt.disabled === true;
  return (
    <Box>
      <Text color={focused ? inkColors.primary : inkColors.muted}>{focused ? glyphs.actionCursor : ' '} </Text>
      <Text color={checked ? inkColors.success : inkColors.muted} bold={!disabled}>
        [{checked ? glyphs.check : ' '}]
      </Text>
      <Text bold={focused} dimColor={disabled}>
        {' '}
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
};

export interface MultiSelectPromptProps {
  readonly message: string;
  readonly options: ReadonlyArray<Choice<unknown>>;
  readonly onSubmit: (values: readonly unknown[]) => void;
  readonly onCancel: () => void;
  /**
   * Pre-check every option whose `value` appears here (`===` match). Enabled callers pass
   * e.g. a skill's `recommendedFor` list so the picker opens with a sensible starting selection
   * instead of forcing every choice to be made from scratch. Values matching a `disabled`
   * option are ignored — a disabled row can never be pre-selected.
   */
  readonly initialSelectedValues?: readonly unknown[];
}

export const MultiSelectPrompt = ({
  message,
  options,
  onSubmit,
  onCancel,
  initialSelectedValues,
}: MultiSelectPromptProps): React.JSX.Element => {
  const [cursor, setCursor] = useState(() => firstEnabledIndex(options));
  const [picked, setPicked] = useState<ReadonlySet<number>>(() => computeInitialPicked(options, initialSelectedValues));

  useMultiSelectKeys({ options, cursor, setCursor, picked, setPicked, onSubmit, onCancel });

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
          const focused = i === cursor && opt.disabled !== true;
          return <OptionRow key={`opt-${String(i)}`} opt={opt} focused={focused} checked={picked.has(i)} />;
        })}
      </Box>
      {options.length > PROMPT_VISIBLE_ROWS && (
        <Text dimColor>
          {String(cursor + 1)} of {String(options.length)}
        </Text>
      )}
      <Text dimColor>
        ↑/↓ move · space toggle · a select-all · n clear · ↵ submit ({String(picked.size)} selected) · esc cancel
      </Text>
    </Box>
  );
};
