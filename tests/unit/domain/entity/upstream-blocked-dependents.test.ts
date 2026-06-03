import { describe, expect, it } from 'vitest';
import { BLOCKED_UPSTREAM_REASON_PREFIX, markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { upstreamBlockedDependents } from '@src/domain/entity/task-graph.ts';
import { makeTodoTask } from '@tests/fixtures/domain.ts';
import type { Task } from '@src/domain/entity/task.ts';

const through = <T>(r: { readonly ok: true; readonly value: T } | { readonly ok: false }): T => {
  if (!r.ok) throw new Error('expected ok');
  return r.value;
};

const upstream = (t: Task): Task =>
  through(markTaskBlocked(t, `${BLOCKED_UPSTREAM_REASON_PREFIX} — prerequisite not done`, 'upstream'));
const ownBlocked = (t: Task): Task => through(markTaskBlocked(t, 'verify failed on its own merits', 'own'));

describe('upstreamBlockedDependents', () => {
  it('returns the transitive upstream-blocked subtree of the root, excluding the root itself', () => {
    const a = makeTodoTask({ name: 'a' });
    const b = upstream(makeTodoTask({ name: 'b', dependsOn: [a.id] }));
    const c = upstream(makeTodoTask({ name: 'c', dependsOn: [b.id] })); // transitive through b
    const tasks = [a, b, c];

    const ids = new Set(upstreamBlockedDependents(tasks, a.id).map(String));
    expect(ids.has(String(b.id))).toBe(true);
    expect(ids.has(String(c.id))).toBe(true);
    expect(ids.has(String(a.id))).toBe(false);
  });

  it('excludes own-failure-blocked dependents (they need a real fix, not a cascade)', () => {
    const a = makeTodoTask({ name: 'a' });
    const b = ownBlocked(makeTodoTask({ name: 'b', dependsOn: [a.id] }));
    const ids = upstreamBlockedDependents([a, b], a.id);
    expect(ids).toHaveLength(0);
  });

  it('excludes done / todo dependents and unrelated tasks', () => {
    const a = makeTodoTask({ name: 'a' });
    const doneDep = makeTodoTask({ name: 'done-dep', dependsOn: [a.id] }); // todo, not blocked
    const unrelated = upstream(makeTodoTask({ name: 'unrelated' })); // upstream-blocked but no edge to a
    const ids = upstreamBlockedDependents([a, doneDep, unrelated], a.id);
    expect(ids).toHaveLength(0);
  });

  it('does not traverse THROUGH an own-failure-blocked dependent', () => {
    // a → b(own-blocked) → c(upstream-blocked). c depends on b, not a; since b is not in the
    // upstream closure, the walk stops at b and never reaches c.
    const a = makeTodoTask({ name: 'a' });
    const b = ownBlocked(makeTodoTask({ name: 'b', dependsOn: [a.id] }));
    const c = upstream(makeTodoTask({ name: 'c', dependsOn: [b.id] }));
    const ids = upstreamBlockedDependents([a, b, c], a.id);
    expect(ids).toHaveLength(0);
  });
});
