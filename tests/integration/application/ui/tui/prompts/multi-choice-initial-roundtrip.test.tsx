/**
 * The REAL production path for a pre-seeded multi-choice checklist:
 *
 *   createInkInteractivePrompt(queue).askMultiChoice(msg, options, { initial })
 *     → PromptQueue entry `initial`
 *     → <PromptHost> conditional spread (prompt-host.tsx)
 *     → <MultiSelectPrompt initialSelectedValues>
 *
 * Every other test either renders MultiSelectPrompt directly with props or scripts the
 * InteractivePrompt port, so the one spread in PromptHost carried no coverage — yet a regression
 * there opens every customize-picker checklist EMPTY, and submitting an empty checklist emits
 * `disabled = everything`, silently disabling all skills for the run. These cases fence the
 * queue→host threading and the submit round-trip.
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { createInkInteractivePrompt } from '@src/application/ui/tui/prompts/ink-interactive-prompt.ts';
import { PromptHost } from '@src/application/ui/tui/prompts/prompt-host.tsx';
import { UiStateProvider } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import type { Choice } from '@src/business/interactive/prompt.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';

const Host = ({ queue }: { readonly queue: ReturnType<typeof createPromptQueue> }): React.JSX.Element => (
  <UiStateProvider>
    <PromptHost queue={queue} />
  </UiStateProvider>
);

const OPTIONS: ReadonlyArray<Choice<string>> = [
  { label: 'Alpha', value: 'a' },
  { label: 'Bravo', value: 'b' },
  { label: 'Charlie', value: 'c' },
  { label: 'Delta (protected)', value: 'd', disabled: true, description: 'cannot toggle' },
];

describe('askMultiChoice initial seeding through the real queue → PromptHost path', () => {
  it('opens pre-checked to `initial` and ENTER round-trips exactly those values', async () => {
    const queue = createPromptQueue();
    const interactive = createInkInteractivePrompt(queue);
    const { stdin, lastFrame, unmount } = render(<Host queue={queue} />);

    const answer = interactive.askMultiChoice<string>('Skills for this run:', OPTIONS, { initial: ['a', 'c'] });
    await waitForPredicate(() => (lastFrame() ?? '').includes('Alpha'));
    await tick(50); // give useInput's subscription time to attach before the first keypress

    const frame = lastFrame() ?? '';
    // Alpha + Charlie pre-checked, Bravo not — the exact `initial` seeding, not empty, not all.
    expect(frame).toMatch(/\[.]\s*Alpha/);
    expect(frame).toMatch(/\[ ]\s*Bravo/);
    expect(frame).toMatch(/\[.]\s*Charlie/);

    stdin.write('\r');
    await tick();
    const result = await answer;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value].sort()).toEqual(['a', 'c']);
    unmount();
  });

  it('space on a disabled row is a no-op and select-all excludes disabled rows', async () => {
    const queue = createPromptQueue();
    const interactive = createInkInteractivePrompt(queue);
    const { stdin, lastFrame, unmount } = render(<Host queue={queue} />);

    const answer = interactive.askMultiChoice<string>('Pick:', OPTIONS, { initial: [] });
    await waitForPredicate(() => (lastFrame() ?? '').includes('Alpha'));
    await tick(50); // give useInput's subscription time to attach before the first keypress

    // select-all must not pull in the disabled Delta row.
    stdin.write('a');
    await tick();
    stdin.write('\r');
    await tick();
    const result = await answer;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value].sort()).toEqual(['a', 'b', 'c']);
    unmount();
  });

  it('omitted initial opens with nothing checked (backward compatibility)', async () => {
    const queue = createPromptQueue();
    const interactive = createInkInteractivePrompt(queue);
    const { stdin, lastFrame, unmount } = render(<Host queue={queue} />);

    const answer = interactive.askMultiChoice<string>('Pick:', OPTIONS);
    await waitForPredicate(() => (lastFrame() ?? '').includes('Alpha'));
    await tick(50); // give useInput's subscription time to attach before the first keypress
    expect(lastFrame() ?? '').toMatch(/\[ ]\s*Alpha/);

    stdin.write('\r');
    await tick();
    const result = await answer;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
    unmount();
  });
});
