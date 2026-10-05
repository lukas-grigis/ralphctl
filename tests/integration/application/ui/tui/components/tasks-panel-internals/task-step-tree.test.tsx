import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TaskStepTree } from '@src/application/ui/tui/components/tasks-panel-internals/task-step-tree.tsx';
import type { StepStatus, StepView } from '@src/application/ui/tui/runtime/flow-progress.ts';

const node = (label: string, status: StepStatus, extra: Partial<StepView> = {}): StepView => ({
  key: `${label}-${String(extra.iteration?.n ?? 0)}`,
  label,
  status,
  depth: 3,
  children: [],
  ...extra,
});

/** Prepare / Attempt (Verify baseline, N rounds, Verify, Commit) / Finish, as the projection emits it. */
const taskView = (rounds: number): StepView => ({
  ...node('Add flag', 'running', { depth: 2 }),
  leafCount: 20,
  children: [
    { ...node('Prepare', 'completed', { durationMs: 1000 }), leafCount: 4 },
    {
      ...node('Attempt', 'running', { iteration: { n: 1, max: 3 } }),
      leafCount: 12,
      children: [
        node('Verify baseline', 'completed', { depth: 4, durationMs: 62 }),
        ...Array.from({ length: rounds - 1 }, (_, i) => ({
          ...node('Round', 'completed', {
            depth: 4,
            iteration: { n: i + 1 },
            durationMs: 270,
            verdict: { status: 'failed' as const, dimensions: ['correctness'] },
          }),
          leafCount: 2,
        })),
        {
          ...node('Round', 'running', {
            depth: 4,
            iteration: { n: rounds, max: 5 },
            inline: [node('Generate', 'running', { depth: 5 }), node('Evaluate', 'pending', { depth: 5 })],
          }),
          leafCount: 2,
        },
        node('Verify', 'pending', { depth: 4 }),
        node('Commit', 'pending', { depth: 4 }),
      ],
    },
    node('Finish', 'pending', { leafCount: 3 }),
  ],
});

const frameOf = (view: StepView, maxRows: number): string => {
  const r = render(<TaskStepTree view={view} maxRows={maxRows} settled={false} running />);
  const out = r.lastFrame() ?? '';
  r.unmount();
  return out;
};

describe('TaskStepTree', () => {
  it('draws the attempt / round tree with verdict chips and an inline running round', () => {
    const frame = frameOf(taskView(2), 20);
    expect(frame).toContain('■ Prepare · 4 steps · 1.0s');
    expect(frame).toContain('◆ Attempt 1/3');
    expect(frame).toContain('■ Round 1 · 270ms · ✗ correctness');
    expect(frame).toMatch(/◆ Round 2\/5 · \S Generate · ◇ Evaluate/);
    expect(frame).toContain('◇ Finish');
  });

  it('indents relative to the shallowest row, not the absolute depth', () => {
    const lines = frameOf(taskView(2), 20).split('\n');
    expect(lines.find((l) => l.includes('Prepare'))).toMatch(/^ {2}■ Prepare/);
    expect(lines.find((l) => l.includes('Verify baseline'))).toMatch(/^ {4}■ Verify baseline/);
  });

  it('keeps the running round visible within a small row budget', () => {
    const frame = frameOf(taskView(8), 6);
    expect(frame).toMatch(/Round 8\/5/);
    expect(frame.split('\n').length).toBeLessThanOrEqual(6);
  });
});
