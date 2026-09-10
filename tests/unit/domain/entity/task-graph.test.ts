import { describe, expect, it } from 'vitest';
import type { Task } from '@src/domain/entity/task.ts';
import { validateTaskGraph } from '@src/domain/entity/task-graph.ts';
import { makeTodoTask } from '@tests/fixtures/domain.ts';

describe('validateTaskGraph', () => {
  it('passes empty', () => {
    const r = validateTaskGraph([]);
    expect(r.ok).toBe(true);
  });

  it('passes a linear DAG', () => {
    const a = makeTodoTask({ name: 'a' });
    const b = makeTodoTask({ name: 'b', dependsOn: [a.id] });
    const c = makeTodoTask({ name: 'c', dependsOn: [b.id] });
    const r = validateTaskGraph([a, b, c]);
    expect(r.ok).toBe(true);
  });

  it('passes a fan-out DAG', () => {
    const root = makeTodoTask({ name: 'root' });
    const a = makeTodoTask({ name: 'a', dependsOn: [root.id] });
    const b = makeTodoTask({ name: 'b', dependsOn: [root.id] });
    const r = validateTaskGraph([root, a, b]);
    expect(r.ok).toBe(true);
  });

  it('detects self-edge', () => {
    const a = makeTodoTask({ name: 'a' });
    const broken: Task = { ...a, dependsOn: [a.id] };
    const r = validateTaskGraph([broken]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('self-edge');
  });

  it('detects unknown dependency', () => {
    const a = makeTodoTask({ name: 'a' });
    const b = makeTodoTask({ name: 'b' });
    const broken: Task = { ...b, dependsOn: [a.id] };
    const r = validateTaskGraph([broken]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('unknown-dependency');
  });

  it('detects 2-cycle A → B → A', () => {
    const a = makeTodoTask({ name: 'a' });
    const b = makeTodoTask({ name: 'b' });
    const aWithEdge: Task = { ...a, dependsOn: [b.id] };
    const bWithEdge: Task = { ...b, dependsOn: [a.id] };
    const r = validateTaskGraph([aWithEdge, bWithEdge]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('cycle');
  });

  it('detects 3-cycle A → B → C → A', () => {
    const a = makeTodoTask({ name: 'a' });
    const b = makeTodoTask({ name: 'b' });
    const c = makeTodoTask({ name: 'c' });
    const aE: Task = { ...a, dependsOn: [b.id] };
    const bE: Task = { ...b, dependsOn: [c.id] };
    const cE: Task = { ...c, dependsOn: [a.id] };
    const r = validateTaskGraph([aE, bE, cE]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('cycle');
  });

  // ── `satisfiedDependencyIds` — validating a NARROWED subset (a resumed run's resumable tasks,
  // not the full sprint) without an already-settled prerequisite outside that subset misreporting
  // as `unknown-dependency`. See `scheduleIntoWaves` / `CreateImplementFlowOpts.satisfiedDependencyIds`
  // for the call site this exists for.

  it('tolerates a dependency id declared in satisfiedDependencyIds even though it resolves to nothing in the set', () => {
    const outsideId = makeTodoTask({ name: 'already-done-elsewhere' }).id;
    const dependent = makeTodoTask({ name: 'dependent', dependsOn: [outsideId] });

    const r = validateTaskGraph([dependent], new Set([outsideId]));

    expect(r.ok).toBe(true);
  });

  it('still detects a genuinely unknown dependency when satisfiedDependencyIds names a DIFFERENT id (no blanket tolerance)', () => {
    const missingId = makeTodoTask({ name: 'never-existed' }).id;
    const unrelatedSatisfiedId = makeTodoTask({ name: 'satisfied-but-irrelevant' }).id;
    const dependent = makeTodoTask({ name: 'dependent', dependsOn: [missingId] });

    const r = validateTaskGraph([dependent], new Set([unrelatedSatisfiedId]));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toStrictEqual({ kind: 'unknown-dependency', task: dependent.id, missing: missingId });
  });

  it("still detects a self-edge even when the task's own id is (nonsensically) declared satisfied", () => {
    const a = makeTodoTask({ name: 'a' });
    const broken: Task = { ...a, dependsOn: [a.id] };

    const r = validateTaskGraph([broken], new Set([a.id]));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('self-edge');
  });

  it('defaults satisfiedDependencyIds to empty — omitting it reproduces the original whole-set behaviour', () => {
    const a = makeTodoTask({ name: 'a' });
    const b = makeTodoTask({ name: 'b' });
    const broken: Task = { ...b, dependsOn: [a.id] }; // a is not in the passed set
    const r = validateTaskGraph([broken]);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('unknown-dependency');
  });
});
