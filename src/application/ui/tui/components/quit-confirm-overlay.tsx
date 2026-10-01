/** Quit with runs live: `[y/N]`, default No. Yes aborts every run cleanly, then exits; ctrl+c while stopping quits now. */

import React, { useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { glyphs, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { plural } from '@src/application/ui/shared/plural.ts';

export const QuitConfirmOverlay = ({ runs }: { readonly runs: number }): React.JSX.Element => {
  const { exit } = useApp();
  const deps = useDeps();
  const ui = useUiState();
  const [stopping, setStopping] = useState(false);

  useInput((input, key) => {
    const ctrlC = key.ctrl && input === 'c';
    if (stopping) {
      if (ctrlC) exit();
      return;
    }
    if (input === 'y') {
      setStopping(true);
      // Aborting settles the runs and waits for their AI CLI children; exit follows whatever the outcome.
      void deps.inProcessRuns.abortAll('quit').then(exit, exit);
      return;
    }
    if (input === 'n' || input === 'q' || key.escape || key.return || ctrlC) ui.closeOverlay();
  });

  return (
    <Box flexDirection="column" paddingX={spacing.indent} paddingY={spacing.section}>
      <Card tone="warning" title={stopping ? 'Stopping' : 'Quit'}>
        {stopping ? (
          <>
            <Text>
              Stopping {plural(runs, 'run')} {glyphs.emDash} each stops at a safe point.
            </Text>
            <Text dimColor>ctrl+c quits now; leftover AI processes are cleaned up on exit or the next launch.</Text>
          </>
        ) : (
          <>
            <Text bold>
              {plural(runs, 'run')} live {glyphs.emDash} quit stops them? [y/N]
            </Text>
            <Text dimColor>Progress stays on disk; Work offers to resume interrupted tasks.</Text>
            <Text dimColor>y stop and quit {glyphs.bullet} n / esc / ↵ keep running</Text>
          </>
        )}
      </Card>
    </Box>
  );
};
