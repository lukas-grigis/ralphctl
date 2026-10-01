import { describe, expect, it } from 'vitest';
import { createInkInteractivePrompt } from '@src/application/ui/tui/prompts/ink-interactive-prompt.ts';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { runWithSession } from '@src/application/session/session.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { AppEvent } from '@src/business/observability/events.ts';

describe('createInkInteractivePrompt', () => {
  it('stamps the asking session onto the queued prompt', () => {
    const queue = createPromptQueue();
    const prompt = createInkInteractivePrompt(queue);
    void runWithSession('s1', () => prompt.askConfirm({ message: 'go?' }));
    expect(queue.head?.sessionId).toBe('s1');
    queue.drain(new Error('done'));
  });

  it('leaves sessionId off a prompt asked outside any run', () => {
    const queue = createPromptQueue();
    void createInkInteractivePrompt(queue).askText('name?');
    expect(queue.head?.sessionId).toBeUndefined();
    queue.drain(new Error('done'));
  });

  it("publishes 'awaiting-input' with the message and session", () => {
    const queue = createPromptQueue();
    const bus = createInMemoryEventBus();
    const events: AppEvent[] = [];
    bus.subscribe((e) => events.push(e));
    void runWithSession('s2', () => createInkInteractivePrompt(queue, bus).askText('Branch?'));
    expect(events).toMatchObject([{ type: 'awaiting-input', message: 'Branch?', sessionId: 's2' }]);
    queue.drain(new Error('done'));
  });
});
