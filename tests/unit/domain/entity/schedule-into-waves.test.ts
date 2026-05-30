import { describe, expect, it } from 'vitest';
import type { Task } from '@src/domain/entity/task.ts';
import { renderTaskGraphIssue, scheduleIntoWaves } from '@src/domain/entity/task-graph.ts';
import { makeTodoTask } from '@tests/fixtures/domain.ts';

/** Project a wave schedule to its task names for ergonomic structural assertions. */
const names = (waves: ReadonlyArray<readonly Task[]>): string[][] => waves.map((w) => w.map((t) => t.name));

describe('scheduleIntoWaves', () => {
  it('returns an empty schedule for empty input', () => {
    const r = scheduleIntoWaves([]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual([]);
  });

  it('schedules a single independent task into one wave', () => {
    const a = makeTodoTask({ name: 'a' });
    const r = scheduleIntoWaves([a]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(names(r.value)).toEqual([['a']]);
  });

  it('schedules independent tasks into one wide wave, order ASC', () => {
    const a = makeTodoTask({ name: 'a', order: 3 });
    const b = makeTodoTask({ name: 'b', order: 1 });
    const c = makeTodoTask({ name: 'c', order: 2 });
    const r = scheduleIntoWaves([a, b, c]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // one wave, sorted by Task.order ASC regardless of input order
    expect(names(r.value)).toEqual([['b', 'c', 'a']]);
  });

  it('schedules a linear chain into N singleton waves', () => {
    const a = makeTodoTask({ name: 'a', order: 1 });
    const b = makeTodoTask({ name: 'b', order: 2, dependsOn: [a.id] });
    const c = makeTodoTask({ name: 'c', order: 3, dependsOn: [b.id] });
    const r = scheduleIntoWaves([a, b, c]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(names(r.value)).toEqual([['a'], ['b'], ['c']]);
  });

  it('schedules a diamond into levels (root, middle pair, sink)', () => {
    const root = makeTodoTask({ name: 'root', order: 1 });
    const left = makeTodoTask({ name: 'left', order: 2, dependsOn: [root.id] });
    const right = makeTodoTask({ name: 'right', order: 3, dependsOn: [root.id] });
    const sink = makeTodoTask({ name: 'sink', order: 4, dependsOn: [left.id, right.id] });
    const r = scheduleIntoWaves([sink, right, left, root]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(names(r.value)).toEqual([['root'], ['left', 'right'], ['sink']]);
  });

  it('breaks within-wave ties by Task.order ASC', () => {
    const root = makeTodoTask({ name: 'root', order: 1 });
    // three children of root, deliberately out of order — same wave, must sort by order
    const x = makeTodoTask({ name: 'x', order: 30, dependsOn: [root.id] });
    const y = makeTodoTask({ name: 'y', order: 10, dependsOn: [root.id] });
    const z = makeTodoTask({ name: 'z', order: 20, dependsOn: [root.id] });
    const r = scheduleIntoWaves([root, x, y, z]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(names(r.value)).toEqual([['root'], ['y', 'z', 'x']]);
  });

  it('guarantees every dependency is scheduled in an earlier wave', () => {
    const a = makeTodoTask({ name: 'a', order: 1 });
    const b = makeTodoTask({ name: 'b', order: 2, dependsOn: [a.id] });
    const c = makeTodoTask({ name: 'c', order: 3, dependsOn: [a.id] });
    const d = makeTodoTask({ name: 'd', order: 4, dependsOn: [b.id, c.id] });
    const r = scheduleIntoWaves([d, c, b, a]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const waveIndexById = new Map<string, number>();
    r.value.forEach((wave, i) => wave.forEach((t) => waveIndexById.set(t.id, i)));
    for (const task of [a, b, c, d]) {
      for (const depId of task.dependsOn) {
        expect(waveIndexById.get(depId)!).toBeLessThan(waveIndexById.get(task.id)!);
      }
    }
  });

  it('propagates a self-edge issue', () => {
    const a = makeTodoTask({ name: 'a' });
    const broken: Task = { ...a, dependsOn: [a.id] };
    const r = scheduleIntoWaves([broken]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('self-edge');
  });

  it('propagates an unknown-dependency issue', () => {
    const a = makeTodoTask({ name: 'a' });
    const b = makeTodoTask({ name: 'b' });
    const broken: Task = { ...b, dependsOn: [a.id] };
    const r = scheduleIntoWaves([broken]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('unknown-dependency');
  });

  it('propagates a cycle issue', () => {
    const a = makeTodoTask({ name: 'a' });
    const b = makeTodoTask({ name: 'b' });
    const aE: Task = { ...a, dependsOn: [b.id] };
    const bE: Task = { ...b, dependsOn: [a.id] };
    const r = scheduleIntoWaves([aE, bE]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('cycle');
  });
});

describe('renderTaskGraphIssue', () => {
  it('renders each issue kind as a readable line', () => {
    const a = makeTodoTask({ name: 'a' });
    const b = makeTodoTask({ name: 'b' });
    expect(renderTaskGraphIssue({ kind: 'self-edge', task: a.id })).toContain('itself');
    expect(renderTaskGraphIssue({ kind: 'unknown-dependency', task: a.id, missing: b.id })).toContain('unknown');
    expect(renderTaskGraphIssue({ kind: 'cycle', cycle: [a.id, b.id, a.id] })).toContain('cycle');
  });
});
