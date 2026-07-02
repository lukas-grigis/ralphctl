/**
 * Leaf that owns its own 1 Hz tick for the header's "elapsed" text. Isolated from
 * `HeaderCard` so the tick re-renders only this one `<Text>` node — not the whole card (model
 * lines, task-focus row) or anything above it in the tree. See `use-live-clock.ts`: the clock
 * pauses (no interval) the moment the run settles, so a finished view stops re-rendering
 * entirely once `isRunning` is false.
 */

import React from 'react';
import { Text } from 'ink';
import { fmtElapsed } from '@src/application/ui/tui/theme/duration.ts';
import { useLiveClock } from '@src/application/ui/tui/views/execute-view-internals/use-live-clock.ts';

export interface ElapsedLabelProps {
  readonly startedAt: number;
  readonly finishedAt: number | undefined;
  readonly isRunning: boolean;
}

export const ElapsedLabel = ({ startedAt, finishedAt, isRunning }: ElapsedLabelProps): React.JSX.Element => {
  const now = useLiveClock(isRunning);
  const endedAt = finishedAt ?? now;
  return <Text>{fmtElapsed(startedAt, endedAt)}</Text>;
};
