/**
 * Pure-function tests for the per-task bucketing the Implement dashboard relies on.
 *
 * Focus areas these tests pin down:
 *  - The O(s + w log w) binary-search rewrite: edge cases at window boundaries (signal ts
 *    exactly equal to startedAt/endedAt), empty/single-window inputs, mid-window attribution.
 *  - Terminal-substep override flips `completed` when a flow uses a non-default last leaf.
 *  - Status derivation: failed/aborted substeps win over a later completed terminal substep.
 *  - Round counter via `generator-<id>` substep count.
 */

import { describe, expect, it } from 'vitest';
import type { Trace } from '@src/application/chain/trace.ts';
import type { AppEvent } from '@src/business/observability/events.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { bucketTaskSignals } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';

const TASK = '01933fbb-1111-7000-8000-000000000001';
const TASK2 = '01933fbb-2222-7000-8000-000000000002';

const note = (ts: string, text = 'n'): HarnessSignal => ({ type: 'note', text, timestamp: ts as never });
const stepCompleted = (elementName: string, at: string): AppEvent => ({
  type: 'chain-step-completed',
  chainId: 'r-1',
  elementName,
  durationMs: 1,
  at: at as never,
});

describe('bucketTaskSignals — binary-search attribution', () => {
  it('returns empty buckets when nothing has happened yet', () => {
    const result = bucketTaskSignals([], [], []);
    expect(result.tasks).toEqual([]);
    expect(result.orphanSignals).toEqual([]);
  });

  it('attributes a signal whose timestamp falls inside the only task window', () => {
    const trace: Trace = [{ elementName: `generator-${TASK}`, status: 'completed', durationMs: 10 }];
    const events: AppEvent[] = [
      stepCompleted(`build-task-workspace-${TASK}`, '2026-05-09T10:00:00.000Z'),
      stepCompleted(`unlink-skills-${TASK}`, '2026-05-09T10:01:00.000Z'),
    ];
    const signals: HarnessSignal[] = [note('2026-05-09T10:00:30.000Z')];
    const result = bucketTaskSignals(trace, events, signals);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.signals).toHaveLength(1);
    expect(result.orphanSignals).toHaveLength(0);
  });

  it('attributes a signal at the exact startedAt boundary to the matching window', () => {
    const events: AppEvent[] = [
      stepCompleted(`build-task-workspace-${TASK}`, '2026-05-09T10:00:00.000Z'),
      stepCompleted(`unlink-skills-${TASK}`, '2026-05-09T10:01:00.000Z'),
    ];
    const trace: Trace = [{ elementName: `generator-${TASK}`, status: 'completed', durationMs: 10 }];
    const signals: HarnessSignal[] = [note('2026-05-09T10:00:00.000Z', 'at-start')];
    const result = bucketTaskSignals(trace, events, signals);
    expect(result.tasks[0]?.signals).toHaveLength(1);
    expect(result.orphanSignals).toHaveLength(0);
  });

  it('attributes a signal at the exact endedAt boundary to the matching window', () => {
    const events: AppEvent[] = [
      stepCompleted(`build-task-workspace-${TASK}`, '2026-05-09T10:00:00.000Z'),
      stepCompleted(`unlink-skills-${TASK}`, '2026-05-09T10:01:00.000Z'),
    ];
    const trace: Trace = [{ elementName: `generator-${TASK}`, status: 'completed', durationMs: 10 }];
    const signals: HarnessSignal[] = [note('2026-05-09T10:01:00.000Z', 'at-end')];
    const result = bucketTaskSignals(trace, events, signals);
    expect(result.tasks[0]?.signals).toHaveLength(1);
    expect(result.orphanSignals).toHaveLength(0);
  });

  it('treats signals before any window as orphans', () => {
    const events: AppEvent[] = [stepCompleted(`build-task-workspace-${TASK}`, '2026-05-09T10:00:00.000Z')];
    const trace: Trace = [{ elementName: `generator-${TASK}`, status: 'completed', durationMs: 10 }];
    const signals: HarnessSignal[] = [note('2026-05-09T09:00:00.000Z', 'before-everything')];
    const result = bucketTaskSignals(trace, events, signals);
    expect(result.orphanSignals).toHaveLength(1);
    expect(result.tasks[0]?.signals ?? []).toHaveLength(0);
  });

  it('treats signals after a closed window (with later one not yet open) as orphans', () => {
    // Task 1 closes at 10:01; nothing else yet. A signal at 10:01:30 is past task 1's endedAt
    // and there's no later task to inherit it — must orphan.
    const events: AppEvent[] = [
      stepCompleted(`build-task-workspace-${TASK}`, '2026-05-09T10:00:00.000Z'),
      stepCompleted(`unlink-skills-${TASK}`, '2026-05-09T10:01:00.000Z'),
    ];
    const trace: Trace = [{ elementName: `generator-${TASK}`, status: 'completed', durationMs: 10 }];
    const signals: HarnessSignal[] = [note('2026-05-09T10:01:30.000Z', 'after-task-1')];
    const result = bucketTaskSignals(trace, events, signals);
    expect(result.orphanSignals).toHaveLength(1);
  });

  it('routes signals to the right task across two non-overlapping windows', () => {
    const events: AppEvent[] = [
      stepCompleted(`build-task-workspace-${TASK}`, '2026-05-09T10:00:00.000Z'),
      stepCompleted(`unlink-skills-${TASK}`, '2026-05-09T10:01:00.000Z'),
      stepCompleted(`build-task-workspace-${TASK2}`, '2026-05-09T10:02:00.000Z'),
      stepCompleted(`unlink-skills-${TASK2}`, '2026-05-09T10:03:00.000Z'),
    ];
    const trace: Trace = [
      { elementName: `generator-${TASK}`, status: 'completed', durationMs: 10 },
      { elementName: `generator-${TASK2}`, status: 'completed', durationMs: 10 },
    ];
    const signals: HarnessSignal[] = [
      note('2026-05-09T10:00:30.000Z', 'for-1'),
      note('2026-05-09T10:02:30.000Z', 'for-2'),
    ];
    const result = bucketTaskSignals(trace, events, signals);
    const t1 = result.tasks.find((t) => t.id === TASK);
    const t2 = result.tasks.find((t) => t.id === TASK2);
    expect(t1?.signals).toHaveLength(1);
    expect(t2?.signals).toHaveLength(1);
    expect(result.orphanSignals).toHaveLength(0);
  });
});

describe('bucketTaskSignals — status derivation', () => {
  it('flips a task to completed when the default terminal substep appears', () => {
    const trace: Trace = [
      { elementName: `generator-${TASK}`, status: 'completed', durationMs: 1 },
      { elementName: `unlink-skills-${TASK}`, status: 'completed', durationMs: 1 },
    ];
    const result = bucketTaskSignals(trace, [], []);
    expect(result.tasks[0]?.status).toBe('completed');
  });

  it('respects a custom terminalSubstepName when the flow uses a different terminal leaf', () => {
    const trace: Trace = [
      { elementName: `generator-${TASK}`, status: 'completed', durationMs: 1 },
      { elementName: `unlink-skills-${TASK}`, status: 'completed', durationMs: 1 },
      { elementName: `custom-final-${TASK}`, status: 'completed', durationMs: 1 },
    ];
    const result = bucketTaskSignals(trace, [], [], { terminalSubstepName: 'custom-final' });
    expect(result.tasks[0]?.status).toBe('completed');
  });

  it('stays running when only partial substeps are recorded', () => {
    const trace: Trace = [{ elementName: `generator-${TASK}`, status: 'completed', durationMs: 1 }];
    const result = bucketTaskSignals(trace, [], []);
    expect(result.tasks[0]?.status).toBe('running');
  });

  it('lets a failed substep override a later completed terminal substep', () => {
    const trace: Trace = [
      { elementName: `generator-${TASK}`, status: 'failed', durationMs: 1 },
      { elementName: `unlink-skills-${TASK}`, status: 'completed', durationMs: 1 },
    ];
    const result = bucketTaskSignals(trace, [], []);
    expect(result.tasks[0]?.status).toBe('failed');
  });
});

describe('bucketTaskSignals — round counter', () => {
  it('counts generator-<taskId> substeps as gen-eval rounds', () => {
    const trace: Trace = [
      { elementName: `generator-${TASK}`, status: 'completed', durationMs: 1 },
      { elementName: `evaluator-${TASK}`, status: 'completed', durationMs: 1 },
      { elementName: `generator-${TASK}`, status: 'completed', durationMs: 1 },
      { elementName: `evaluator-${TASK}`, status: 'completed', durationMs: 1 },
      { elementName: `generator-${TASK}`, status: 'completed', durationMs: 1 },
    ];
    const result = bucketTaskSignals(trace, [], [], { maxTurns: 5 });
    expect(result.tasks[0]?.genEvalRound).toBe(3);
    expect(result.tasks[0]?.genEvalMaxRounds).toBe(5);
  });
});
