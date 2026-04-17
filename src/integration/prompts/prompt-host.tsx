/**
 * `<PromptHost />` renders the current head of the prompt queue using the
 * appropriate prompt component. When the queue is empty, nothing is rendered.
 *
 * Each prompt component receives `onSubmit` / `onCancel` callbacks that
 * resolve or reject the pending promise through `promptQueue`. This glue
 * keeps the prompt components themselves pure — they don't import the queue.
 */

import React from 'react';
import { Box } from 'ink';
import { PromptCancelledError } from '@src/business/ports/prompt.ts';
import { useCurrentPrompt } from './hooks.ts';
import { promptQueue } from './prompt-queue.ts';
import { ConfirmPrompt } from '@src/integration/prompts/confirm-prompt.tsx';
import { InputPrompt } from '@src/integration/prompts/input-prompt.tsx';
import { SelectPrompt } from '@src/integration/prompts/select-prompt.tsx';
import { CheckboxPrompt } from '@src/integration/prompts/checkbox-prompt.tsx';
import { EditorPrompt } from '@src/integration/prompts/editor-prompt.tsx';
import { FileBrowserPrompt } from '@src/integration/prompts/file-browser-prompt.tsx';

function cancel(): void {
  promptQueue.cancelCurrent(new PromptCancelledError());
}

export function PromptHost(): React.JSX.Element | null {
  const current = useCurrentPrompt();
  if (!current) return null;

  switch (current.kind) {
    case 'confirm':
      return (
        <Box>
          <ConfirmPrompt
            options={current.options}
            onSubmit={(v) => {
              promptQueue.resolveCurrent(v);
            }}
            onCancel={cancel}
          />
        </Box>
      );
    case 'input':
      return (
        <Box>
          <InputPrompt
            options={current.options}
            onSubmit={(v) => {
              promptQueue.resolveCurrent(v);
            }}
            onCancel={cancel}
          />
        </Box>
      );
    case 'select':
      return (
        <Box>
          <SelectPrompt
            options={current.options}
            onSubmit={(v) => {
              promptQueue.resolveCurrent(v);
            }}
            onCancel={cancel}
          />
        </Box>
      );
    case 'checkbox':
      return (
        <Box>
          <CheckboxPrompt
            options={current.options}
            onSubmit={(v) => {
              promptQueue.resolveCurrent(v);
            }}
            onCancel={cancel}
          />
        </Box>
      );
    case 'editor':
      return (
        <Box>
          <EditorPrompt
            options={current.options}
            onSubmit={(v) => {
              promptQueue.resolveCurrent(v);
            }}
            onCancel={() => {
              promptQueue.resolveCurrent(null);
            }}
          />
        </Box>
      );
    case 'fileBrowser':
      return (
        <Box>
          <FileBrowserPrompt
            options={current.options}
            onSubmit={(v) => {
              promptQueue.resolveCurrent(v);
            }}
            onCancel={() => {
              promptQueue.resolveCurrent(null);
            }}
          />
        </Box>
      );
    default: {
      const _exhaustive: never = current;
      void _exhaustive;
      return null;
    }
  }
}
