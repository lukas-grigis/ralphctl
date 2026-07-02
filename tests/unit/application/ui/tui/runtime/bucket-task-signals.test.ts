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
import {
  bucketTaskSignals,
  perAttemptRound,
  resolveAttemptCoords,
} from '@src/application/ui/tui/runtime/bucket-task-signals.ts';

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
      stepCompleted(`uninstall-skills-${TASK}`, '2026-05-09T10:01:00.000Z'),
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
      stepCompleted(`uninstall-skills-${TASK}`, '2026-05-09T10:01:00.000Z'),
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
      stepCompleted(`uninstall-skills-${TASK}`, '2026-05-09T10:01:00.000Z'),
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
      stepCompleted(`uninstall-skills-${TASK}`, '2026-05-09T10:01:00.000Z'),
    ];
    const trace: Trace = [{ elementName: `generator-${TASK}`, status: 'completed', durationMs: 10 }];
    const signals: HarnessSignal[] = [note('2026-05-09T10:01:30.000Z', 'after-task-1')];
    const result = bucketTaskSignals(trace, events, signals);
    expect(result.orphanSignals).toHaveLength(1);
  });

  it('routes signals to the right task across two non-overlapping windows', () => {
    const events: AppEvent[] = [
      stepCompleted(`build-task-workspace-${TASK}`, '2026-05-09T10:00:00.000Z'),
      stepCompleted(`uninstall-skills-${TASK}`, '2026-05-09T10:01:00.000Z'),
      stepCompleted(`build-task-workspace-${TASK2}`, '2026-05-09T10:02:00.000Z'),
      stepCompleted(`uninstall-skills-${TASK2}`, '2026-05-09T10:03:00.000Z'),
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
      { elementName: `uninstall-skills-${TASK}`, status: 'completed', durationMs: 1 },
    ];
    const result = bucketTaskSignals(trace, [], []);
    expect(result.tasks[0]?.status).toBe('completed');
  });

  it('respects a custom terminalSubstepName when the flow uses a different terminal leaf', () => {
    const trace: Trace = [
      { elementName: `generator-${TASK}`, status: 'completed', durationMs: 1 },
      { elementName: `uninstall-skills-${TASK}`, status: 'completed', durationMs: 1 },
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
      { elementName: `uninstall-skills-${TASK}`, status: 'completed', durationMs: 1 },
    ];
    const result = bucketTaskSignals(trace, [], []);
    expect(result.tasks[0]?.status).toBe('failed');
  });
});

describe('bucketTaskSignals — commit-message attribution', () => {
  // Post-Wave-6: only the AI's signal reaches the bus (via the validated signals.json contract).
  // The commit-task leaf does not re-emit; trailer-appending happens at `git commit -F` only.
  it('keeps the AI commit-message signal verbatim in the task bucket', () => {
    const events: AppEvent[] = [
      stepCompleted(`build-task-workspace-${TASK}`, '2026-05-09T10:00:00.000Z'),
      stepCompleted(`generator-${TASK}`, '2026-05-09T10:01:00.000Z'),
    ];
    const trace: Trace = [{ elementName: `generator-${TASK}`, status: 'completed', durationMs: 10 }];
    const aiSignal: HarnessSignal = {
      type: 'commit-message',
      subject: 'feat: add login form',
      body: 'Add a basic email + password form.',
      timestamp: '2026-05-09T10:00:30.000Z' as never,
    };
    const result = bucketTaskSignals(trace, events, [aiSignal]);
    const commitRows = result.tasks[0]?.signals.filter((s) => s.type === 'commit-message') ?? [];
    expect(commitRows).toHaveLength(1);
    expect(commitRows[0]?.type === 'commit-message' ? commitRows[0].subject : undefined).toBe('feat: add login form');
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

  it('carries genEvalMaxAttempts onto each bucket when maxAttempts is supplied', () => {
    const trace: Trace = [{ elementName: `generator-${TASK}`, status: 'completed', durationMs: 1 }];
    const result = bucketTaskSignals(trace, [], [], { maxTurns: 3, maxAttempts: 3 });
    expect(result.tasks[0]?.genEvalMaxAttempts).toBe(3);
  });

  it('omits genEvalMaxAttempts when maxAttempts is absent', () => {
    const trace: Trace = [{ elementName: `generator-${TASK}`, status: 'completed', durationMs: 1 }];
    const result = bucketTaskSignals(trace, [], [], { maxTurns: 3 });
    expect(result.tasks[0]?.genEvalMaxAttempts).toBeUndefined();
  });
});

describe('perAttemptRound — fold the monotonic round into per-attempt coordinates', () => {
  it('maps attempt-1 rounds onto themselves (no overshoot when within budget)', () => {
    expect(perAttemptRound(1, 3)).toEqual({ attemptN: 1, roundInAttempt: 1 });
    expect(perAttemptRound(3, 3)).toEqual({ attemptN: 1, roundInAttempt: 3 });
  });

  it('folds the first round of attempt 2 back to round 1 instead of overshooting (4/3 → 1/3)', () => {
    // The bug: global round 4 against a 3-turn budget read `round 4/3`. The fold maps it to
    // attempt 2, round 1.
    expect(perAttemptRound(4, 3)).toEqual({ attemptN: 2, roundInAttempt: 1 });
    expect(perAttemptRound(6, 3)).toEqual({ attemptN: 2, roundInAttempt: 3 });
    expect(perAttemptRound(7, 3)).toEqual({ attemptN: 3, roundInAttempt: 1 });
  });

  it('keeps a single-turn budget at attempt 1 round 1 for the first global round', () => {
    expect(perAttemptRound(1, 1)).toEqual({ attemptN: 1, roundInAttempt: 1 });
    expect(perAttemptRound(2, 1)).toEqual({ attemptN: 2, roundInAttempt: 1 });
  });

  it('never lets roundInAttempt exceed maxTurns (the never-overshoot invariant)', () => {
    for (let round = 1; round <= 30; round += 1) {
      const { roundInAttempt } = perAttemptRound(round, 3);
      expect(roundInAttempt).toBeGreaterThanOrEqual(1);
      expect(roundInAttempt).toBeLessThanOrEqual(3);
    }
  });

  it('collapses defensively to attempt 1 for a non-positive or non-finite maxTurns', () => {
    expect(perAttemptRound(4, 0)).toEqual({ attemptN: 1, roundInAttempt: 4 });
    expect(perAttemptRound(4, Number.NaN)).toEqual({ attemptN: 1, roundInAttempt: 4 });
  });

  it('returns attempt 1 round 1 when no round has happened yet', () => {
    expect(perAttemptRound(0, 3)).toEqual({ attemptN: 1, roundInAttempt: 1 });
  });
});

describe('resolveAttemptCoords — prefer live tracker coords, fall back to the division heuristic', () => {
  it('uses the live tracker-sourced attemptN/roundInAttempt when present (winning over the fallback)', () => {
    // Live coords say attempt 2 / round 1 even though the division heuristic of the same global
    // round (2) against a 5-turn budget would wrongly read attempt 1 / round 2.
    expect(resolveAttemptCoords({ genEvalRound: 2, genEvalMaxRounds: 5, attemptN: 2, roundInAttempt: 1 })).toEqual({
      attemptN: 2,
      roundInAttempt: 1,
    });
    // Sanity: the heuristic on its own would have been wrong here.
    expect(perAttemptRound(2, 5)).toEqual({ attemptN: 1, roundInAttempt: 2 });
  });

  it('falls back to perAttemptRound when no live coords but a maxTurns cap is known', () => {
    expect(resolveAttemptCoords({ genEvalRound: 4, genEvalMaxRounds: 3 })).toEqual({
      attemptN: 2,
      roundInAttempt: 1,
    });
  });

  it('returns undefined when neither live coords nor a maxTurns cap is available', () => {
    expect(resolveAttemptCoords({ genEvalRound: 2 })).toBeUndefined();
  });

  it('ignores a lone attemptN with no roundInAttempt and falls back to the heuristic', () => {
    expect(resolveAttemptCoords({ genEvalRound: 3, genEvalMaxRounds: 3, attemptN: 1 })).toEqual({
      attemptN: 1,
      roundInAttempt: 3,
    });
  });
});
