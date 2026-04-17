/**
 * Root Ink component.
 *
 * Translates the legacy `initialView` flag (the only thing the mount layer
 * knows) into a navigation stack seed and hands off to `<ViewRouter />`.
 *
 * The root sizes a centered content column to the terminal width, clamped
 * between MIN_CONTENT_WIDTH and MAX_CONTENT_WIDTH. The app feels responsive:
 * narrow terminals shrink to fit; wide terminals get a roomy ~160-col canvas
 * with side margins (so text rows don't stretch into unreadable lines).
 * Resize the terminal → the layout reflows.
 *
 * `<PromptHost />` lives inside the router so interactive prompts render in
 * the view body rather than below the status bar.
 */

import React, { useEffect, useState } from 'react';
import { Box, useStdout } from 'ink';
import type { InkViewName, MountOptions } from '@src/integration/ui/tui/runtime/mount.tsx';
import type { ViewEntry } from './router-context.ts';
import { ViewRouter } from './view-router.tsx';

export interface AppProps {
  initialView: InkViewName;
  mountOptions: MountOptions;
}

const MIN_CONTENT_WIDTH = 80;
const MAX_CONTENT_WIDTH = 160;

function buildInitialStack(initialView: InkViewName, mountOptions: MountOptions): readonly ViewEntry[] {
  if (initialView === 'execute' && mountOptions.sprintId !== undefined) {
    return [
      {
        id: 'execute',
        props: { sprintId: mountOptions.sprintId, executionOptions: mountOptions.executionOptions },
      },
    ];
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

export function App({ initialView, mountOptions }: AppProps): React.JSX.Element {
  const initialStack = buildInitialStack(initialView, mountOptions);
  const terminalWidth = useTerminalWidth();
  const contentWidth = Math.min(MAX_CONTENT_WIDTH, Math.max(MIN_CONTENT_WIDTH, terminalWidth));

  return (
    <Box width={terminalWidth} justifyContent="center">
      <Box flexDirection="column" width={contentWidth}>
        <ViewRouter initialStack={initialStack} />
      </Box>
    </Box>
  );
}
