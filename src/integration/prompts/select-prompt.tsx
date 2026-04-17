import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Select } from '@inkjs/ui';
import type { SelectOptions } from '@src/business/ports/prompt.ts';
import { emoji } from '@src/integration/ui/tui/theme/tokens.ts';

export interface SelectPromptProps {
  options: SelectOptions<unknown>;
  onSubmit: (value: unknown) => void;
  onCancel: () => void;
}

/**
 * Wraps `@inkjs/ui` Select with an Enter-on-default fix.
 *
 * The library's `onChange` only fires when the highlight *changes*, so
 * pressing Enter on the pre-selected default never submitted. We mirror the
 * highlight in local state and bind Enter via `useInput` so the current
 * selection commits regardless of whether the user moved off the default.
 */
export function SelectPrompt({ options, onSubmit, onCancel }: SelectPromptProps): React.JSX.Element {
  // @inkjs/ui Select uses string values internally. We map each choice to a
  // unique string index and translate back on submit.
  const stringOptions = options.choices.map((c, i) => ({
    label: c.label,
    value: String(i),
  }));

  const initialIdx =
    options.default === undefined
      ? 0
      : Math.max(
          0,
          options.choices.findIndex((c) => c.value === options.default)
        );

  const [selectedIdx, setSelectedIdx] = useState(initialIdx);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      const picked = options.choices[selectedIdx];
      if (picked && picked.disabled !== true && typeof picked.disabled !== 'string') {
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
      <Box marginLeft={2}>
        <Select
          options={stringOptions}
          defaultValue={String(selectedIdx)}
          onChange={(idxStr) => {
            setSelectedIdx(Number(idxStr));
          }}
        />
      </Box>
    </Box>
  );
}
