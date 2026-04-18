import React from 'react';
import { Box, Text } from 'ink';
import { ConfirmInput } from '@inkjs/ui';
import type { ConfirmOptions } from '@src/business/ports/prompt.ts';
import { emoji, glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';

interface ConfirmPromptProps {
  options: ConfirmOptions;
  onSubmit: (value: boolean) => void;
  onCancel: () => void;
}

export function ConfirmPrompt({ options, onSubmit }: ConfirmPromptProps): React.JSX.Element {
  const hint = options.default === false ? '(y/N)' : '(Y/n)';
  const details = options.details?.trim();
  return (
    <Box flexDirection="column">
      {details ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={inkColors.muted}
          paddingX={spacing.gutter}
          marginBottom={spacing.section}
        >
          {details.split('\n').map((line, idx) => (
            <Text key={idx}>
              {line.length > 0 ? (
                <>
                  <Text color={inkColors.muted}>{glyphs.quoteRail} </Text>
                  {line}
                </>
              ) : (
                ' '
              )}
            </Text>
          ))}
        </Box>
      ) : null}
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
    </Box>
  );
}
