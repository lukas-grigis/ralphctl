/**
 * Whole-frame test fixture: the production provider stack plus the real `Layout` chrome (tab bar,
 * location line, rule, footer, overlays), rendered at a chosen terminal size through `renderAtSize`.
 * Views are stubbed — a stub is a `ViewShell` that prints `view:<id>` — except where a test supplies
 * its own, so these tests prove navigation, chrome and key ownership without booting every view's
 * dependencies. `system` mounts the real hub unless `renderRoute` says otherwise.
 */

import React from 'react';
import { Text } from 'ink';
import { renderAtSize, type RenderAtSizeResult } from '@tests/helpers/render-at-size.tsx';
import { Layout } from '@src/application/ui/tui/App.tsx';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { SystemView } from '@src/application/ui/tui/views/system-view.tsx';
import { ROUTE_LABELS } from '@src/application/ui/tui/runtime/nav-tree.ts';
import { DepsProvider } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { StorageProvider } from '@src/application/ui/tui/runtime/storage-context.tsx';
import { SessionsProvider } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { PromptQueueProvider } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import { UiStateProvider } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { HintsProvider } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { ClaimedKeysProvider } from '@src/application/ui/tui/runtime/claimed-keys-context.tsx';
import { SelectionProvider, type SelectionSeed } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { SystemStatusProvider } from '@src/application/ui/tui/runtime/system-status-context.tsx';
import { RouterProvider, useRouter, type RouterApi, type ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import { createSessionManager, type SessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { StoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/** A view that is just its title and a marker line. */
export const StubView = ({ id }: { readonly id: ViewEntry['id'] }): React.JSX.Element => (
  <ViewShell title={ROUTE_LABELS[id]}>
    <Text>{`view:${id}`}</Text>
  </ViewShell>
);

const storagePaths = (): StoragePaths => {
  const r = AbsolutePath.parse(process.cwd());
  if (!r.ok) throw new Error('bad cwd');
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

export interface AppFrameOptions {
  readonly columns: number;
  readonly rows: number;
  readonly deps: AppDeps;
  readonly initial?: ViewEntry;
  readonly selection?: SelectionSeed;
  readonly sessions?: SessionManager;
  /** Replace the default stub / system mapping. */
  readonly renderRoute?: (entry: ViewEntry) => React.ReactNode;
  /** Mounted inside the providers, next to the layout — for probes. */
  readonly probe?: React.ReactNode;
}

const RouterTap = ({ onRouter }: { readonly onRouter: (r: RouterApi) => void }): null => {
  onRouter(useRouter());
  return null;
};

export interface AppFrame {
  readonly result: RenderAtSizeResult;
  /** The latest router API (stack, activeSection, …). */
  readonly router: () => RouterApi;
  /** Frame rows, trailing blank rows kept (the frame is exactly `rows` tall). */
  readonly lines: () => string[];
}

export const mountFrame = (opts: AppFrameOptions): AppFrame => {
  let latest: RouterApi | undefined;
  const route =
    opts.renderRoute ??
    ((entry: ViewEntry): React.ReactNode => (entry.id === 'system' ? <SystemView /> : <StubView id={entry.id} />));
  const result = renderAtSize(
    <DepsProvider value={opts.deps}>
      <StorageProvider value={storagePaths()}>
        <SessionsProvider value={opts.sessions ?? createSessionManager()}>
          <PromptQueueProvider value={createPromptQueue()}>
            <UiStateProvider>
              <HintsProvider>
                <ClaimedKeysProvider>
                  <SelectionProvider {...(opts.selection !== undefined ? { seed: opts.selection } : {})}>
                    <SystemStatusProvider>
                      <RouterProvider initial={opts.initial ?? { id: 'home' }}>
                        {(current): React.ReactNode => (
                          <>
                            <RouterTap onRouter={(r) => (latest = r)} />
                            {opts.probe}
                            <Layout>{route(current)}</Layout>
                          </>
                        )}
                      </RouterProvider>
                    </SystemStatusProvider>
                  </SelectionProvider>
                </ClaimedKeysProvider>
              </HintsProvider>
            </UiStateProvider>
          </PromptQueueProvider>
        </SessionsProvider>
      </StorageProvider>
    </DepsProvider>,
    { columns: opts.columns, rows: opts.rows }
  );
  return {
    result,
    router: () => {
      if (latest === undefined) throw new Error('router not mounted');
      return latest;
    },
    lines: () => (result.lastFrame() ?? '').split('\n'),
  };
};
