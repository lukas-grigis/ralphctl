import { describe, expect, it } from 'vitest';
import { pickTasksToLaunch } from '@src/ai/executor.ts';
import type { Task } from '@src/schemas/index.ts';

function makeTask(id: string, projectPath: string, order: number): Task {
  return { id, projectPath, order } as Task;
}

describe('pickTasksToLaunch', () => {
  it('returns empty array when there are no ready tasks', () => {
    const result = pickTasksToLaunch([], new Set(), 5, 0);
    expect(result).toEqual([]);
  });

  it('filters out tasks whose projectPath is already in-flight', () => {
    const tasks = [makeTask('t1', '/repo/a', 1), makeTask('t2', '/repo/b', 2)];
    const inFlight = new Set(['/repo/a']);
    const result = pickTasksToLaunch(tasks, inFlight, 5, 1);
    expect(result).toHaveLength(1);
    expect(result.at(0)?.id).toBe('t2');
  });

  it('deduplicates by projectPath and picks the first-encountered task per repo', () => {
    const tasks = [
      makeTask('t1-first', '/repo/a', 3),
      makeTask('t1-second', '/repo/a', 1),
      makeTask('t2', '/repo/b', 2),
    ];
    const result = pickTasksToLaunch(tasks, new Set(), 5, 0);
    const ids = result.map((t) => t.id);
    // First task for /repo/a wins regardless of order value
    expect(ids).toContain('t1-first');
    expect(ids).not.toContain('t1-second');
    expect(ids).toContain('t2');
  });

  it('respects the concurrency limit', () => {
    const tasks = [makeTask('t1', '/repo/a', 1), makeTask('t2', '/repo/b', 2), makeTask('t3', '/repo/c', 3)];
    // limit=2, nothing in-flight → only 2 returned
    const result = pickTasksToLaunch(tasks, new Set(), 2, 0);
    expect(result).toHaveLength(2);
  });

  it('accounts for currentInFlight when computing available slots', () => {
    const tasks = [makeTask('t1', '/repo/a', 1), makeTask('t2', '/repo/b', 2), makeTask('t3', '/repo/c', 3)];
    // limit=3, already 2 in-flight → 1 slot available
    const result = pickTasksToLaunch(tasks, new Set(), 3, 2);
    expect(result).toHaveLength(1);
  });

  it('returns only one task when all tasks share the same projectPath', () => {
    const tasks = [makeTask('t1', '/repo/a', 2), makeTask('t2', '/repo/a', 1), makeTask('t3', '/repo/a', 3)];
    const result = pickTasksToLaunch(tasks, new Set(), 10, 0);
    expect(result).toHaveLength(1);
    // First task in array wins (t1 is first, regardless of order value)
    expect(result.at(0)?.id).toBe('t1');
  });

  it('returns first N tasks by iteration order when unique repos exceed concurrency limit', () => {
    const tasks = [
      makeTask('t1', '/repo/a', 1),
      makeTask('t2', '/repo/b', 2),
      makeTask('t3', '/repo/c', 3),
      makeTask('t4', '/repo/d', 4),
    ];
    const result = pickTasksToLaunch(tasks, new Set(), 2, 0);
    expect(result).toHaveLength(2);
    // First two unique repos encountered: /repo/a and /repo/b
    expect(result.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('returns empty when concurrencyLimit is 0', () => {
    const tasks = [makeTask('t1', '/repo/a', 1)];
    const result = pickTasksToLaunch(tasks, new Set(), 0, 0);
    expect(result).toEqual([]);
  });

  it('returns empty when currentInFlight equals concurrencyLimit', () => {
    const tasks = [makeTask('t1', '/repo/a', 1)];
    const result = pickTasksToLaunch(tasks, new Set(), 3, 3);
    expect(result).toEqual([]);
  });

  it('returns empty when currentInFlight exceeds concurrencyLimit', () => {
    const tasks = [makeTask('t1', '/repo/a', 1)];
    const result = pickTasksToLaunch(tasks, new Set(), 2, 5);
    expect(result).toEqual([]);
  });

  it('excludes tasks whose projectPath is in failedPaths', () => {
    const tasks = [makeTask('t1', '/repo/a', 1), makeTask('t2', '/repo/b', 2), makeTask('t3', '/repo/c', 3)];
    const failedPaths = new Set(['/repo/a', '/repo/c']);
    const result = pickTasksToLaunch(tasks, new Set(), 5, 0, failedPaths);
    expect(result).toHaveLength(1);
    expect(result.at(0)?.id).toBe('t2');
  });

  it('returns all tasks when failedPaths is empty', () => {
    const tasks = [makeTask('t1', '/repo/a', 1), makeTask('t2', '/repo/b', 2)];
    const result = pickTasksToLaunch(tasks, new Set(), 5, 0, new Set());
    expect(result).toHaveLength(2);
  });

  it('returns empty when all tasks are in failedPaths', () => {
    const tasks = [makeTask('t1', '/repo/a', 1), makeTask('t2', '/repo/b', 2)];
    const failedPaths = new Set(['/repo/a', '/repo/b']);
    const result = pickTasksToLaunch(tasks, new Set(), 5, 0, failedPaths);
    expect(result).toEqual([]);
  });
});
