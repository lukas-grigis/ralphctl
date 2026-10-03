/** Quit with runs live: `[y/N]`, default No; Yes stops every run (bounded wait), ctrl+c while stopping quits now. */

import React, { useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useOptionalPromptQueue } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import { glyphs, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { plural } from '@src/application/ui/shared/plural.ts';
import { ABORT_ALL_TIMEOUT_MS, type AbortAllOutcome } from '@src/application/session/in-process-runs.ts';
import type { ExitNote } from '@src/application/ui/shared/ink-host.ts';

const STOP_WAIT_S = Math.round(ABORT_ALL_TIMEOUT_MS / 1000);

export const forcedStopNote = (outcome: AbortAllOutcome): ExitNote | undefined => {
  if (!outcome.forced) return undefined;
  const who =
    outcome.stuckFlows.length > 0 ? `${outcome.stuckFlows.join(', ')} did not stop` : 'AI CLI processes did not exit';
  const killed = outcome.killed > 0 ? `force-killed ${plural(outcome.killed, 'AI CLI process group')}` : 'quit anyway';
  return {
    exitNote: `ralphctl: ${who} within ${String(STOP_WAIT_S)}s ${glyphs.emDash} ${killed}. The next launch offers to resume interrupted tasks.`,
  };
};

export const QuitConfirmOverlay = ({ runs }: { readonly runs: number }): React.JSX.Element => {
  const { exit } = useApp();
  const deps = useDeps();
  const ui = useUiState();
  const queue = useOptionalPromptQueue();
  const [stopping, setStopping] = useState(false);

  useInput((input, key) => {
    const ctrlC = key.ctrl && input === 'c';
    if (stopping) {
      if (ctrlC) exit();
      return;
    }
    if (input === 'y') {
      setStopping(true);
      // Aborting first withdraws each run's own prompt as part of its abort; whatever is left belongs to no run.
      const stopped = deps.inProcessRuns.abortAll('quit');
      queue?.drain(new Error('quitting'));
      void stopped.then((outcome) => exit(forcedStopNote(outcome)), exit);
      return;
    }
    if (input === 'n' || input === 'q' || key.escape || key.return || ctrlC) ui.closeQuit();
  });

  return (
    <Box flexDirection="column" paddingX={spacing.indent} paddingY={spacing.section}>
      <Card tone="warning" title={stopping ? 'Stopping' : 'Quit'}>
        {stopping ? (
          <>
            <Text>
              Stopping {plural(runs, 'run')} {glyphs.emDash} each stops at a safe point.
            </Text>
            <Text dimColor>
              Force-stops after {String(STOP_WAIT_S)}s {glyphs.bullet} ctrl+c quits now; leftover AI processes are
              cleaned up on exit or the next launch.
            </Text>
          </>
        ) : (
          <>
            <Text bold>
              {plural(runs, 'run')} live {glyphs.emDash} quit stops them? [y/N]
            </Text>
            <Text dimColor>Progress stays on disk; the next Implement picks the tasks up again.</Text>
            <Text dimColor>y stop and quit {glyphs.bullet} n / esc / ↵ keep running</Text>
          </>
        )}
      </Card>
    </Box>
  );
};
