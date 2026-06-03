/**
 * Verify the descriptor → BucketOptions seam in `useBucketedTasks`. The execute view reads
 * `currentTask.genEvalMaxAttempts` to render the `attempt A/X` cap; that field is only populated
 * when the hook threads `descriptor.maxAttempts` into `bucketTaskSignals`. This pins the wiring
 * end-to-end (descriptor field → bucket field) so the `/X` total can't silently regress again.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { Trace } from '@src/application/chain/trace.ts';
import type { BucketedDerivation } from '@src/application/ui/tui/views/execute-view-internals/use-bucketed-tasks.ts';
import { useBucketedTasks } from '@src/application/ui/tui/views/execute-view-internals/use-bucketed-tasks.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';

const TASK = '01933fbb-1111-7000-8000-000000000001';

// A minimal one-task trace: a single generator substep is enough for `bucketTaskSignals` to
// emit one running bucket carrying `genEvalRound`.
const TRACE: Trace = [{ elementName: `generator-${TASK}`, status: 'completed', durationMs: 1 }];

const descriptorWith = (patch: Partial<SessionDescriptor>): SessionDescriptor => ({
  id: 'r-1',
  flowId: 'implement',
  title: 'Implement — test',
  status: 'running',
  startedAt: 0,
  trace: TRACE,
  ...patch,
});

const Probe = ({
  descriptor,
  bus,
  onState,
}: {
  readonly descriptor: SessionDescriptor;
  readonly bus: ReturnType<typeof createInMemoryEventBus>;
  readonly onState: (derivation: BucketedDerivation) => void;
}): React.JSX.Element => {
  const derivation = useBucketedTasks({ descriptor, chainEvents: [], signals: [], eventBus: bus });
  onState(derivation);
  return <Text>tasks={derivation.tasksTotal}</Text>;
};

describe('useBucketedTasks — maxAttempts seam', () => {
  it('surfaces genEvalMaxAttempts on the bucket when the descriptor carries maxAttempts > 1', () => {
    const bus = createInMemoryEventBus();
    let last: BucketedDerivation | undefined;
    const descriptor = descriptorWith({ maxTurns: 3, maxAttempts: 3 });
    const r = render(<Probe descriptor={descriptor} bus={bus} onState={(d) => (last = d)} />);

    expect(last?.bucketed?.tasks[0]?.genEvalMaxAttempts).toBe(3);
    r.unmount();
  });

  it('leaves genEvalMaxAttempts undefined when the descriptor omits maxAttempts', () => {
    const bus = createInMemoryEventBus();
    let last: BucketedDerivation | undefined;
    const descriptor = descriptorWith({ maxTurns: 3 });
    const r = render(<Probe descriptor={descriptor} bus={bus} onState={(d) => (last = d)} />);

    expect(last?.bucketed?.tasks[0]?.genEvalMaxAttempts).toBeUndefined();
    r.unmount();
  });
});
