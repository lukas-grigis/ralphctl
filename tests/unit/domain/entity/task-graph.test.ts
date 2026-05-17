import { describe, expect, it } from 'vitest';
import { type Task, validateTaskGraph } from '@src/domain/entity/task.ts';
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
});
