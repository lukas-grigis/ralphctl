/**
 * TasksPanel — per-attempt round display in the active-task header (audit L4).
 *
 * `TaskBucket.genEvalRound` is monotonic across the whole task (the on-disk `rounds/` dir is
 * shared by every attempt), while `genEvalMaxRounds` (`maxTurns`) caps a single attempt. Rendering
 * the raw ratio overshoots on a 2nd+ attempt — e.g. global round 4 with a 3-turn budget read
 * `round 4/3`. The row must fold the round into its per-attempt window and surface the attempt
 * counter so the operator sees `attempt 2/3 · round 1/3`, never `round 4/3`.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';

const bucket = (overrides: Partial<BucketedExecution['tasks'][number]>): BucketedExecution => ({
  tasks: [
    {
      id: 'task-1',
      status: 'running',
      subSteps: [],
      evaluations: [],
      signals: [],
      genEvalRound: 1,
      ...overrides,
    },
  ],
  orphanSignals: [],
});

describe('TasksPanel per-attempt round', () => {
  it('shows "attempt 2/3 · round 1/3" on a 2nd attempt instead of overshooting to "round 4/3"', () => {
    // Global round 4, 3-turn budget, 3-attempt cap → attempt 2, round 1.
    const r = render(
      <TasksPanel bucketed={bucket({ genEvalRound: 4, genEvalMaxRounds: 3, genEvalMaxAttempts: 3 })} running={true} />
    );
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('attempt 2/3');
    expect(frame).toContain('round 1/3');
    expect(frame).not.toContain('round 4/3');
    r.unmount();
  });

  it('keeps a clean "round 1/1" for a single-attempt single-turn config (no attempt counter)', () => {
    const r = render(
      <TasksPanel bucketed={bucket({ genEvalRound: 1, genEvalMaxRounds: 1, genEvalMaxAttempts: 1 })} running={true} />
    );
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('round 1/1');
    // The attempt COUNTER ("attempt 1") must be absent — the first-run "waiting for first
    // attempt…" line is unrelated prose and is matched out with a number-anchored pattern.
    expect(frame).not.toMatch(/attempt \d/);
    r.unmount();
  });

  it('omits the attempt counter on attempt 1 even when the attempt cap is unknown', () => {
    // genEvalMaxAttempts undefined, still attempt 1 → bare round line.
    const r = render(<TasksPanel bucketed={bucket({ genEvalRound: 2, genEvalMaxRounds: 5 })} running={true} />);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('round 2/5');
    expect(frame).not.toMatch(/attempt \d/);
    r.unmount();
  });

  it('renders the attempt counter without a cap when maxAttempts is unknown on a 2nd attempt', () => {
    // Global round 5 with a 2-turn budget → attempt 3, round 1; cap unknown → "attempt 3" only.
    const r = render(<TasksPanel bucketed={bucket({ genEvalRound: 5, genEvalMaxRounds: 2 })} running={true} />);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('attempt 3');
    expect(frame).toContain('round 1/2');
    expect(frame).not.toContain('round 5/2');
    r.unmount();
  });

  it('falls back to a bare round when no per-attempt cap is known (cannot overshoot)', () => {
    const r = render(<TasksPanel bucketed={bucket({ genEvalRound: 3 })} running={true} />);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('round 3');
    expect(frame).not.toContain('round 3/');
    r.unmount();
  });
});
