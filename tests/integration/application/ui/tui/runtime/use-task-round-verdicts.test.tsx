/** The hook folds bus events into (run, task) → attempt → round iteration verdicts, one commit per flush window. */

import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import {
  runTaskKey,
  type TaskVerdicts,
  useTaskRoundVerdicts,
} from '@src/application/ui/tui/runtime/use-task-round-verdicts.ts';
import { isoTimestamp } from '@tests/fixtures/domain.ts';

const NOW = isoTimestamp('2026-05-09T10:00:00.000Z');
const drain = (ms = 60): Promise<void> => new Promise((res) => setTimeout(res, ms));

const Probe = ({
  bus,
  onState,
}: {
  readonly bus: ReturnType<typeof createInMemoryEventBus>;
  readonly onState: (v: ReadonlyMap<string, TaskVerdicts>) => void;
}): React.JSX.Element => {
  const verdicts = useTaskRoundVerdicts(bus, { flushMs: 20 });
  onState(verdicts);
  return <Text>tasks={verdicts.size}</Text>;
};

describe('useTaskRoundVerdicts', () => {
  it('folds attributed task-round-evaluated events and ignores the rest', async () => {
    const bus = createInMemoryEventBus();
    let last: ReadonlyMap<string, TaskVerdicts> = new Map();
    const r = render(<Probe bus={bus} onState={(v) => (last = v)} />);
    bus.publish({ type: 'task-round-started', taskId: 't1', attemptN: 1, roundN: 1, totalCap: 5, at: NOW });
    bus.publish({
      type: 'task-round-evaluated',
      taskId: 't1',
      attemptN: 1,
      roundN: 1,
      verdict: 'failed',
      failedDimensions: ['correctness'],
      headline: 'wrong',
      chainSessionId: 'run-1',
      iteration: { attempt: 1, round: 1 },
      at: NOW,
    });
    // No run or iteration: nothing to place it on.
    bus.publish({
      type: 'task-round-evaluated',
      taskId: 't2',
      attemptN: 1,
      roundN: 1,
      verdict: 'passed',
      failedDimensions: [],
      at: NOW,
    });
    await drain();
    expect(last.get(runTaskKey('run-1', 't1'))?.get(1)?.get(1)).toEqual({
      status: 'failed',
      dimensions: ['correctness'],
      headline: 'wrong',
    });
    expect(last.size).toBe(1);
    r.unmount();
  });
});
