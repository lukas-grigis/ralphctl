/**
 * `<PromptHost />` renders the current head of the prompt queue using the
 * appropriate prompt component. When the queue is empty, nothing is rendered.
 *
 * Each prompt component receives onSubmit / onCancel callbacks that resolve
 * or reject the pending promise through `promptQueue`. The prompt components
 * themselves are pure — they don't import the queue.
 */

import React from 'react';
import { Box } from 'ink';
import { PromptCancelledError } from '../../../business/ports/prompt-port.ts';
import { usePromptState } from './hooks.ts';
import { promptQueue } from './prompt-queue.ts';
import { PromptTranscript } from './prompt-transcript.tsx';
import { ConfirmPrompt } from './confirm-prompt.tsx';
import { InputPrompt } from './input-prompt.tsx';
import { SelectPrompt } from './select-prompt.tsx';
import { CheckboxPrompt } from './checkbox-prompt.tsx';
import { EditorPrompt } from './editor-prompt.tsx';
import { FileBrowserPrompt } from './file-browser-prompt.tsx';

function cancel(): void {
  promptQueue.cancelCurrent(new PromptCancelledError());
}

export function PromptHost(): React.JSX.Element | null {
  const { current, history } = usePromptState();
  if (!current && history.length === 0) return null;

  return (
    <Box flexDirection="column">
      <PromptTranscript history={history} />
      {current ? <ActivePrompt prompt={current} /> : null}
    </Box>
  );
}

function ActivePrompt({
  prompt: current,
}: {
  prompt: NonNullable<ReturnType<typeof usePromptState>['current']>;
}): React.JSX.Element | null {
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
