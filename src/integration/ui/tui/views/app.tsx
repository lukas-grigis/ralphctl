/**
 * Root Ink component.
 *
 * Dispatches on `initialView`:
 *   - 'repl'    → `<ReplView />` (idle menu + live dashboard header)
 *   - 'execute' → `<ExecuteView />` (live sprint execution dashboard)
 *
 * `<PromptHost />` is always mounted at the bottom so any command that calls
 * `getPrompt()` renders through a single, consistent surface — regardless of
 * which view is active. Prompts are a sibling of (not a child of) the view
 * so they overlay cleanly without the view having to know about them.
 */

import React from 'react';
import { Box } from 'ink';
import { PromptHost } from '@src/integration/prompts/prompt-host.tsx';
import type { InkViewName, MountOptions } from '@src/integration/ui/tui/runtime/mount.tsx';
import { ReplView } from './repl-view.tsx';
import { ExecuteView } from './execute-view.tsx';

export interface AppProps {
  initialView: InkViewName;
  mountOptions: MountOptions;
}

export function App({ initialView, mountOptions }: AppProps): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {initialView === 'execute' && mountOptions.sprintId !== undefined ? (
        <ExecuteView sprintId={mountOptions.sprintId} executionOptions={mountOptions.executionOptions} />
      ) : (
        <ReplView />
      )}
      <PromptHost />
    </Box>
  );
}
