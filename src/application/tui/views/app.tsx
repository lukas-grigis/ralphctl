/**
 * Root Ink component.
 *
 * Translates the `initialView` flag into a navigation stack seed and hands
 * off to `<ViewRouter />`. Wraps the viewport in a responsive centered column
 * capped at MAX_CONTENT_WIDTH so wide terminals get gutters.
 *
 * On mount runs a first-run check (no projects + no current sprint + no AI
 * provider → TODO: seed the onboarding view). The probe is async and
 * non-blocking: we render a placeholder for one tick and swap in the real
 * stack when the probe settles.
 *
 */

import React, { useEffect, useState } from 'react';
import { Box, useInput, useStdout } from 'ink';
import { ViewRouter } from './view-router.tsx';
import type { ViewEntry, ViewId } from './router-context.ts';
import type { SessionManagerPort } from '@src/application/runtime/session-manager-port.ts';
import type { SignalBusPort } from '@src/business/ports/signal-bus-port.ts';
import { isInteractiveActive, subscribeInteractive } from '@src/application/runtime/interactive-terminal.ts';
import { requestShutdown } from '@src/application/runtime/shutdown.ts';

export interface AppProps {
  readonly initialView?: ViewId;
  readonly sessionManager: SessionManagerPort;
  readonly sessionId?: string;
  /**
   * Optional signal bus — when wired, the ExecuteView subscribes for
   * live rate-limit pause/resume and task lifecycle events.
   */
  readonly signalBus?: SignalBusPort | null;
  /**
   * Override the navigation stack the router seeds with. Used by the
   * mount path on first launch to route directly to project-add (above
   * a home root frame so Esc / `h` still go to home).
   */
  readonly initialStack?: readonly ViewEntry[];
}

const MAX_CONTENT_WIDTH = 160;

function buildInitialStack(initialView: ViewId | undefined, sessionId: string | undefined): readonly ViewEntry[] {
  if (initialView === 'execute' && sessionId !== undefined) {
    return [{ id: 'execute', props: { sessionId } }];
  }
  if (initialView !== undefined) {
    return [{ id: initialView }];
  }
  return [{ id: 'home' }];
}

function useTerminalWidth(): number {
  const { stdout } = useStdout();
  const [width, setWidth] = useState(stdout.columns);
  useEffect(() => {
    const onResize = (): void => {
      setWidth(stdout.columns);
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return width;
}

export function App({
  initialView,
  sessionManager,
  sessionId,
  signalBus = null,
  initialStack,
}: AppProps): React.JSX.Element | null {
  const terminalWidth = useTerminalWidth();
  const contentWidth = Math.min(terminalWidth, MAX_CONTENT_WIDTH);
  const [stack] = useState<readonly ViewEntry[]>(() => initialStack ?? buildInitialStack(initialView, sessionId));

  // While an interactive child process owns the terminal (e.g. an AI
  // session running in interactive mode for refine/plan), the App
  // returns `null` so Ink's reconciler emits no visible output. The
  // child gets a clean main screen via exitAltScreen(); when it
  // returns, the alt-screen is re-entered and we drop back to false,
  // re-rendering the full UI in the freshly cleared buffer.
  const [interactive, setInteractive] = useState(isInteractiveActive);
  useEffect(() => subscribeInteractive(setInteractive), []);
  if (interactive) return null;

  return (
    <Box width={terminalWidth} justifyContent="center">
      <Box flexDirection="column" width={contentWidth}>
        <GlobalCancelHandler />
        <ViewRouter initialStack={stack} sessionManager={sessionManager} signalBus={signalBus} />
      </Box>
    </Box>
  );
}

/**
 * Always-active Ctrl+C handler. Ink puts stdin in raw mode, which
 * delivers Ctrl+C as a `\x03` keypress instead of as a SIGINT signal —
 * `process.on('SIGINT', ...)` never fires while the TUI is mounted.
 * This component bridges the keypress to the shutdown coordinator so
 * Ctrl+C runs the same two-press cleanup as a real SIGINT would in a
 * non-TTY environment.
 *
 * Lives at the App layer rather than per-view so it stays active across
 * navigation, pushes, and modal overlays. Returns `null` — has no
 * visible output, just the input subscription.
 */
function GlobalCancelHandler(): null {
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      requestShutdown('SIGINT');
    }
  });
  return null;
}
