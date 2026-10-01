/**
 * Prompt host — the React side of the prompt queue. Subscribes to the queue, renders the head prompt component, and
 * maps user actions back to `resolveHead` / `rejectHead`.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { PendingPrompt, PromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { TextPrompt } from '@src/application/ui/tui/prompts/text-prompt.tsx';
import { TextAreaPrompt } from '@src/application/ui/tui/prompts/text-area-prompt.tsx';
import { ConfirmPrompt } from '@src/application/ui/tui/prompts/confirm-prompt.tsx';
import { SelectPrompt } from '@src/application/ui/tui/prompts/select-prompt.tsx';
import { MultiSelectPrompt } from '@src/application/ui/tui/prompts/multi-select-prompt.tsx';
import { flowIdToTitle } from '@src/application/ui/shared/flow-title.ts';
import { useOptionalRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useOptionalSessionManager } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';

export interface PromptHostProps {
  readonly queue: PromptQueue;
}

/** `<Flow> · <sprint>` for a prompt raised by a run other than the one on screen; otherwise undefined. */
const usePromptOrigin = (head: PendingPrompt | undefined): string | undefined => {
  const router = useOptionalRouter();
  const sessions = useOptionalSessionManager();
  const sessionId = head?.sessionId;
  if (sessionId === undefined || sessions === undefined) return undefined;
  const current = router?.current;
  if (current?.id === 'execute' && current.props?.sessionId === sessionId) return undefined;
  const descriptor = sessions.get(sessionId)?.descriptor;
  if (descriptor === undefined) return undefined;
  const flow = flowIdToTitle(descriptor.flowId);
  return descriptor.pinnedSprintLabel !== undefined
    ? `${flow} ${glyphs.inlineDot} ${descriptor.pinnedSprintLabel}`
    : flow;
};

export const PromptHost = ({ queue }: PromptHostProps): React.JSX.Element | null => {
  const [head, setHead] = useState<PendingPrompt | undefined>(() => queue.head);
  const ui = useUiState();
  const origin = usePromptOrigin(head);

  useEffect(() => {
    const sync = (): void => {
      setHead(queue.head);
    };
    sync();
    return queue.subscribe(sync);
  }, [queue]);

  // Claim the global-key mute only while a queued prompt is mounted.
  const claimPrompt = ui.claimPrompt;
  useEffect(() => (head !== undefined ? claimPrompt() : undefined), [head, claimPrompt]);

  if (!head) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={inkColors.primary}
      paddingX={spacing.cardPadX}
      paddingY={0}
      marginTop={spacing.section}
    >
      <Box>
        <Text color={inkColors.primary} bold>
          {glyphs.badge} Question{queue.size > 1 ? ` (${String(queue.size)} pending)` : ''}
        </Text>
        {origin !== undefined && <Text dimColor>{`  from ${origin}`}</Text>}
      </Box>
      {renderPrompt(head, queue)}
    </Box>
  );
};

const renderPrompt = (prompt: PendingPrompt, queue: PromptQueue): React.JSX.Element => {
  const cancel = (): void => queue.rejectHead(new Error('cancelled by user'));

  switch (prompt.kind) {
    case 'text':
      return (
        <TextPrompt
          message={prompt.message}
          {...(prompt.initial !== undefined ? { initial: prompt.initial } : {})}
          onSubmit={(value): void => queue.resolveHead(value)}
          onCancel={cancel}
        />
      );
    case 'textarea':
      return (
        <TextAreaPrompt
          message={prompt.message}
          {...(prompt.initial !== undefined ? { initial: prompt.initial } : {})}
          onSubmit={(value): void => queue.resolveHead(value)}
          onCancel={cancel}
        />
      );
    case 'confirm':
      return (
        <ConfirmPrompt
          message={prompt.message}
          onSubmit={(value): void => queue.resolveHead(value)}
          onCancel={cancel}
        />
      );
    case 'choice':
      return (
        <SelectPrompt
          message={prompt.message}
          options={prompt.options}
          onSubmit={(value): void => queue.resolveHead(value)}
          onCancel={cancel}
        />
      );
    case 'multi-choice':
      return (
        <MultiSelectPrompt
          message={prompt.message}
          options={prompt.options}
          {...(prompt.initial !== undefined ? { initialSelectedValues: prompt.initial } : {})}
          onSubmit={(values): void => queue.resolveHead(values)}
          onCancel={cancel}
        />
      );
  }
};
