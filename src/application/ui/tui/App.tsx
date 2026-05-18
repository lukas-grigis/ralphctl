/**
 * Top-level Ink component for the TUI. Composes every provider (deps, sinks, sessions, prompts,
 * UI state, hints, selection, router), then renders the current view from the registry. The
 * persistent prompt host lives inside ViewShell so the Question card sits above the footer
 * instead of being pushed off the bottom of the screen.
 *
 * Bootstrap is performed before this component mounts; props arrive fully wired.
 */

import React from 'react';
import { Box } from 'ink';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { StoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import type { TuiBuses } from '@src/application/ui/tui/runtime/sinks-context.tsx';
import type { SessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { PromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import type { ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import type { LogLevelGate } from '@src/business/observability/log-level-filter.ts';
import { DepsProvider } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { StorageProvider } from '@src/application/ui/tui/runtime/storage-context.tsx';
import { BusesProvider } from '@src/application/ui/tui/runtime/sinks-context.tsx';
import { SessionsProvider } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { PromptQueueProvider } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import { UiStateProvider } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { HintsProvider } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { SelectionProvider, type SelectionSeed } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { RouterProvider } from '@src/application/ui/tui/runtime/router.tsx';
import { SystemStatusProvider } from '@src/application/ui/tui/runtime/system-status-context.tsx';
import { LogLevelProvider } from '@src/application/ui/tui/runtime/log-level-context.tsx';
import { renderView } from '@src/application/ui/tui/views/view-registry.tsx';
import { useGlobalKeys } from '@src/application/ui/tui/runtime/use-global-keys.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';

export interface AppProps {
  readonly deps: AppDeps;
  readonly storage: StoragePaths;
  readonly buses: TuiBuses;
  readonly sessions: SessionManager;
  readonly queue: PromptQueue;
  /**
   * Mutable holder for the active log-level floor. The TUI's `EventBus -> logBus` forwarder
   * reads it on every event; the Settings view writes to it when the user changes log level.
   */
  readonly logLevelGate: LogLevelGate;
  /**
   * Initial view to mount. Production launches with `{ id: 'welcome' }` on first run (no
   * settings file yet) and `{ id: 'home' }` otherwise; tests can pass anything.
   */
  readonly initialView: ViewEntry;
  /**
   * Pre-seeded selection — launch passes the singleton project's id/label when storage
   * contains exactly one so the user lands on a productive home view instead of an empty one.
   */
  readonly initialSelection?: SelectionSeed;
  /**
   * Called whenever the user's project/sprint selection changes. Production threads this to
   * the last-selection-store so the next launch pre-selects the same project.
   */
  readonly onSelectionChange?: (next: SelectionSeed) => void;
}

export const App = ({
  deps,
  storage,
  buses,
  sessions,
  queue,
  logLevelGate,
  initialView,
  initialSelection,
  onSelectionChange,
}: AppProps): React.JSX.Element => (
  <DepsProvider value={deps}>
    <StorageProvider value={storage}>
      <BusesProvider value={buses}>
        <SessionsProvider value={sessions}>
          <PromptQueueProvider value={queue}>
            <UiStateProvider>
              <HintsProvider>
                <SelectionProvider
                  {...(initialSelection !== undefined ? { seed: initialSelection } : {})}
                  {...(onSelectionChange !== undefined ? { onChange: onSelectionChange } : {})}
                >
                  <LogLevelProvider gate={logLevelGate}>
                    <SystemStatusProvider>
                      <RouterProvider initial={initialView}>
                        {(current) => <Layout>{renderView(current)}</Layout>}
                      </RouterProvider>
                    </SystemStatusProvider>
                  </LogLevelProvider>
                </SelectionProvider>
              </HintsProvider>
            </UiStateProvider>
          </PromptQueueProvider>
        </SessionsProvider>
      </BusesProvider>
    </StorageProvider>
  </DepsProvider>
);

/**
 * Hosts the global key handler and pins the active view inside a fixed-height frame. The outer
 * Box is sized to the full terminal height so the alternate-screen frame fills the window
 * instead of stacking against the previous shell output; ViewShell owns the column inside it
 * — header, scroll content, prompt host, and footer — so tall content scrolls within this
 * frame instead of pushing the status bar (or the prompt card) off-screen.
 */
const Layout = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => {
  const ui = useUiState();
  const { rows } = useTerminalSize();
  // Suspend global key bindings while a prompt is in flight so view-level handlers don't fight
  // for input. The prompt's own component owns Esc / Enter / etc. while it's mounted.
  useGlobalKeys({ disabled: ui.promptActive });
  // ViewShell owns the full column inside this fixed-height frame: header → scroll content →
  // prompt-host → footer, with header / prompt / footer pinned via `flexShrink={0}`.
  return (
    <Box flexDirection="column" height={rows}>
      {children}
    </Box>
  );
};
