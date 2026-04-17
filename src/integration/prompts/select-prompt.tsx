import React from 'react';
import { Box, Text, useInput } from 'ink';
import { Select } from '@inkjs/ui';
import type { SelectOptions } from '@src/business/ports/prompt.ts';
import { emoji } from '@src/integration/ui/tui/theme/tokens.ts';

export interface SelectPromptProps {
  options: SelectOptions<unknown>;
  onSubmit: (value: unknown) => void;
  onCancel: () => void;
}

export function SelectPrompt({ options, onSubmit, onCancel }: SelectPromptProps): React.JSX.Element {
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  // @inkjs/ui Select uses string values internally. We map each choice to a
  // unique string index and translate back on submit.
  const stringOptions = options.choices.map((c, i) => ({
    label: c.label,
    value: String(i),
  }));

  const defaultIndex =
    options.default === undefined
      ? undefined
      : String(options.choices.findIndex((c) => c.value === options.default));

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
          defaultValue={defaultIndex !== undefined && defaultIndex !== '-1' ? defaultIndex : undefined}
          onChange={(idxStr) => {
            const idx = Number(idxStr);
            const picked = options.choices[idx];
            if (picked && picked.disabled !== true && typeof picked.disabled !== 'string') {
              onSubmit(picked.value);
            }
          }}
        />
      </Box>
    </Box>
  );
}
