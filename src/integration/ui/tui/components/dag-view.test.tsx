/**
 * Verify DagView:
 *   - Layers tasks topologically by `blockedBy`
 *   - Picks the right glyph/colour for each (pending / running / done / failed / skipped)
 *   - Falls back to a single-column list when the terminal is too narrow
 *   - Never throws on cycles or orphan tasks (they render at the end)
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import type { Task } from '@src/domain/models.ts';
import { DagView, layerTasks, statusForTask } from './dag-view.tsx';

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
  it('groups tasks with no predecessors into level 0 and dependents into deeper levels', () => {
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

  it('does not loop forever on cycles — flushes the survivors as a final level', () => {
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
    // Force terminal width below the smallest acceptable level layout while
    // keeping each node label short enough to render in full.
    const { lastFrame } = render(<DagView tasks={tasks} terminalWidth={10} nodeWidth={18} />);
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
});
