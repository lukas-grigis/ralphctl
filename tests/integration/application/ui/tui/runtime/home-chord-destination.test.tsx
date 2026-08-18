/**
 * `h` (global Home chord) and `D` (Execute-view detach) must land on the HOME view — never on
 * whatever entry the process happened to boot with.
 *
 * The regression: `RouterProvider.reset()` used to fall back to its frozen `initial` prop when
 * called with no argument, and both chords called it bare. On a first-run session `initial` is
 * `{ id: 'welcome' }` (and `{ id: 'create-project' }` when settings exist but no project), so
 * pressing `h` re-mounted the first-run wizard instead of going Home — and a fresh WelcomeView
 * instance re-ran its PATH probe + apply-preset seed over whatever the user had just configured
 * in Settings.
 */

import React, { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import { DepsProvider } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { SessionsProvider } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { SelectionProvider } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { UiStateProvider } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { HintsProvider } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { RouterProvider, useRouter, type ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import { useGlobalKeys } from '@src/application/ui/tui/runtime/use-global-keys.ts';
import { useExecuteInput } from '@src/application/ui/tui/views/execute-view-internals/use-execute-input.ts';
import type { SessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';

const stubDeps = (): AppDeps => ({ eventBus: createInMemoryEventBus() }) as unknown as AppDeps;

const emptyManager = (): SessionManager =>
  ({
    list: () => [],
    get: () => undefined,
    subscribe: () => () => undefined,
  }) as unknown as SessionManager;

const RouteProbe = ({ onRoute }: { readonly onRoute: (e: ViewEntry) => void }): React.JSX.Element => {
  const router = useRouter();
  useEffect(() => {
    onRoute(router.current);
  });
  return <></>;
};

const GlobalKeysProbe = (): React.JSX.Element => {
  useGlobalKeys();
  return <></>;
};

/** Mounts the Execute view's own key handler in its RUNNING state, where `D` = detach. */
const ExecuteInputProbe = (): React.JSX.Element => {
  const router = useRouter();
  useExecuteInput({
    isRunning: true,
    cancelScopeOpen: false,
    setCancelScopeOpen: () => undefined,
    modalOpen: false,
    router,
    hasPinnedSprint: false,
    hasEvaluation: false,
  });
  return <></>;
};

const Harness = ({
  initial,
  onRoute,
  probe,
}: {
  readonly initial: ViewEntry;
  readonly onRoute: (e: ViewEntry) => void;
  readonly probe: React.ReactNode;
}): React.JSX.Element => (
  <DepsProvider value={stubDeps()}>
    <SessionsProvider value={emptyManager()}>
      <SelectionProvider>
        <UiStateProvider>
          <HintsProvider>
            <RouterProvider initial={initial}>
              {(): React.JSX.Element => (
                <>
                  {probe}
                  <RouteProbe onRoute={onRoute} />
                </>
              )}
            </RouterProvider>
          </HintsProvider>
        </UiStateProvider>
      </SelectionProvider>
    </SessionsProvider>
  </DepsProvider>
);

describe('Home destination chords', () => {
  it('`h` lands on home from a first-run session whose launch entry was welcome', async () => {
    let current: ViewEntry = { id: 'welcome' };
    const { stdin, unmount } = render(
      <Harness initial={current} onRoute={(e) => (current = e)} probe={<GlobalKeysProbe />} />
    );
    await tick(50);
    stdin.write('h');
    await tick();

    expect(current.id).toBe('home');
    unmount();
  });

  it('`h` lands on home when the launch entry was the create-project wizard', async () => {
    let current: ViewEntry = { id: 'create-project' };
    const { stdin, unmount } = render(
      <Harness initial={current} onRoute={(e) => (current = e)} probe={<GlobalKeysProbe />} />
    );
    await tick(50);
    stdin.write('h');
    await tick();

    expect(current.id).toBe('home');
    unmount();
  });

  it('`D` (detach) lands on home rather than re-mounting the first-run launch entry', async () => {
    let current: ViewEntry = { id: 'welcome' };
    const { stdin, unmount } = render(
      <Harness initial={current} onRoute={(e) => (current = e)} probe={<ExecuteInputProbe />} />
    );
    await tick(50);
    stdin.write('D');
    await tick();

    expect(current.id).toBe('home');
    unmount();
  });
});
