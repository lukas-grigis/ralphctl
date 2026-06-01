/**
 * Windowing fence for TasksPanel. With 3-4+ tasks the middle column previously mapped the whole
 * task array and grew unbounded, pushing the Recent-log + footer off-screen. The panel now
 * renders an anchored window of `maxTasks` cards centred on the active card, with "N more
 * above / below" cues for the hidden remainder. These tests pin that behaviour.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution, TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';

// Six tasks: indices 0-3 settled (completed), 4 the active (running) task, 5 still queued.
// `activeTaskIdx` = first non-completed = 4, which is where the window anchors.
const buildFixture = (): { bucketed: BucketedExecution; nameById: Map<string, string> } => {
  const nameById = new Map<string, string>();
  const tasks: TaskBucket[] = Array.from({ length: 6 }, (_unused, i) => {
    const id = `01933fbb-0000-7000-8000-${String(i).padStart(12, '0')}`;
    nameById.set(id, `T${String(i)}X`);
    return {
      id,
      status: i < 4 ? 'completed' : 'running',
      subSteps: [],
      evaluations: [],
      signals: [],
      genEvalRound: 0,
    } satisfies TaskBucket;
  });
  return { bucketed: { tasks, orphanSignals: [] }, nameById };
};

describe('TasksPanel windowing', () => {
  it('renders only the budgeted cards, anchored on the active task, with an "N more above" cue', () => {
    const { bucketed, nameById } = buildFixture();
    // maxTasks=3, anchor at active idx 4 → window [3,6): cards T3X, T4X, T5X; T0X-T2X hidden.
    const r = render(<TasksPanel bucketed={bucketed} running={true} nameById={nameById} maxTasks={3} />);
    const frame = r.lastFrame() ?? '';

    // The active card and its in-window neighbours are visible.
    expect(frame).toContain('T3X');
    expect(frame).toContain('T4X');
    expect(frame).toContain('T5X');
    // The settled cards that fell out of the window are hidden behind the cue.
    expect(frame).not.toContain('T0X');
    expect(frame).not.toContain('T1X');
    expect(frame).not.toContain('T2X');
    // Overflow cue reports the hidden count; nothing is hidden below (window reaches the end).
    expect(frame).toContain('3 more above');
    expect(frame).not.toContain('more below');

    r.unmount();
  });

  it('renders every card with no cues when the budget meets or exceeds the task count', () => {
    const { bucketed, nameById } = buildFixture();
    const r = render(<TasksPanel bucketed={bucketed} running={true} nameById={nameById} maxTasks={10} />);
    const frame = r.lastFrame() ?? '';

    for (let i = 0; i < 6; i++) expect(frame).toContain(`T${String(i)}X`);
    expect(frame).not.toContain('more above');
    expect(frame).not.toContain('more below');

    r.unmount();
  });

  it('is unbounded when no maxTasks is supplied (isolated-render parity)', () => {
    const { bucketed, nameById } = buildFixture();
    const r = render(<TasksPanel bucketed={bucketed} running={true} nameById={nameById} />);
    const frame = r.lastFrame() ?? '';

    for (let i = 0; i < 6; i++) expect(frame).toContain(`T${String(i)}X`);
    expect(frame).not.toContain('more above');
    expect(frame).not.toContain('more below');

    r.unmount();
  });
});
