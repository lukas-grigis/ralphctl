/**
 * T3 — implement-launch human-gate (audit §5). Drives `resolveImplementQueue`, the pure seam
 * extracted from `launchImplement`:
 *  - a cyclic / dangling graph FAILS FAST with the rendered `TaskGraphIssue` (never a silent
 *    deadlock surfacing later as an empty "No tasks to implement" queue);
 *  - a valid graph yields a queue that honours `dependsOn` ordering;
 *  - an in-progress (resumed) task still leads, with dependency order preserved within each
 *    status group.
 */

import { describe, expect, it } from 'vitest';
import type { InProgressTask, Task, TodoTask } from '@src/domain/entity/task.ts';
import { startNextAttempt } from '@src/domain/entity/task-attempts.ts';
import { resolveImplementQueue } from '@src/application/ui/shared/launch/implement.ts';
import { FIXED_NOW, makeTodoTask } from '@tests/fixtures/domain.ts';

const inProgressOf = (todo: TodoTask): InProgressTask => {
  const r = startNextAttempt(todo, FIXED_NOW, 'session-1');
  if (!r.ok) throw new Error(`fixture startNextAttempt failed: ${r.error.message}`);
  return r.value;
};

const names = (tasks: readonly Task[]): string[] => tasks.map((t) => t.name);

describe('resolveImplementQueue', () => {
  it('fails fast on a cyclic graph with the rendered cycle reason', () => {
    // A → B → A. `scheduleIntoWaves` runs `validateTaskGraph` first, so the cycle short-circuits
    // before any task is filtered out — the operator sees the cycle, not an empty queue.
    const a = makeTodoTask({ name: 'a', order: 1 });
    const b = makeTodoTask({ name: 'b', order: 2, dependsOn: [a.id] });
    const cyclicA: Task = { ...a, dependsOn: [b.id] };

    const result = resolveImplementQueue([cyclicA, b]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('dependency cycle');
    expect(result.error).toContain(String(a.id));
    expect(result.error).toContain(String(b.id));
  });

  it('fails fast on a self-edge', () => {
    const a = makeTodoTask({ name: 'a' });
    const selfEdge: Task = { ...a, dependsOn: [a.id] };

    const result = resolveImplementQueue([selfEdge]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('depends on itself');
  });

  it('fails fast on a dangling dependency', () => {
    const a = makeTodoTask({ name: 'a', order: 1 });
    const b = makeTodoTask({ name: 'b', order: 2 });
    // a depends on b, but b is NOT in the launched set → unknown-dependency.
    const danglingA: Task = { ...a, dependsOn: [b.id] };

    const result = resolveImplementQueue([danglingA]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('unknown task');
  });

  it('orders a valid graph by dependency, not input order', () => {
    // Input deliberately reversed: c (depends b) → b (depends a) → a.
    const a = makeTodoTask({ name: 'a', order: 1 });
    const b = makeTodoTask({ name: 'b', order: 2, dependsOn: [a.id] });
    const c = makeTodoTask({ name: 'c', order: 3, dependsOn: [b.id] });

    const result = resolveImplementQueue([c, b, a]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(names(result.value)).toEqual(['a', 'b', 'c']);
  });

  it('keeps an in-progress (resumed) task first while preserving dependency order', () => {
    // a → b → c chain; c is in_progress (a crashed resume). The dependency order is a, b, c,
    // but the resumed task must LEAD so relaunch resumes it before opening fresh work — and the
    // remaining todos stay in dependency order behind it.
    const a = makeTodoTask({ name: 'a', order: 1 });
    const b = makeTodoTask({ name: 'b', order: 2, dependsOn: [a.id] });
    const cTodo = makeTodoTask({ name: 'c', order: 3, dependsOn: [b.id] });
    const c = inProgressOf(cTodo);

    const result = resolveImplementQueue([a, b, c]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // c leads (resume override); a then b preserve dependency order behind it.
    expect(names(result.value)).toEqual(['c', 'a', 'b']);
    expect(result.value[0]?.status).toBe('in_progress');
  });

  it('excludes done / blocked tasks from the resumable queue', () => {
    // Only todo + in_progress are resumable; done/blocked are scheduled (so the graph validates)
    // but filtered out of the launch queue.
    const a = makeTodoTask({ name: 'a', order: 1 });
    const b = makeTodoTask({ name: 'b', order: 2, dependsOn: [a.id] });
    const blocked: Task = { ...a, status: 'blocked', blockedReason: 'manual block' };

    const result = resolveImplementQueue([blocked, b]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(names(result.value)).toEqual(['b']);
  });

  it('returns an empty queue when nothing is resumable (caller reports separately)', () => {
    const done: Task = { ...makeTodoTask({ name: 'a' }), status: 'blocked', blockedReason: 'x' };

    const result = resolveImplementQueue([done]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });
});
