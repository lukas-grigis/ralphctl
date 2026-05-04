import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { TaskExecutionGrid } from './task-execution-grid.tsx';
import type { TaskGridItem } from './task-grid-item.ts';

afterEach(() => {
  cleanup();
});

function task(
  id: string,
  name: string,
  status: TaskGridItem['status'] = 'todo',
  blockedBy: string[] = []
): TaskGridItem {
  return { id, name, status, blockedBy, projectPath: '/tmp/test' };
}

describe('TaskExecutionGrid', () => {
  it('renders null when tasks is null', () => {
    const { lastFrame } = render(<TaskExecutionGrid tasks={null} taskNameLookup={null} taskSignals={null} />);
    expect((lastFrame() ?? '').trim()).toBe('');
  });

  it('renders the section header and list when tasks are present', () => {
    const tasks = [task('a', 'AlphaName'), task('b', 'BetaName', 'todo', ['a'])];
    const { lastFrame } = render(<TaskExecutionGrid tasks={tasks} taskNameLookup={null} taskSignals={null} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Task execution');
    expect(frame).toContain('AlphaName');
    expect(frame).toContain('BetaName');
    expect(frame).toContain('TODO');
    // No graph box-drawing remains
    expect(frame).not.toContain('┌');
    expect(frame).not.toContain('▼');
  });
});
