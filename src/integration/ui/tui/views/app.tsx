/**
 * Root Ink component.
 *
 * Translates the legacy `initialView` flag (the only thing the mount layer
 * knows) into a navigation stack seed and hands off to `<ViewRouter />`.
 *
 * `<PromptHost />` is always mounted as a sibling of the router so any
 * command that calls `getPrompt()` renders through a single, consistent
 * surface — regardless of which view is active.
 */

import React from 'react';
import { Box } from 'ink';
import { PromptHost } from '@src/integration/prompts/prompt-host.tsx';
import type { InkViewName, MountOptions } from '@src/integration/ui/tui/runtime/mount.tsx';
import type { ViewEntry } from './router-context.ts';
import { ViewRouter } from './view-router.tsx';

export interface AppProps {
  initialView: InkViewName;
  mountOptions: MountOptions;
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

export function App({ initialView, mountOptions }: AppProps): React.JSX.Element {
  const initialStack = buildInitialStack(initialView, mountOptions);
  return (
    <Box flexDirection="column">
      <ViewRouter initialStack={initialStack} />
      <PromptHost />
    </Box>
  );
}
