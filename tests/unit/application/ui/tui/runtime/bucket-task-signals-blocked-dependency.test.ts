/**
 * A dependency-blocked task must NOT read as `running` for the rest of the implement run.
 *
 * The per-task subchain is `sequential('task-<id>', [dependency-gate-<id>, guard('task-runnable-<id>',
 * isTaskRunnable, sequential('task-body-<id>', […]))])`. `guard` emits exactly ONE synthetic trace
 * entry, named after its BODY — so a gate-blocked task's only trace entries are
 * `dependency-gate-<id>` (completed) and `task-body-<id>` (skipped). Neither is failed/aborted and
 * neither is the terminal `uninstall-skills` leaf, so the bucket used to resolve `running` forever:
 * the Execute header pinned its "active task" readout on a task that was `blocked` on disk.
 */

import { describe, expect, it } from 'vitest';
import type { Trace } from '@src/application/chain/trace.ts';
import { bucketTaskSignals, isInFlightBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';

const BLOCKED = '01933fbb-1111-7000-8000-000000000001';
const SIBLING = '01933fbb-2222-7000-8000-000000000002';

/** The exact trace shape the dependency gate + body guard produce for a blocked task. */
const gateBlockedTrace = (taskId: string): Trace => [
  { elementName: `dependency-gate-${taskId}`, status: 'completed', durationMs: 2 },
  { elementName: `task-body-${taskId}`, status: 'skipped', durationMs: 0 },
];

describe('bucketTaskSignals — dependency-blocked task', () => {
  it('resolves a gate-blocked task to `skipped`, not `running`', () => {
    const result = bucketTaskSignals(gateBlockedTrace(BLOCKED), [], []);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe(BLOCKED);
    expect(result.tasks[0]?.status).toBe('skipped');
  });

  it('keeps the blocked task behind the in-flight cursor while a sibling still runs', () => {
    const trace: Trace = [
      ...gateBlockedTrace(BLOCKED),
      { elementName: `dependency-gate-${SIBLING}`, status: 'completed', durationMs: 2 },
      { elementName: `generator-${SIBLING}`, status: 'completed', durationMs: 40 },
    ];
    const result = bucketTaskSignals(trace, [], []);

    const inFlight = result.tasks.findIndex(isInFlightBucket);
    expect(result.tasks[inFlight]?.id).toBe(SIBLING);
    expect(result.tasks[inFlight]?.status).toBe('running');
  });

  it('does not treat a skipped sub-guard (reproduce / quarantine) as a skipped task', () => {
    // Both guards live INSIDE the body and skip routinely on the happy path — only the
    // `task-body` composite being skipped means the whole task never ran.
    const trace: Trace = [
      { elementName: `dependency-gate-${SIBLING}`, status: 'completed', durationMs: 2 },
      { elementName: `reproduce-${SIBLING}`, status: 'skipped', durationMs: 0 },
      { elementName: `generator-${SIBLING}`, status: 'completed', durationMs: 40 },
      { elementName: `uninstall-skills-${SIBLING}`, status: 'completed', durationMs: 3 },
    ];
    const result = bucketTaskSignals(trace, [], []);

    expect(result.tasks[0]?.status).toBe('completed');
  });

  it('never reads a SKIPPED terminal leaf as a completed task', () => {
    const trace: Trace = [
      { elementName: `dependency-gate-${BLOCKED}`, status: 'completed', durationMs: 2 },
      { elementName: `uninstall-skills-${BLOCKED}`, status: 'skipped', durationMs: 0 },
    ];
    const result = bucketTaskSignals(trace, [], []);

    expect(result.tasks[0]?.status).not.toBe('completed');
  });

  it('counts only genuinely in-flight buckets as current', () => {
    expect(isInFlightBucket({ status: 'running' })).toBe(true);
    expect(isInFlightBucket({ status: 'pending' })).toBe(true);
    expect(isInFlightBucket({ status: 'skipped' })).toBe(false);
    expect(isInFlightBucket({ status: 'failed' })).toBe(false);
    expect(isInFlightBucket({ status: 'aborted' })).toBe(false);
    expect(isInFlightBucket({ status: 'completed' })).toBe(false);
  });
});
