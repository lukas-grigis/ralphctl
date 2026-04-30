import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';
import type { InputOptions } from '../../../business/ports/prompt-port.ts';
import { DONUT_EMOJI, inkColors } from '../theme/tokens.ts';

interface InputPromptProps {
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
          {DONUT_EMOJI} {options.message}:{' '}
        </Text>
        <TextInput
          defaultValue={options.default}
          placeholder={options.default}
          onSubmit={(value) => {
            const validation = options.validate?.(value);
            if (validation !== undefined && validation !== true) {
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
          <Text color={inkColors.error}> ✗ {error}</Text>
        </Box>
      )}
    </Box>
  );
}
