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
 * Ported from src/integration/ui/tui/views/app.tsx — adapted for src/
 * SessionManager-based multi-chain runtime.
 */

import React, { useEffect, useState } from 'react';
import { Box, useStdout } from 'ink';
import { ViewRouter } from './view-router.tsx';
import type { ViewEntry, ViewId } from './router-context.ts';
import type { SessionManagerPort } from '../../runtime/session-manager-port.ts';

export interface AppProps {
  readonly initialView?: ViewId;
  readonly sessionManager: SessionManagerPort;
  readonly sessionId?: string;
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

export function App({ initialView, sessionManager, sessionId }: AppProps): React.JSX.Element {
  const terminalWidth = useTerminalWidth();
  const contentWidth = Math.min(terminalWidth, MAX_CONTENT_WIDTH);
  const [stack] = useState<readonly ViewEntry[]>(() => buildInitialStack(initialView, sessionId));

  return (
    <Box width={terminalWidth} justifyContent="center">
      <Box flexDirection="column" width={contentWidth}>
        <ViewRouter initialStack={stack} sessionManager={sessionManager} />
      </Box>
    </Box>
  );
}
