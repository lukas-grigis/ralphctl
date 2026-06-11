/**
 * `ConfirmCard` — the destructive-confirm body shared by the list / detail views (projects,
 * project-detail, sprints, sprint-detail). Each rendered its own `Box` + message lines +
 * `ConfirmPrompt`, plus a per-view `useEffect(() => x !== undefined ? claimPrompt() : undefined)`
 * to mute the global keys while the prompt is up.
 *
 * The card is only mounted while its host view's "pending removal" state is set, so it claims
 * the prompt on mount and releases on unmount — one effect here replaces the four per-view
 * conditional-claim effects. Callers pass the exact message JSX (`title`, optional `body`) so
 * wording stays byte-identical per call site; the card owns the layout, the claim, and the
 * `defaultYes={false}` destructive-confirm prompt.
 *
 * @public
 */

import React, { useEffect } from 'react';
import { Box } from 'ink';
import { spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { ConfirmPrompt } from '@src/application/ui/tui/prompts/confirm-prompt.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';

export interface ConfirmCardProps {
  /** Primary prompt line(s) — supplied as JSX so the host keeps its exact bold/dim wording. */
  readonly title: React.ReactNode;
  /** Optional secondary line(s) rendered directly under the title (e.g. a dim caveat). */
  readonly body?: React.ReactNode;
  /** Label shown inside the yes/no {@link ConfirmPrompt} (e.g. `Delete?` / `Remove?`). */
  readonly message: string;
  readonly onSubmit: (value: boolean) => void;
  readonly onCancel: () => void;
}

export const ConfirmCard = ({ title, body, message, onSubmit, onCancel }: ConfirmCardProps): React.JSX.Element => {
  // Mute the global keys for as long as this card is mounted; the host only mounts it while a
  // removal is pending, so mount/unmount maps 1:1 onto the old per-view conditional claim.
  const claimPrompt = useUiState().claimPrompt;
  useEffect(() => claimPrompt(), [claimPrompt]);

  return (
    <Box flexDirection="column" paddingX={spacing.indent}>
      {title}
      {body}
      <Box marginTop={1}>
        <ConfirmPrompt message={message} defaultYes={false} onSubmit={onSubmit} onCancel={onCancel} />
      </Box>
    </Box>
  );
};
