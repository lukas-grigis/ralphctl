/**
 * A prompt that arrives while an overlay is open sits hidden underneath it: the overlay keeps the keyboard (esc
 * closes it, `q` is not a quit), and the prompt answers only once the overlay is gone.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import { Layout } from '@src/application/ui/tui/App.tsx';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { DepsProvider } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { RouterProvider } from '@src/application/ui/tui/runtime/router.tsx';
import { UiStateProvider, useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { HintsProvider } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { SelectionProvider } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { SessionsProvider } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { StorageProvider } from '@src/application/ui/tui/runtime/storage-context.tsx';
import { SystemStatusProvider } from '@src/application/ui/tui/runtime/system-status-context.tsx';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { PromptQueueProvider } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { ENTER, ESC, tick } from '@tests/integration/application/ui/tui/_keys.ts';

const storage = (): React.ComponentProps<typeof StorageProvider>['value'] => {
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

const Page = (): React.JSX.Element => {
  const ui = useUiState();
  return <ViewShell title="Home">{ui.helpOpen ? <Text>HELP OVERLAY</Text> : <Text>PAGE</Text>}</ViewShell>;
};

const mount = (queue = createPromptQueue()): ReturnType<typeof render> => {
  const deps = { eventBus: createInMemoryEventBus() } as unknown as AppDeps;
  return render(
    <DepsProvider value={deps}>
      <PromptQueueProvider value={queue}>
        <StorageProvider value={storage()}>
          <SessionsProvider value={createSessionManager()}>
            <UiStateProvider>
              <HintsProvider>
                <SelectionProvider>
                  <SystemStatusProvider>
                    <RouterProvider initial={{ id: 'home' }}>
                      {(): React.JSX.Element => (
                        <Layout>
                          <Page />
                        </Layout>
                      )}
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

describe('prompt arriving behind an open overlay', () => {
  it('esc closes the overlay and spares the prompt, which then takes input', async () => {
    const queue = createPromptQueue();
    const resolve = vi.fn();
    const reject = vi.fn();
    const { stdin, lastFrame, unmount } = mount(queue);
    await tick();
    stdin.write('?');
    await tick();
    expect(lastFrame()).toContain('HELP OVERLAY');
    queue.enqueue({ kind: 'confirm', message: 'Proceed behind help?', resolve, reject });
    await tick();
    stdin.write(ESC);
    await tick(60);
    expect(lastFrame()).not.toContain('HELP OVERLAY');
    expect(reject).not.toHaveBeenCalled();
    expect(queue.size).toBe(1);
    stdin.write(ENTER);
    await tick();
    expect(resolve).toHaveBeenCalledOnce();
    unmount();
  });

  it('keeps keys off the hidden prompt while the overlay is open', async () => {
    const queue = createPromptQueue();
    const resolve = vi.fn();
    const { stdin, unmount } = mount(queue);
    await tick();
    stdin.write('?');
    await tick();
    queue.enqueue({ kind: 'confirm', message: 'Proceed?', resolve, reject: vi.fn() });
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(resolve).not.toHaveBeenCalled();
    unmount();
  });
});
