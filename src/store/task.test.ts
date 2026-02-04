import { describe, expect, it } from 'vitest';
import { DependencyCycleError, topologicalSort, validateImportTasks } from './task.ts';
import type { Task } from '@src/schemas/index.ts';

function createTask(id: string, blockedBy: string[] = []): Task {
  return {
    id,
    name: `Task ${id}`,
    description: undefined,
    steps: [],
    status: 'todo',
    order: 1,
    ticketId: undefined,
    blockedBy,
    projectPath: '/tmp/test',
    verified: false,
  };
}

describe('topologicalSort', () => {
  it('sorts independent tasks by original order', () => {
    const tasks = [createTask('a'), createTask('b'), createTask('c')];
    const sorted = topologicalSort(tasks);
    expect(sorted.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('puts dependencies before dependents', () => {
    const tasks = [createTask('c', ['b']), createTask('b', ['a']), createTask('a')];
    const sorted = topologicalSort(tasks);
    expect(sorted.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('handles diamond dependencies', () => {
    // d depends on b and c, both depend on a
    const tasks = [createTask('d', ['b', 'c']), createTask('c', ['a']), createTask('b', ['a']), createTask('a')];
    const sorted = topologicalSort(tasks);
    const ids = sorted.map((t) => t.id);

    // a must come before b and c
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('c'));
    // b and c must come before d
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('d'));
    expect(ids.indexOf('c')).toBeLessThan(ids.indexOf('d'));
  });

  it('detects simple cycle', () => {
    const tasks = [createTask('a', ['b']), createTask('b', ['a'])];
    expect(() => topologicalSort(tasks)).toThrow(DependencyCycleError);
  });

  it('detects three-node cycle', () => {
    const tasks = [createTask('a', ['c']), createTask('b', ['a']), createTask('c', ['b'])];
    expect(() => topologicalSort(tasks)).toThrow(DependencyCycleError);
  });

  it('detects self-referencing task', () => {
    const tasks = [createTask('a', ['a'])];
    expect(() => topologicalSort(tasks)).toThrow(DependencyCycleError);
  });

  it('handles empty task list', () => {
    const sorted = topologicalSort([]);
    expect(sorted).toEqual([]);
  });

  it('handles tasks with non-existent dependencies gracefully', () => {
    // blockedBy references non-existent task - should just ignore
    const tasks = [createTask('a', ['nonexistent'])];
    const sorted = topologicalSort(tasks);
    expect(sorted.map((t) => t.id)).toEqual(['a']);
  });
});

describe('validateImportTasks', () => {
  it('accepts valid import with no dependencies', () => {
    const importTasks = [{ name: 'Task 1' }, { name: 'Task 2' }];
    const errors = validateImportTasks(importTasks, []);
    expect(errors).toEqual([]);
  });

  it('accepts valid import with local ID references', () => {
    const importTasks = [
      { id: '1', name: 'First' },
      { id: '2', name: 'Second', blockedBy: ['1'] },
    ];
    const errors = validateImportTasks(importTasks, []);
    expect(errors).toEqual([]);
  });

  it('accepts import referencing existing tasks', () => {
    const existing = [createTask('existing-1')];
    const importTasks = [{ name: 'New', blockedBy: ['existing-1'] }];
    const errors = validateImportTasks(importTasks, existing);
    expect(errors).toEqual([]);
  });

  it('rejects reference to non-existent task', () => {
    const importTasks = [{ name: 'Task', blockedBy: ['nonexistent'] }];
    const errors = validateImportTasks(importTasks, []);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('does not exist');
  });

  it('rejects forward reference to later local task', () => {
    const importTasks = [
      { id: '1', name: 'First', blockedBy: ['2'] },
      { id: '2', name: 'Second' },
    ];
    const errors = validateImportTasks(importTasks, []);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('must reference an earlier task');
  });

  it('detects cycle in import tasks', () => {
    const importTasks = [
      { id: '1', name: 'First' },
      { id: '2', name: 'Second', blockedBy: ['3'] },
      { id: '3', name: 'Third', blockedBy: ['2'] },
    ];
    const errors = validateImportTasks(importTasks, []);
    // First error is forward reference, then cycle detection
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts valid chain through existing tasks', () => {
    // Existing task in the middle of a dependency chain
    const existing = [createTask('existing')];
    // Import tasks that depend on existing: new-2 -> new-1 -> existing
    const importTasks = [
      { id: 'new-1', name: 'New1', blockedBy: ['existing'] },
      { id: 'new-2', name: 'New2', blockedBy: ['new-1'] },
    ];
    const errors = validateImportTasks(importTasks, existing);
    expect(errors).toEqual([]);
  });
});
