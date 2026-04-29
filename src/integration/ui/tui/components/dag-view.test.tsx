/**
 * Verify DagView:
 *   - Layers tasks topologically by `blockedBy`
 *   - Picks the right glyph/colour for each (pending / running / done / failed / skipped)
 *   - Falls back to a single-column list when the terminal is too narrow
 *   - Never throws on cycles or orphan tasks (they render at the end)
 *   - Trailing waves collapse to a "+N more" summary when the section runs
 *     out of vertical room (so the surrounding layout never overflows)
 *   - Node width grows with terminal width so labels are readable on wide
 *     terminals instead of being chopped to ~16 chars
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import type { Task } from '@src/domain/models.ts';
import { DagView, computeNodeWidth, layerTasks, statusForTask } from './dag-view.tsx';

function makeTask(overrides: Partial<Task> & Pick<Task, 'id' | 'name' | 'order'>): Task {
  return {
    description: undefined,
    steps: [],
    verificationCriteria: [],
    status: 'todo',
    ticketId: undefined,
    blockedBy: [],
    repoId: 'repo-1',
    verified: false,
    verificationOutput: undefined,
    evaluated: false,
    evaluationOutput: undefined,
    evaluationStatus: undefined,
    evaluationFile: undefined,
    extraDimensions: undefined,
    ...overrides,
  };
}

describe('layerTasks', () => {
  it('groups tasks with no predecessors into wave 0 and dependents into deeper waves', () => {
    const a = makeTask({ id: 'a', name: 'A', order: 1 });
    const b = makeTask({ id: 'b', name: 'B', order: 2, blockedBy: ['a'] });
    const c = makeTask({ id: 'c', name: 'C', order: 3, blockedBy: ['b'] });
    const d = makeTask({ id: 'd', name: 'D', order: 4 });
    const layers = layerTasks([a, b, c, d]);
    expect(layers.length).toBe(3);
    expect(layers[0]?.map((t) => t.id).sort()).toEqual(['a', 'd']);
    expect(layers[1]?.map((t) => t.id)).toEqual(['b']);
    expect(layers[2]?.map((t) => t.id)).toEqual(['c']);
  });

  it('does not loop forever on cycles — flushes the survivors as a final wave', () => {
    const a = makeTask({ id: 'a', name: 'A', order: 1, blockedBy: ['b'] });
    const b = makeTask({ id: 'b', name: 'B', order: 2, blockedBy: ['a'] });
    const layers = layerTasks([a, b]);
    expect(layers).toHaveLength(1);
    expect(layers[0]?.map((t) => t.id).sort()).toEqual(['a', 'b']);
  });
});

describe('statusForTask', () => {
  it('marks failed first, then skipped, then done, then blocked, then running, then pending', () => {
    const t = makeTask({ id: 't', name: 'T', order: 1 });
    expect(statusForTask(t, new Set(), new Set(['t']), new Set())).toBe('failed');
    expect(statusForTask({ ...t, status: 'skipped' }, new Set(), new Set(), new Set())).toBe('skipped');
    expect(statusForTask({ ...t, status: 'done' }, new Set(), new Set(), new Set())).toBe('done');
    expect(statusForTask(t, new Set(), new Set(), new Set(['t']))).toBe('blocked');
    expect(statusForTask(t, new Set(['t']), new Set(), new Set())).toBe('running');
    expect(statusForTask({ ...t, status: 'in_progress' }, new Set(), new Set(), new Set())).toBe('running');
    expect(statusForTask(t, new Set(), new Set(), new Set())).toBe('pending');
  });
});

describe('computeNodeWidth', () => {
  it('returns the minimum width when the widest wave is empty', () => {
    expect(computeNodeWidth(120, 0)).toBe(16);
  });

  it('grows nodes when the terminal is wide and the widest wave is small', () => {
    // Widest wave of 1 task on a 120-col terminal — node should expand toward MAX_NODE_WIDTH (36).
    expect(computeNodeWidth(120, 1)).toBe(36);
  });

  it('packs more tasks per row by shrinking nodes only as needed', () => {
    // Widest wave of 5 on a 120-col terminal (~120/5 = 24/node before gutter).
    const w = computeNodeWidth(120, 5);
    expect(w).toBeGreaterThanOrEqual(16);
    expect(w).toBeLessThanOrEqual(36);
  });

  it('clamps to the minimum on very narrow terminals', () => {
    expect(computeNodeWidth(10, 5)).toBe(16);
  });
});

describe('DagView', () => {
  it('renders each task name in the frame', () => {
    const tasks = [
      makeTask({ id: 'a', name: 'Alpha', order: 1 }),
      makeTask({ id: 'b', name: 'Bravo', order: 2, blockedBy: ['a'] }),
    ];
    const { lastFrame } = render(<DagView tasks={tasks} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Alpha');
    expect(frame).toContain('Bravo');
  });

  it('renders a labelled wave separator for each wave', () => {
    const tasks = [
      makeTask({ id: 'a', name: 'Alpha', order: 1 }),
      makeTask({ id: 'b', name: 'Bravo', order: 2, blockedBy: ['a'] }),
    ];
    const { lastFrame } = render(<DagView tasks={tasks} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('wave 1');
    expect(frame).toContain('wave 2');
  });

  it('summarises wave progress (running / done / failed counts) in the separator', () => {
    const tasks = [
      makeTask({ id: 'a', name: 'Alpha', order: 1, status: 'done' }),
      makeTask({ id: 'b', name: 'Bravo', order: 2 }),
    ];
    const { lastFrame } = render(<DagView tasks={tasks} runningTaskIds={new Set(['b'])} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1 done');
    expect(frame).toContain('1 running');
  });

  it('shows the empty-state hint when there are no tasks', () => {
    const { lastFrame } = render(<DagView tasks={[]} />);
    expect(lastFrame() ?? '').toContain('No tasks');
  });

  it('degrades gracefully on tiny terminals — single-column with a hint, names truncated to fit', () => {
    const tasks = [
      makeTask({ id: 'a', name: 'A', order: 1 }),
      makeTask({ id: 'b', name: 'B', order: 2 }),
      makeTask({ id: 'c', name: 'C', order: 3 }),
    ];
    const { lastFrame } = render(<DagView tasks={tasks} terminalWidth={10} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('graph compressed');
    expect(frame).toContain('widen the terminal');
    expect(frame).toContain('A');
    expect(frame).toContain('B');
    expect(frame).toContain('C');
  });

  it('renders a done task with a check glyph', () => {
    const tasks = [makeTask({ id: 'a', name: 'Alpha', order: 1, status: 'done' })];
    const { lastFrame } = render(<DagView tasks={tasks} />);
    expect(lastFrame() ?? '').toContain('✓');
  });

  it('renders a failed task with a cross glyph when the failed set carries the id', () => {
    const tasks = [makeTask({ id: 'a', name: 'Alpha', order: 1 })];
    const { lastFrame } = render(<DagView tasks={tasks} failedTaskIds={new Set(['a'])} />);
    expect(lastFrame() ?? '').toContain('✗');
  });

  it('collapses trailing waves with a "+N more" summary when the row budget is exceeded', () => {
    // 8 chained tasks, each in its own wave. With maxRows=6 only the first
    // ~3 waves (each ~2 rows: separator + node) fit; the rest collapse.
    const tasks: Task[] = [];
    for (let i = 0; i < 8; i++) {
      const id = `t${String(i)}`;
      const blockedBy = i === 0 ? [] : [`t${String(i - 1)}`];
      tasks.push(makeTask({ id, name: `Task ${String(i)}`, order: i + 1, blockedBy }));
    }
    const { lastFrame } = render(<DagView tasks={tasks} terminalWidth={120} maxRows={6} />);
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/\+?\d+\s*more wave/);
  });
});
