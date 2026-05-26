/**
 * Prompt host — the React side of the prompt queue. Subscribes to the queue, renders the head
 * prompt component, and maps user actions back to `resolveHead` / `rejectHead`. While a prompt
 * is mounted, the global key handler is suspended (via `UiState.promptActive`) so view-level
 * keys can't fight the modal.
 *
 * The host renders nothing when the queue is empty — composers can mount it unconditionally
 * and trust it to stay invisible until needed.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { PromptQueue, PendingPrompt } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { TextPrompt } from '@src/application/ui/tui/prompts/text-prompt.tsx';
import { TextAreaPrompt } from '@src/application/ui/tui/prompts/text-area-prompt.tsx';
import { ConfirmPrompt } from '@src/application/ui/tui/prompts/confirm-prompt.tsx';
import { SelectPrompt } from '@src/application/ui/tui/prompts/select-prompt.tsx';
import { MultiSelectPrompt } from '@src/application/ui/tui/prompts/multi-select-prompt.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';

export interface PromptHostProps {
  readonly queue: PromptQueue;
}

export const PromptHost = ({ queue }: PromptHostProps): React.JSX.Element | null => {
  const [head, setHead] = useState<PendingPrompt | undefined>(() => queue.head);
  const ui = useUiState();

  useEffect(() => {
    const sync = (): void => {
      setHead(queue.head);
    };
    sync();
    return queue.subscribe(sync);
  }, [queue]);

  // Claim the global-key mute only while a queued prompt is mounted. The previous code set
  // `promptActive=false` whenever the queue was empty, which clobbered view-level claims
  // (wizards setting it to true) on every commit cycle.
  //
  // Stash `claimPrompt` in a local so the effect depends on the stable callback — depending on
  // `ui` itself would re-fire whenever any unrelated UI state (helpOpen, claims counter, …)
  // toggled, which would release + re-claim the mute on every keystroke.
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
          onSubmit={(values): void => queue.resolveHead(values)}
          onCancel={cancel}
        />
      );
  }
};
