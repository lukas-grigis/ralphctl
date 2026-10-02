/**
 * Quit with live runs asks first (`[y/N]`, default No); Yes aborts the runs through the process API before exiting,
 * No keeps everything running. With no live run, quitting stays immediate.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Runner } from '@src/application/chain/run/runner.ts';
import { ConfirmCard } from '@src/application/ui/tui/components/confirm-card.tsx';
import { Layout } from '@src/application/ui/tui/App.tsx';
import type { StoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import { DepsProvider } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { RouterProvider } from '@src/application/ui/tui/runtime/router.tsx';
import { UiStateProvider } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { HintsProvider } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { SelectionProvider } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { SessionsProvider } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { StorageProvider } from '@src/application/ui/tui/runtime/storage-context.tsx';
import { SystemStatusProvider } from '@src/application/ui/tui/runtime/system-status-context.tsx';
import { createSessionManager, type SessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { useViewKeys } from '@src/application/ui/tui/runtime/use-view-keys.ts';
import { PromptQueueProvider } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import { createPromptQueue, type PromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { forcedStopNote } from '@src/application/ui/tui/components/quit-confirm-overlay.tsx';
import type { AbortAllOutcome } from '@src/application/session/in-process-runs.ts';

const CTRL_C = '\u0003';
const PROMPT = 'quit stops them? [y/N]';

const storage = (): StoragePaths => {
  const r = AbsolutePath.parse(process.cwd());
  if (!r.ok) throw new Error('invalid cwd');
  const p = r.value;
  return {
    appRoot: p,
    dataRoot: p,
    configRoot: p,
    stateRoot: p,
    locksRoot: p,
    runsRoot: p,
    memoryRoot: p,
    operatorSkillsRoot: p,
    operatorAgentDefinitionsRoot: p,
  };
};

const runningManager = (count: number): SessionManager => {
  const manager = createSessionManager();
  for (let i = 0; i < count; i++) {
    manager.register({
      runner: {
        id: `r-${String(i)}`,
        status: 'running',
        trace: [],
        subscribe: () => () => undefined,
        start: vi.fn(),
        abort: vi.fn(),
      } as unknown as Runner<unknown>,
      flowId: 'implement',
      title: `Implement ${String(i)}`,
    });
  }
  return manager;
};

const STOPPED: AbortAllOutcome = { runs: 1, forced: false, stuckFlows: [], killed: 0 };

const mount = (
  sessions: SessionManager,
  abortAll: () => Promise<AbortAllOutcome>,
  body: React.ReactNode = <Text>body</Text>,
  queue: PromptQueue = createPromptQueue()
): ReturnType<typeof render> => {
  const deps = { eventBus: createInMemoryEventBus(), inProcessRuns: { abortAll } } as unknown as AppDeps;
  return render(
    <DepsProvider value={deps}>
      <PromptQueueProvider value={queue}>
        <StorageProvider value={storage()}>
          <SessionsProvider value={sessions}>
            <UiStateProvider>
              <HintsProvider>
                <SelectionProvider>
                  <SystemStatusProvider>
                    <RouterProvider initial={{ id: 'home' }}>
                      {(): React.JSX.Element => <Layout>{body}</Layout>}
                    </RouterProvider>
                  </SystemStatusProvider>
                </SelectionProvider>
              </HintsProvider>
            </UiStateProvider>
          </SessionsProvider>
        </StorageProvider>
      </PromptQueueProvider>
    </DepsProvider>
  );
};

describe('quit with live runs', () => {
  it('asks "N run(s) live — quit stops them? [y/N]" instead of quitting', async () => {
    const abortAll = vi.fn(() => Promise.resolve(STOPPED));
    const { stdin, lastFrame, unmount } = mount(runningManager(2), abortAll);
    await tick();
    stdin.write('q');
    await tick();
    expect(lastFrame()).toContain(`2 runs live — ${PROMPT}`);
    expect(abortAll).not.toHaveBeenCalled();
    unmount();
  });

  it('defaults to No: n, esc, enter and ctrl+c all keep the runs going', async () => {
    for (const key of ['n', '\u001b', '\r', CTRL_C]) {
      const abortAll = vi.fn(() => Promise.resolve(STOPPED));
      const { stdin, lastFrame, unmount } = mount(runningManager(1), abortAll);
      await tick();
      stdin.write('q');
      await tick();
      expect(lastFrame()).toContain(`1 run live — ${PROMPT}`);
      stdin.write(key);
      await tick(60);
      expect(lastFrame()).not.toContain(PROMPT);
      expect(abortAll).not.toHaveBeenCalled();
      unmount();
    }
  });

  it('y aborts every run through abortAll, then exits', async () => {
    let settle: () => void = () => undefined;
    const abortAll = vi.fn(() => new Promise<AbortAllOutcome>((resolve) => (settle = () => resolve(STOPPED))));
    const { stdin, lastFrame, unmount } = mount(runningManager(1), abortAll);
    await tick();
    stdin.write(CTRL_C);
    await tick();
    expect(lastFrame()).toContain(PROMPT);
    stdin.write('y');
    await tick();
    expect(abortAll).toHaveBeenCalledWith('quit');
    expect(lastFrame()).toContain('Stopping 1 run');
    settle();
    await tick();
    unmount();
  });

  it('ignores `q` while another overlay is open, ctrl+c still asks', async () => {
    const abortAll = vi.fn(() => Promise.resolve(STOPPED));
    const { stdin, lastFrame, unmount } = mount(runningManager(1), abortAll);
    await tick();
    stdin.write('?');
    await tick();
    stdin.write('q');
    await tick();
    expect(lastFrame() ?? '').not.toContain(PROMPT);
    stdin.write(CTRL_C);
    await tick();
    expect(lastFrame()).toContain(PROMPT);
    unmount();
  });

  it('quits at once when nothing is running', async () => {
    const abortAll = vi.fn(() => Promise.resolve(STOPPED));
    const { stdin, lastFrame, unmount } = mount(createSessionManager(), abortAll);
    await tick();
    stdin.write('q');
    await tick();
    expect(lastFrame() ?? '').not.toContain(PROMPT);
    expect(abortAll).not.toHaveBeenCalled();
    unmount();
  });

  it('keeps its y away from a confirm that is open underneath', async () => {
    const abortAll = vi.fn(() => Promise.resolve(STOPPED));
    const onSubmit = vi.fn();
    const body = (
      <ConfirmCard title={<Text>Remove sprint?</Text>} message="Remove?" onSubmit={onSubmit} onCancel={vi.fn()} />
    );
    const { stdin, lastFrame, unmount } = mount(runningManager(1), abortAll, body);
    await tick();
    stdin.write('y');
    await tick();
    expect(onSubmit).toHaveBeenCalledOnce();
    onSubmit.mockClear();
    stdin.write(CTRL_C);
    await tick();
    expect(lastFrame()).toContain(PROMPT);
    stdin.write('y');
    await tick();
    expect(abortAll).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  it('ctrl+c opens only the quit confirm, never a view binding on `c`', async () => {
    const onCancel = vi.fn();
    const RunView = (): React.JSX.Element => {
      useViewKeys([{ keys: ['c'], hint: 'cancel', run: onCancel }]);
      return <Text>run view</Text>;
    };
    const abortAll = vi.fn(() => Promise.resolve(STOPPED));
    const { stdin, lastFrame, unmount } = mount(runningManager(1), abortAll, <RunView />);
    await tick();
    stdin.write(CTRL_C);
    await tick();
    expect(lastFrame()).toContain(PROMPT);
    stdin.write('\r');
    await tick(60);
    expect(lastFrame()).toContain('run view');
    expect(onCancel).not.toHaveBeenCalled();
    unmount();
  });

  it('y also withdraws a prompt that belongs to no run, so nothing holds the quit open', async () => {
    const queue = createPromptQueue();
    const rejected = vi.fn();
    queue.enqueue({ kind: 'text', message: 'Sprint name:', resolve: vi.fn(), reject: rejected });
    const abortAll = vi.fn(() => Promise.resolve(STOPPED));
    const { stdin, unmount } = mount(runningManager(1), abortAll, <Text>body</Text>, queue);
    await tick();
    stdin.write(CTRL_C);
    await tick();
    stdin.write('y');
    await tick();
    expect(abortAll).toHaveBeenCalledWith('quit');
    expect(rejected).toHaveBeenCalledOnce();
    expect(queue.size).toBe(0);
    unmount();
  });
});

describe('forcedStopNote', () => {
  it('stays silent when every run stopped in time', () => {
    expect(forcedStopNote(STOPPED)).toBeUndefined();
  });

  it('tells the operator what a forced stop killed', () => {
    const note = forcedStopNote({ runs: 2, forced: true, stuckFlows: ['implement'], killed: 2 });
    expect(note?.exitNote).toBe(
      'ralphctl: implement did not stop within 5s — force-killed 2 AI CLI process groups. The next launch offers to resume interrupted tasks.'
    );
  });
});
