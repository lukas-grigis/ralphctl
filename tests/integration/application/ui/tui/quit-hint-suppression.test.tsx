/**
 * Off-Home quit-hint suppression (audit L6). The global key handler only quits on `q` when the
 * current view is Home (`use-global-keys.ts` gates it on `router.current.id === 'home'`), so the
 * always-visible footer must only advertise the `q/ctrl+c quit` hint on Home — otherwise the
 * footer lies about what `q` does on every other screen.
 *
 * `Layout` calls `useSuppressGlobalHints(['q/ctrl+c'])` off-Home; `StatusBar` filters
 * `footerGlobalHints` by the suppressed `keys` strings. We mount the real `Layout` with the real
 * `StatusBar` as its child under the production provider stack and assert the quit hint is present
 * on Home and absent everywhere else — including across a live route transition.
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import { Layout } from '@src/application/ui/tui/App.tsx';
import { StatusBar } from '@src/application/ui/tui/components/status-bar.tsx';
import { globalKeys } from '@src/application/ui/tui/runtime/keyboard-map.ts';
import type { StoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import { DepsProvider } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { RouterProvider, useRouter, type ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import { UiStateProvider } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { HintsProvider } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { SelectionProvider } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { SessionsProvider } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { StorageProvider } from '@src/application/ui/tui/runtime/storage-context.tsx';
import { SystemStatusProvider } from '@src/application/ui/tui/runtime/system-status-context.tsx';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';

/** The footer hint string for quit, derived exactly as `footerGlobalHints` joins variants. */
const QUIT_KEYS = globalKeys.quit.keys.join('/');

/** Minimal AppDeps stub — Layout's `useGlobalKeys` only reaches for `deps.eventBus`. */
const stubDeps = (): AppDeps => ({ eventBus: createInMemoryEventBus() }) as unknown as AppDeps;

/**
 * StoragePaths stub — `SystemStatusProvider` reads it, but its async doctor probe is skipped
 * under the test-env gate, so the paths are never dereferenced. `process.cwd()` is fine.
 */
const stubStorage = (): StoragePaths => {
  const r = AbsolutePath.parse(process.cwd());
  if (!r.ok) throw new Error('stubStorage: invalid cwd');
  const p = r.value;
  return {
    appRoot: p,
    dataRoot: p,
    configRoot: p,
    stateRoot: p,
    locksRoot: p,
    runsRoot: p,
    memoryRoot: p,
  };
};

/** Pushes a route once on mount so we can observe the suppression react to a live transition. */
const PushOnMount = ({ to }: { readonly to: ViewEntry }): React.JSX.Element => {
  const router = useRouter();
  const done = React.useRef(false);
  React.useEffect(() => {
    if (done.current) return;
    done.current = true;
    router.push(to);
  }, [router, to]);
  return <></>;
};

const mountAt = (initial: ViewEntry, extraChild?: React.ReactNode): ReturnType<typeof render> =>
  render(
    <DepsProvider value={stubDeps()}>
      <StorageProvider value={stubStorage()}>
        <SessionsProvider value={createSessionManager()}>
          <UiStateProvider>
            <HintsProvider>
              <SelectionProvider>
                <SystemStatusProvider>
                  <RouterProvider initial={initial}>
                    {(): React.JSX.Element => (
                      <Layout>
                        {extraChild}
                        <StatusBar />
                      </Layout>
                    )}
                  </RouterProvider>
                </SystemStatusProvider>
              </SelectionProvider>
            </HintsProvider>
          </UiStateProvider>
        </SessionsProvider>
      </StorageProvider>
    </DepsProvider>
  );

const footerLine = (frame: string): string =>
  frame
    .split('\n')
    .reverse()
    .find((l) => l.includes('quit') || l.includes(QUIT_KEYS)) ?? '';

describe('quit hint suppression off Home', () => {
  it('renders the quit hint on Home', async () => {
    const { lastFrame, unmount } = mountAt({ id: 'home' });
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain(QUIT_KEYS);
    expect(footerLine(frame)).toContain('quit');
    unmount();
  });

  it('suppresses the quit hint on a non-Home view', async () => {
    const { lastFrame, unmount } = mountAt({ id: 'settings' });
    await tick();
    const frame = lastFrame() ?? '';
    // No footer cell advertises the quit chord anywhere on the screen.
    expect(frame).not.toContain(QUIT_KEYS);
    expect(footerLine(frame)).toBe('');
    // Other footer hints (e.g. home) still render — only quit is suppressed.
    expect(frame).toContain('home');
    unmount();
  });

  it('drops the quit hint when the route transitions Home -> non-Home', async () => {
    const { lastFrame, unmount } = mountAt({ id: 'home' }, <PushOnMount to={{ id: 'settings' }} />);
    // Let the mount effect push the new route and the suppression effect flush.
    await tick(60);
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain(QUIT_KEYS);
    expect(footerLine(frame)).toBe('');
    unmount();
  });
});
