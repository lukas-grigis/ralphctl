import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';
import type { InputOptions } from '@src/business/ports/prompt.ts';
import { emoji } from '@src/integration/ui/theme/tokens.ts';

export interface InputPromptProps {
  options: InputOptions;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function InputPrompt({ options, onSubmit, onCancel }: InputPromptProps): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);

  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text>
          {emoji.donut} {options.message}{' '}
        </Text>
        <TextInput
          defaultValue={options.default}
          placeholder={options.default}
          onSubmit={(value) => {
            const validation = options.validate?.(value);
            if (validation !== undefined && validation !== true) {
              // Async validators (Promise<true|string>) bypass this branch —
              // they'll be awaited by the caller if needed. The sync path is
              // the common case for inline rules like "not empty".
              if (typeof validation === 'string') {
                setError(validation);
                return;
              }
            }
            setError(null);
            onSubmit(value);
          }}
        />
      </Box>
      {error !== null && (
        <Box>
          <Text color="red">
            {' '}
            ✗ {error}
          </Text>
        </Box>
      )}
    </Box>
  );
}
