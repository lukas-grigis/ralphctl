/**
 * Yes / no confirmation. Highlights the currently-focused choice; ←/→/h/l toggle, Enter
 * commits, Esc cancels. Default focus is "yes" — callers that confirm a destructive action
 * (delete, abort, overwrite) should pass `defaultYes={false}` so a reflexive Enter doesn't
 * commit the destruction.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { ScrollableMessage } from '@src/application/ui/tui/prompts/scrollable-message.tsx';

export interface ConfirmPromptProps {
  readonly message: string;
  readonly onSubmit: (value: boolean) => void;
  readonly onCancel: () => void;
  /**
   * Which option is focused on mount. `true` (default) is appropriate for additive confirms
   * ("Save this project?"); pass `false` for destructive ones so the user has to deliberately
   * move the cursor before committing.
   */
  readonly defaultYes?: boolean;
}

export const ConfirmPrompt = ({
  message,
  onSubmit,
  onCancel,
  defaultYes = true,
}: ConfirmPromptProps): React.JSX.Element => {
  const [yes, setYes] = useState(defaultYes);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      onSubmit(yes);
      return;
    }
    if (key.leftArrow || input === 'h') setYes(true);
    else if (key.rightArrow || input === 'l') setYes(false);
    else if (input === 'y') onSubmit(true);
    else if (input === 'n') onSubmit(false);
  });

  const Pill = ({ on, label }: { readonly on: boolean; readonly label: string }): React.JSX.Element => (
    <Text color={on ? inkColors.primary : inkColors.muted} bold={on}>
      {on ? `[ ${label} ]` : `  ${label}  `}
    </Text>
  );

  return (
    <Box flexDirection="column" paddingX={spacing.indent}>
      <ScrollableMessage message={message} />
      <Box marginTop={1}>
        <Pill on={yes} label="Yes" />
        <Text> </Text>
        <Pill on={!yes} label="No" />
      </Box>
      <Text dimColor>↵ submit · y/n quick · esc cancel</Text>
    </Box>
  );
};
