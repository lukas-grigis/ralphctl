import React from 'react';
import { Box, Text } from 'ink';
import { ConfirmInput } from '@inkjs/ui';
import type { ConfirmOptions } from '@src/business/ports/prompt.ts';
import { emoji } from '@src/integration/ui/theme/tokens.ts';

interface ConfirmPromptProps {
  options: ConfirmOptions;
  onSubmit: (value: boolean) => void;
  onCancel: () => void;
}

export function ConfirmPrompt({ options, onSubmit }: ConfirmPromptProps): React.JSX.Element {
  const hint = options.default === false ? '(y/N)' : '(Y/n)';
  return (
    <Box>
      <Text>
        {emoji.donut} {options.message}{' '}
      </Text>
      <Text dimColor>{hint} </Text>
      <ConfirmInput
        defaultChoice={options.default === false ? 'cancel' : 'confirm'}
        onConfirm={() => {
          onSubmit(true);
        }}
        onCancel={() => {
          onSubmit(false);
        }}
      />
    </Box>
  );
}
