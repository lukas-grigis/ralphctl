import { describe, expect, it } from 'vitest';
import { createInkInteractivePrompt } from '@src/application/ui/tui/prompts/ink-interactive-prompt.ts';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { runWithSession } from '@src/application/session/session.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { AppEvent } from '@src/business/observability/events.ts';
import type { Element } from '@src/application/chain/element.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { Result } from '@src/domain/result.ts';
import { ErrorCode } from '@src/domain/value/error/error-code.ts';

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

  it('stays silent for a prompt asked outside any run', () => {
    const queue = createPromptQueue();
    const bus = createInMemoryEventBus();
    const events: AppEvent[] = [];
    bus.subscribe((e) => events.push(e));
    void createInkInteractivePrompt(queue, bus).askText('Repo?');
    expect(events).toEqual([]);
    queue.drain(new Error('done'));
  });

  it("withdraws a run's prompt with an AbortError when that run is aborted, so the run can unwind", async () => {
    const queue = createPromptQueue();
    const prompt = createInkInteractivePrompt(queue);
    const answers: Array<Result<string, unknown>> = [];
    const element: Element<object> = {
      name: 'asks',
      execute: async (ctx) => {
        const answer = await prompt.askText('Sprint name:');
        answers.push(answer);
        return answer.ok ? Result.ok({ ctx, trace: [] }) : Result.error({ error: answer.error, trace: [] });
      },
    };
    const runner = createRunner({ id: 'r-ask', element, initialCtx: {} });
    const done = runner.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(queue.head?.sessionId).toBe('r-ask');

    runner.abort('quit');
    await done;

    expect(queue.size).toBe(0);
    expect(runner.status).toBe('aborted');
    expect(answers[0]?.ok === false && (answers[0].error as { code?: string }).code).toBe(ErrorCode.Aborted);
  });
});
