/**
 * The Execute header's "current task" cursor must move PAST a dependency-blocked task.
 *
 * A gate-blocked task traces `dependency-gate-<id>` (completed) + `task-body-<id>` (skipped) and
 * nothing else. It used to bucket as `running` forever, and the cursor scan ("first non-completed
 * task") pinned the header's active-task / current-substep readout on it for the rest of the run
 * while the tasks that actually executed ran unnoticed underneath.
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

const BLOCKED = '01933fbb-1111-7000-8000-000000000001';
const RUNNING = '01933fbb-2222-7000-8000-000000000002';

/** Task 1 blocked upstream by the dependency gate; task 2 mid gen-eval loop. */
const TRACE: Trace = [
  { elementName: `dependency-gate-${BLOCKED}`, status: 'completed', durationMs: 2 },
  { elementName: `task-body-${BLOCKED}`, status: 'skipped', durationMs: 0 },
  { elementName: `dependency-gate-${RUNNING}`, status: 'completed', durationMs: 2 },
  { elementName: `generator-${RUNNING}`, status: 'completed', durationMs: 40 },
];

const descriptor: SessionDescriptor = {
  id: 'r-1',
  flowId: 'implement',
  title: 'Implement — test',
  status: 'running',
  startedAt: 0,
  trace: TRACE,
  taskNames: new Map([
    [BLOCKED, 'Blocked upstream task'],
    [RUNNING, 'The task actually running'],
  ]),
};

const Probe = ({
  bus,
  onState,
}: {
  readonly bus: ReturnType<typeof createInMemoryEventBus>;
  readonly onState: (derivation: BucketedDerivation) => void;
}): React.JSX.Element => {
  const derivation = useBucketedTasks({ descriptor, chainEvents: [], signals: [], eventBus: bus });
  onState(derivation);
  return <Text>tasks={derivation.tasksTotal}</Text>;
};

describe('useBucketedTasks — dependency-blocked cursor', () => {
  it('points the current-task readout at the running sibling, not the blocked task', () => {
    const bus = createInMemoryEventBus();
    let last: BucketedDerivation | undefined;
    const r = render(<Probe bus={bus} onState={(d) => (last = d)} />);

    expect(last?.bucketed?.tasks[0]?.status).toBe('skipped');
    expect(last?.currentTask?.id).toBe(RUNNING);
    expect(last?.currentTaskName).toBe('The task actually running');
    expect(last?.currentSubStep).toBe('generator');
    r.unmount();
  });

  it('reports no current task once every task has settled', () => {
    const bus = createInMemoryEventBus();
    let last: BucketedDerivation | undefined;
    const settled: Trace = [
      { elementName: `dependency-gate-${BLOCKED}`, status: 'completed', durationMs: 2 },
      { elementName: `task-body-${BLOCKED}`, status: 'skipped', durationMs: 0 },
      { elementName: `generator-${RUNNING}`, status: 'completed', durationMs: 40 },
      { elementName: `uninstall-skills-${RUNNING}`, status: 'completed', durationMs: 3 },
    ];
    const Settled = (): React.JSX.Element => {
      const derivation = useBucketedTasks({
        descriptor: { ...descriptor, trace: settled },
        chainEvents: [],
        signals: [],
        eventBus: bus,
      });
      last = derivation;
      return <Text>x</Text>;
    };
    const r = render(<Settled />);

    expect(last?.currentTask).toBeUndefined();
    // Only the task that genuinely finished counts as done — the blocked one is not a pass.
    expect(last?.tasksDone).toBe(1);
    expect(last?.tasksTotal).toBe(2);
    r.unmount();
  });
});
