/**
 * Root Ink component.
 *
 * Translates the legacy `initialView` flag (the only thing the mount layer
 * knows) into a navigation stack seed and hands off to `<ViewRouter />`.
 *
 * On mount we run a first-run check (no projects AND no current sprint AND
 * no AI provider → seed the onboarding view instead of home). The probe is
 * async and non-blocking: we render a placeholder for one tick and swap in
 * the real stack when the probe settles.
 *
 * Layout strategy: responsive centered column.
 *
 *   ┌─ terminal ────────────────────────────────────────────────────┐
 *   │           ┌─ content column (max 160 cols) ──┐                │
 *   │           │  banner (centers within column)  │                │
 *   │           │  body (left-anchored inside col) │                │
 *   │           └──────────────────────────────────┘                │
 *   └───────────────────────────────────────────────────────────────┘
 *
 * Narrow terminals (<= max): column equals terminal width — no centering
 * artefacts, content uses the full screen. Wide terminals (> max): column
 * caps at the max and centers, so the banner and body share the same frame
 * instead of drifting apart.
 */

import React, { useEffect, useState } from 'react';
import { Box, useStdout } from 'ink';
import type { InkViewName, MountOptions } from '@src/integration/ui/tui/runtime/mount.tsx';
import { listProjects } from '@src/integration/persistence/project.ts';
import { getAiProvider, getConfig } from '@src/integration/persistence/config.ts';
import type { ViewEntry } from './router-context.ts';
import { ViewRouter } from './view-router.tsx';

export interface AppProps {
  initialView: InkViewName;
  mountOptions: MountOptions;
}

/** Cap the content column at a readable width. Wide terminals get gutters. */
const MAX_CONTENT_WIDTH = 160;

async function isFirstRun(): Promise<boolean> {
  try {
    const [projects, config, provider] = await Promise.all([
      listProjects().catch(() => []),
      getConfig().catch(() => null),
      getAiProvider().catch(() => null),
    ]);
    return projects.length === 0 && (config?.currentSprint ?? null) === null && provider === null;
  } catch {
    return false;
  }
}

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
  const terminalWidth = useTerminalWidth();
  const contentWidth = Math.min(terminalWidth, MAX_CONTENT_WIDTH);
  const [stack, setStack] = useState<readonly ViewEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const decideInitial = async (): Promise<void> => {
      // Execute path bypasses onboarding — we have an explicit sprintId.
      if (initialView === 'execute' && mountOptions.sprintId !== undefined) {
        if (!cancelled) setStack(buildInitialStack(initialView, mountOptions));
        return;
      }
      const firstRun = await isFirstRun();
      if (cancelled) return;
      setStack(firstRun ? [{ id: 'onboarding' }] : [{ id: 'home' }]);
    };
    void decideInitial();
    return () => {
      cancelled = true;
    };
  }, [initialView, mountOptions]);

  if (stack === null) {
    return <Box width={terminalWidth} />;
  }

  return (
    <Box width={terminalWidth} justifyContent="center">
      <Box flexDirection="column" width={contentWidth}>
        <ViewRouter initialStack={stack} />
      </Box>
    </Box>
  );
}
