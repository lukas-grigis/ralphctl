/** Yes / no confirmation. Highlights the focused choice; ←/→/h/l toggle, Enter commits, Esc cancels. */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { ScrollableMessage } from '@src/application/ui/tui/prompts/scrollable-message.tsx';
import { usePromptHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';

export interface ConfirmPromptProps {
  readonly message: string;
  readonly onSubmit: (value: boolean) => void;
  readonly onCancel: () => void;
  /** Which option is focused on mount. */
  readonly defaultYes?: boolean;
  /** Only ←/→/y/n move or answer; `h`/`l` are ignored. */
  readonly destructive?: boolean;
}

const CONFIRM_HINTS = [
  { keys: '↵', label: 'submit' },
  { keys: 'y/n', label: 'quick' },
  { keys: 'esc', label: 'cancel' },
];

export const ConfirmPrompt = ({
  message,
  onSubmit,
  onCancel,
  defaultYes = true,
  destructive = false,
}: ConfirmPromptProps): React.JSX.Element => {
  const [yes, setYes] = useState(defaultYes);

  usePromptHints(CONFIRM_HINTS);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      onSubmit(yes);
      return;
    }
    const vimKeys = !destructive;
    if (key.leftArrow || (vimKeys && input === 'h')) setYes(true);
    else if (key.rightArrow || (vimKeys && input === 'l')) setYes(false);
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
      <Box marginTop={spacing.section}>
        <Pill on={yes} label="Yes" />
        <Text> </Text>
        <Pill on={!yes} label="No" />
      </Box>
      <Text dimColor>↵ submit · y/n quick · esc cancel</Text>
    </Box>
  );
};
