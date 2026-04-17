/**
 * TaskGrid tests — ensures the grid correctly reflects runtime state
 * (done/running/blocked) via status icons, and surfaces task-level activity
 * when a progress signal has been observed.
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import type { Task } from '@src/domain/models.ts';
import { TaskGrid } from './task-grid.tsx';

function task(overrides: Partial<Task>): Task {
  return {
    id: 't1',
    name: 'Task one',
    steps: [],
    verificationCriteria: [],
    status: 'todo',
    order: 1,
    blockedBy: [],
    projectPath: '/tmp/repo',
    verified: false,
    evaluated: false,
    ...overrides,
  };
}

describe('TaskGrid', () => {
  it('renders one row per task with the task name', () => {
    const tasks = [task({ id: 'a', name: 'Alpha' }), task({ id: 'b', name: 'Bravo' })];
    const { lastFrame } = render(
      <TaskGrid
        tasks={tasks}
        runningTaskIds={new Set()}
        blockedTaskIds={new Set()}
        activityByTask={new Map()}
      />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Alpha');
    expect(frame).toContain('Bravo');
  });

  it('marks done tasks with a check', () => {
    const tasks = [task({ id: 'a', name: 'Alpha', status: 'done' })];
    const { lastFrame } = render(
      <TaskGrid
        tasks={tasks}
        runningTaskIds={new Set()}
        blockedTaskIds={new Set()}
        activityByTask={new Map()}
      />
    );
    expect(lastFrame() ?? '').toContain('✓');
  });

  it('marks running tasks with an arrow', () => {
    const tasks = [task({ id: 'a', name: 'Alpha' })];
    const { lastFrame } = render(
      <TaskGrid
        tasks={tasks}
        runningTaskIds={new Set(['a'])}
        blockedTaskIds={new Set()}
        activityByTask={new Map()}
      />
    );
    expect(lastFrame() ?? '').toContain('▸');
  });

  it('shows an activity line under the task when progress has arrived', () => {
    const tasks = [task({ id: 'a', name: 'Alpha' })];
    const { lastFrame } = render(
      <TaskGrid
        tasks={tasks}
        runningTaskIds={new Set(['a'])}
        blockedTaskIds={new Set()}
        activityByTask={new Map([['a', 'wrote index.ts']])}
      />
    );
    expect(lastFrame() ?? '').toContain('wrote index.ts');
  });

  it('renders an empty-state message when there are no tasks', () => {
    const { lastFrame } = render(
      <TaskGrid
        tasks={[]}
        runningTaskIds={new Set()}
        blockedTaskIds={new Set()}
        activityByTask={new Map()}
      />
    );
    expect(lastFrame() ?? '').toContain('No tasks');
  });
});
