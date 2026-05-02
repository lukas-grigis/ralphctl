import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { TaskExecutionGrid, sortByDepth, type TaskGridItem } from './task-execution-grid.tsx';
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';

const NOW = '2026-05-01T00:00:00.000Z' as IsoTimestamp;

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

// ── sortByDepth ───────────────────────────────────────────────────────────────

describe('sortByDepth', () => {
  it('returns root tasks first when all independent', () => {
    const tasks = [task('c', 'C'), task('a', 'A'), task('b', 'B')];
    const sorted = sortByDepth(tasks);
    // All depth 0, sorted by id
    expect(sorted.map((t) => t.id)).toStrictEqual(['a', 'b', 'c']);
  });

  it('puts dependents after their deps', () => {
    const tasks = [task('t2', 'T2', 'todo', ['t1']), task('t1', 'T1')];
    const sorted = sortByDepth(tasks);
    const ids = sorted.map((t) => t.id);
    expect(ids.indexOf('t1')).toBeLessThan(ids.indexOf('t2'));
  });

  it('handles multi-level chains', () => {
    const tasks = [task('t3', 'T3', 'todo', ['t2']), task('t1', 'T1'), task('t2', 'T2', 'todo', ['t1'])];
    const sorted = sortByDepth(tasks);
    const ids = sorted.map((t) => t.id);
    expect(ids[0]).toBe('t1');
    expect(ids[1]).toBe('t2');
    expect(ids[2]).toBe('t3');
  });

  it('falls back to insertion order on cyclic deps (no crash)', () => {
    const tasks = [task('a', 'A', 'todo', ['b']), task('b', 'B', 'todo', ['a'])];
    // Must not throw
    expect(() => sortByDepth(tasks)).not.toThrow();
    const sorted = sortByDepth(tasks);
    // Returns the same count
    expect(sorted.length).toBe(2);
  });
});

// ── TaskExecutionGrid rendering ───────────────────────────────────────────────

describe('TaskExecutionGrid', () => {
  it('renders null when tasks is null', () => {
    const { lastFrame } = render(<TaskExecutionGrid tasks={null} taskNameLookup={null} taskSignals={null} />);
    // Should render nothing meaningful
    expect(lastFrame()?.trim() ?? '').toBe('');
  });

  it('renders one card per task', () => {
    const tasks = [task('t1', 'First task'), task('t2', 'Second task')];
    const { lastFrame } = render(<TaskExecutionGrid tasks={tasks} taskNameLookup={null} taskSignals={null} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('First task');
    expect(frame).toContain('Second task');
  });

  it('shows status pill and truncated id', () => {
    const tasks = [task('abc123456789', 'My task', 'in_progress')];
    const { lastFrame } = render(<TaskExecutionGrid tasks={tasks} taskNameLookup={null} taskSignals={null} />);
    const frame = lastFrame() ?? '';
    // id slice (first 8)
    expect(frame).toContain('abc12345');
    // status label
    expect(frame).toContain('IN PROGRESS');
  });

  it('shows done status with phaseDone glyph', () => {
    const tasks = [task('t1', 'Done task', 'done')];
    const { lastFrame } = render(<TaskExecutionGrid tasks={tasks} taskNameLookup={null} taskSignals={null} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('DONE');
    expect(frame).toContain('■');
  });

  it('shows blocked status with cross glyph', () => {
    const tasks = [{ ...task('t1', 'Blocked task', 'blocked'), blockedReason: 'wrong branch' }];
    const { lastFrame } = render(<TaskExecutionGrid tasks={tasks} taskNameLookup={null} taskSignals={null} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('BLOCKED');
    expect(frame).toContain('✗');
    expect(frame).toContain('wrong branch');
  });

  it('renders depends-on line when blockedBy is non-empty', () => {
    const tasks = [task('t1', 'Root'), task('t2', 'Child', 'todo', ['t1'])];
    const { lastFrame } = render(<TaskExecutionGrid tasks={tasks} taskNameLookup={null} taskSignals={null} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('depends on');
  });

  it('uses task name from lookup in depends-on line', () => {
    const tasks = [task('t1', 'Root task'), task('t2', 'Child task', 'todo', ['t1'])];
    const lookup = new Map([['t1', 'Root task']]);
    const { lastFrame } = render(<TaskExecutionGrid tasks={tasks} taskNameLookup={lookup} taskSignals={null} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Root task');
  });

  it('shows activity line from signal', () => {
    const tasks = [task('t1', 'My task', 'in_progress')];
    const signal: HarnessSignal = { type: 'progress', summary: 'writing tests', files: [], timestamp: NOW };
    const signals = new Map<string, HarnessSignal>([['t1', signal]]);
    const { lastFrame } = render(<TaskExecutionGrid tasks={tasks} taskNameLookup={null} taskSignals={signals} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('writing tests');
  });

  it('no activity line when signal map is null (graceful degrade)', () => {
    const tasks = [task('t1', 'My task', 'in_progress')];
    const { lastFrame } = render(<TaskExecutionGrid tasks={tasks} taskNameLookup={null} taskSignals={null} />);
    const frame = lastFrame() ?? '';
    // Should not crash and should render the task name
    expect(frame).toContain('My task');
  });

  it('renders dependent task after its root (depth ordering)', () => {
    const tasks = [task('t2', 'Child task', 'todo', ['t1']), task('t1', 'Root task')];
    const { lastFrame } = render(<TaskExecutionGrid tasks={tasks} taskNameLookup={null} taskSignals={null} />);
    const frame = lastFrame() ?? '';
    const rootPos = frame.indexOf('Root task');
    const childPos = frame.indexOf('Child task');
    expect(rootPos).toBeLessThan(childPos);
  });

  it('does not crash on cyclic deps', () => {
    const tasks = [task('a', 'A', 'todo', ['b']), task('b', 'B', 'todo', ['a'])];
    expect(() => render(<TaskExecutionGrid tasks={tasks} taskNameLookup={null} taskSignals={null} />)).not.toThrow();
  });

  it('shows note signal activity', () => {
    const tasks = [task('t1', 'My task', 'in_progress')];
    const signal: HarnessSignal = { type: 'note', text: 'Checking dependencies', timestamp: NOW };
    const signals = new Map<string, HarnessSignal>([['t1', signal]]);
    const { lastFrame } = render(<TaskExecutionGrid tasks={tasks} taskNameLookup={null} taskSignals={signals} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('note: Checking dependencies');
  });
});
