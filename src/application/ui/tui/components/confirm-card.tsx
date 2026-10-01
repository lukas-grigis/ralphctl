/**
 * `ConfirmCard` — the destructive-confirm body shared by every list / detail view. One `verb`
 * feeds both the title (`Remove sprint "X"?`) and the prompt (`Remove?`), so the two can't
 * disagree. Claims the prompt on mount (muting global keys) and releases on unmount, so hosts
 * mount it only while the confirmation is pending.
 *
 * @public
 */

import React, { useEffect } from 'react';
import { Box, Text } from 'ink';
import { spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { ConfirmPrompt } from '@src/application/ui/tui/prompts/confirm-prompt.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';

export interface ConfirmCardProps {
  /** The action in imperative form (`Remove`, `Stop run`, `Publish`); shared by title and prompt. */
  readonly verb: string;
  /** What the verb acts on, e.g. `sprint "X"`. Strings render bold. */
  readonly target: React.ReactNode;
  /** Concrete consequence lines under the title. */
  readonly body?: React.ReactNode;
  readonly onSubmit: (value: boolean) => void;
  readonly onCancel: () => void;
}

export const ConfirmCard = ({ verb, target, body, onSubmit, onCancel }: ConfirmCardProps): React.JSX.Element => {
  const claimPrompt = useUiState().claimPrompt;
  useEffect(() => claimPrompt(), [claimPrompt]);

  return (
    <Box flexDirection="column" paddingX={spacing.indent}>
      <Text>
        {verb} {typeof target === 'string' ? <Text bold>{target}</Text> : target}?
      </Text>
      {body}
      <Box marginTop={spacing.section}>
        <ConfirmPrompt message={`${verb}?`} defaultYes={false} destructive onSubmit={onSubmit} onCancel={onCancel} />
      </Box>
    </Box>
  );
};
