import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { awaitingSessions, useAwaitingSessions } from '@src/application/ui/tui/runtime/use-awaiting-sessions.ts';
import { createPromptQueue, type PromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { PromptQueueProvider } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';

const ask = (queue: PromptQueue, sessionId?: string): void => {
  queue.enqueue({
    kind: 'confirm',
    message: 'ok?',
    ...(sessionId !== undefined ? { sessionId } : {}),
    resolve: () => undefined,
    reject: () => undefined,
  });
};

const Probe = (): React.JSX.Element => <Text>{`waiting:${[...useAwaitingSessions().keys()].sort().join(',')}`}</Text>;

describe('awaitingSessions', () => {
  it('collects the session ids of queued prompts and ignores view-local asks', () => {
    const queue = createPromptQueue();
    ask(queue, 'a');
    ask(queue, 'a');
    ask(queue, 'b');
    ask(queue);
    expect([...awaitingSessions(queue).keys()]).toEqual(['a', 'b']);
  });

  it('is empty for an empty queue', () => {
    expect(awaitingSessions(createPromptQueue()).size).toBe(0);
  });
});

describe('useAwaitingSessions', () => {
  it('follows the queue as prompts arrive and are answered', async () => {
    const queue = createPromptQueue();
    const r = render(
      <PromptQueueProvider value={queue}>
        <Probe />
      </PromptQueueProvider>
    );
    expect(r.lastFrame()).toContain('waiting:');
    ask(queue, 's1');
    await tick();
    expect(r.lastFrame()).toContain('waiting:s1');
    queue.resolveHead(true);
    await tick();
    expect(r.lastFrame()).not.toContain('s1');
    r.unmount();
  });

  it('is empty outside a prompt provider', () => {
    const r = render(<Probe />);
    expect(r.lastFrame()).toContain('waiting:');
    r.unmount();
  });
});
