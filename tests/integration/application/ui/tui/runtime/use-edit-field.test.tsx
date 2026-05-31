/**
 * Verify the reusable `useEditField` hook: pre-fills the prompt with the current value,
 * surfaces validation errors as feedback, surfaces onSave errors, and silent-cancels on Esc.
 */

import React, { useEffect } from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { PromptQueueProvider } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import { UiStateProvider } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import {
  type OpenEditPromptInput,
  useEditField,
  type UseEditFieldState,
} from '@src/application/ui/tui/runtime/use-edit-field.ts';

const flush = async (): Promise<void> => {
  await new Promise((res) => setTimeout(res, 5));
};

const Probe = ({
  capture,
  trigger,
}: {
  readonly capture: (api: UseEditFieldState) => void;
  readonly trigger: OpenEditPromptInput;
}): React.JSX.Element => {
  const api = useEditField();
  capture(api);
  useEffect(() => {
    void api.openEditPrompt(trigger);
    // Launch once per mount — capture the initial trigger / api closure on purpose.
  }, [api, trigger]);
  return <Text>{api.feedback ?? 'idle'}</Text>;
};

const mount = (
  queue: ReturnType<typeof createPromptQueue>,
  trigger: OpenEditPromptInput,
  capture: (api: UseEditFieldState) => void
): ReturnType<typeof render> =>
  render(
    <UiStateProvider>
      <PromptQueueProvider value={queue}>
        <Probe capture={capture} trigger={trigger} />
      </PromptQueueProvider>
    </UiStateProvider>
  );

describe('useEditField', () => {
  it('passes the current value as initial buffer and calls onSave with the resolved string', async () => {
    const queue = createPromptQueue();
    let saved: string | undefined;
    const trigger: OpenEditPromptInput = {
      title: 'Edit name',
      kind: 'short',
      currentValue: 'old name',
      onSave: async (value) => {
        saved = value;
        return Result.ok(undefined);
      },
    };
    let latest: UseEditFieldState | undefined;
    const r = mount(queue, trigger, (api) => {
      latest = api;
    });
    // Wait one tick so the effect fires and enqueues the prompt.
    await flush();
    expect(queue.head?.kind).toBe('text');
    if (queue.head?.kind === 'text') {
      expect(queue.head.initial).toBe('old name');
    }
    queue.resolveHead('new name');
    await flush();
    expect(saved).toBe('new name');
    expect(latest?.feedback).toBe('✓ saved');
    r.unmount();
  });

  it('surfaces validate() errors as feedback without calling onSave', async () => {
    const queue = createPromptQueue();
    let called = false;
    const trigger: OpenEditPromptInput = {
      title: 'Edit name',
      kind: 'short',
      currentValue: 'old',
      validate: (raw) =>
        raw.length < 3
          ? Result.error(new ValidationError({ field: 'name', value: raw, message: 'too short' }))
          : Result.ok(raw),
      onSave: async () => {
        called = true;
        return Result.ok(undefined);
      },
    };
    let latest: UseEditFieldState | undefined;
    const r = mount(queue, trigger, (api) => {
      latest = api;
    });
    await flush();
    queue.resolveHead('hi');
    await flush();
    expect(called).toBe(false);
    expect(latest?.feedback).toMatch(/too short/);
    r.unmount();
  });

  it('surfaces onSave errors as feedback', async () => {
    const queue = createPromptQueue();
    const trigger: OpenEditPromptInput = {
      title: 'Edit name',
      kind: 'short',
      currentValue: 'old',
      onSave: async () => Result.error(new ValidationError({ field: 'name', value: 'x', message: 'persist failed' })),
    };
    let latest: UseEditFieldState | undefined;
    const r = mount(queue, trigger, (api) => {
      latest = api;
    });
    await flush();
    queue.resolveHead('new');
    await flush();
    expect(latest?.feedback).toMatch(/persist failed/);
    r.unmount();
  });

  it('silently clears feedback on Esc cancel', async () => {
    const queue = createPromptQueue();
    const trigger: OpenEditPromptInput = {
      title: 'Edit name',
      kind: 'short',
      currentValue: 'old',
      onSave: async () => Result.ok(undefined),
    };
    let latest: UseEditFieldState | undefined;
    const r = mount(queue, trigger, (api) => {
      latest = api;
    });
    await flush();
    queue.rejectHead(new Error('cancelled by user'));
    await flush();
    expect(latest?.feedback).toBeUndefined();
    r.unmount();
  });

  it('enqueues a textarea prompt when kind is "long"', async () => {
    const queue = createPromptQueue();
    const trigger: OpenEditPromptInput = {
      title: 'Edit description',
      kind: 'long',
      currentValue: 'multi\nline',
      onSave: async () => Result.ok(undefined),
    };
    const r = mount(queue, trigger, () => {
      /* no-op */
    });
    await flush();
    expect(queue.head?.kind).toBe('textarea');
    queue.rejectHead(new Error('cancelled by user'));
    await flush();
    r.unmount();
  });
});
