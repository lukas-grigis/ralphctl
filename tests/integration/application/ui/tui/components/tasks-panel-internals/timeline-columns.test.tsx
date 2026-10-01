/** Timeline rows: the time and kind columns are fixed and never wrap; only the message truncates. */

import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution, TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

const ts = (n: number): IsoTimestamp => new Date(Date.UTC(2026, 0, 1, 22, 49, n)).toISOString() as IsoTimestamp;

const bucket: TaskBucket = {
  id: '01933fbb-0000-7000-8000-000000000001',
  status: 'running',
  subSteps: [],
  evaluations: [],
  signals: [
    { type: 'change', text: 'x'.repeat(300), timestamp: ts(5) },
    { type: 'learning', text: 'y'.repeat(300), timestamp: ts(6) },
    { type: 'task-verified', output: 'z'.repeat(300), timestamp: ts(7) },
    { type: 'reproduction', testPath: 'tests/a.test.ts', reproduced: true, timestamp: ts(8) },
  ] as HarnessSignal[],
  genEvalRound: 0,
};

describe('timeline columns', () => {
  it.each([60, 80, 100])('keeps every timestamp whole on one line at width %i', (width) => {
    const r = render(
      <Box width={width} flexDirection="column">
        <TasksPanel bucketed={{ tasks: [bucket], orphanSignals: [] } satisfies BucketedExecution} running={true} />
      </Box>
    );
    const frame = r.lastFrame() ?? '';
    r.unmount();
    const rows = frame.split('\n').filter((l) => /\d\d:\d\d:\d\d/.test(l));
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row).toMatch(/^\s*[›\s]\s*\d\d:\d\d:\d\d\s+\S/);
    expect(frame).not.toMatch(/\d\d:\d\d:\s*$/m);
    for (const line of frame.split('\n')) expect([...line].length).toBeLessThanOrEqual(width);
  });
});
