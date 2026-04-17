import React from 'react';
import { Box, Text, useInput } from 'ink';
import { MultiSelect } from '@inkjs/ui';
import type { CheckboxOptions } from '@src/business/ports/prompt.ts';
import { emoji } from '@src/integration/ui/theme/tokens.ts';

export interface CheckboxPromptProps {
  options: CheckboxOptions<unknown>;
  onSubmit: (value: unknown[]) => void;
  onCancel: () => void;
}

export function CheckboxPrompt({ options, onSubmit, onCancel }: CheckboxPromptProps): React.JSX.Element {
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  const stringOptions = options.choices.map((c, i) => ({
    label: c.label,
    value: String(i),
  }));

  const defaults = (options.defaults ?? [])
    .map((v) => options.choices.findIndex((c) => c.value === v))
    .filter((i) => i >= 0)
    .map((i) => String(i));

  return (
    <Box flexDirection="column">
      <Box>
        <Text>
          {emoji.donut} {options.message} <Text dimColor>(space: toggle, enter: submit)</Text>
        </Text>
      </Box>
      <Box marginLeft={2}>
        <MultiSelect
          options={stringOptions}
          defaultValue={defaults}
          onSubmit={(values) => {
            const picked = values
              .map((s) => options.choices[Number(s)])
              .filter((c): c is NonNullable<typeof c> => c !== undefined)
              .map((c) => c.value);
            onSubmit(picked);
          }}
        />
      </Box>
    </Box>
  );
}
