/**
 * The real port → queue → PromptHost path for `askText({ validate })` and `askConfirm({ defaultValue })`:
 * an invalid name keeps the user at the prompt with an inline error, and a `[y/N]` confirm submits No on ↵.
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { createInkInteractivePrompt } from '@src/application/ui/tui/prompts/ink-interactive-prompt.ts';
import { PromptHost } from '@src/application/ui/tui/prompts/prompt-host.tsx';
import { UiStateProvider } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { sprintNameProblem } from '@src/business/sprint/create-sprint.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';

const Host = ({ queue }: { readonly queue: ReturnType<typeof createPromptQueue> }): React.JSX.Element => (
  <UiStateProvider>
    <PromptHost queue={queue} />
  </UiStateProvider>
);

describe('askText validate through the real queue → PromptHost path', () => {
  it('blocks an empty submit with an inline error, then accepts a valid name', async () => {
    const queue = createPromptQueue();
    const interactive = createInkInteractivePrompt(queue);
    const { stdin, lastFrame, unmount } = render(<Host queue={queue} />);

    let settled = false;
    const answer = interactive.askText('Sprint name:', { validate: sprintNameProblem }).then((r) => {
      settled = true;
      return r;
    });
    await waitForPredicate(() => (lastFrame() ?? '').includes('Sprint name:'));
    await tick(50);

    stdin.write('\r');
    await tick();
    expect(settled).toBe(false);
    expect(lastFrame() ?? '').toContain('Sprint name is required');

    stdin.write('Kickoff');
    await tick();
    stdin.write('\r');
    const result = await answer;
    expect(result.ok && result.value).toBe('Kickoff');
    unmount();
  });
});

describe('askConfirm defaultValue through the real queue → PromptHost path', () => {
  it('↵ submits No when the confirm defaults to No', async () => {
    const queue = createPromptQueue();
    const interactive = createInkInteractivePrompt(queue);
    const { stdin, lastFrame, unmount } = render(<Host queue={queue} />);

    const answer = interactive.askConfirm({ message: 'Distill? [y/N]', defaultValue: false });
    await waitForPredicate(() => (lastFrame() ?? '').includes('Distill?'));
    await tick(50);
    expect(lastFrame() ?? '').toContain('[ No ]');

    stdin.write('\r');
    const result = await answer;
    expect(result.ok && result.value).toBe(false);
    unmount();
  });

  it('a second confirm right after a No-default one opens on its own default (Yes)', async () => {
    const queue = createPromptQueue();
    const interactive = createInkInteractivePrompt(queue);
    const { stdin, lastFrame, unmount } = render(<Host queue={queue} />);

    const first = interactive.askConfirm({ message: 'First? [y/N]', defaultValue: false });
    const second = interactive.askConfirm({ message: 'Second?' });
    await waitForPredicate(() => (lastFrame() ?? '').includes('First?'));
    await tick(50);
    stdin.write('\r');
    expect((await first).ok).toBe(true);

    await waitForPredicate(() => (lastFrame() ?? '').includes('Second?'));
    await tick(50);
    expect(lastFrame() ?? '').toContain('[ Yes ]');
    stdin.write('\r');
    const result = await second;
    expect(result.ok && result.value).toBe(true);
    unmount();
  });
});
