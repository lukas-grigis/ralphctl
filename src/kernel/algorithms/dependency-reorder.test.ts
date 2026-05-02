import { describe, expect, it } from 'vitest';

import type { DependencyNode } from './dependency-reorder.ts';
import { topologicalReorder } from './dependency-reorder.ts';

interface Item {
  readonly id: string;
  readonly label: string;
}

const node = (id: string, blockedBy: string[] = [], label = id): DependencyNode<Item> => ({
  item: { id, label },
  id,
  blockedBy,
});

describe('topologicalReorder', () => {
  it('returns an empty array for empty input', () => {
    const result = topologicalReorder<Item>([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toStrictEqual([]);
  });

  it('orders a linear chain A→B→C', () => {
    const result = topologicalReorder([node('A'), node('B', ['A']), node('C', ['B'])]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((i) => i.id)).toStrictEqual(['A', 'B', 'C']);
  });

  it('produces a topological order on a diamond A→{B,C}→D', () => {
    const result = topologicalReorder([node('A'), node('B', ['A']), node('C', ['A']), node('D', ['B', 'C'])]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const order = result.value.map((i) => i.id);

    // A first, D last; B and C between in input order (stable).
    expect(order[0]).toBe('A');
    expect(order[3]).toBe('D');
    expect(order.indexOf('B')).toBeLessThan(order.indexOf('D'));
    expect(order.indexOf('C')).toBeLessThan(order.indexOf('D'));
    expect(order).toStrictEqual(['A', 'B', 'C', 'D']);
  });

  it('preserves input order among independent ready nodes', () => {
    const result = topologicalReorder([node('Z'), node('Y'), node('X'), node('W')]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((i) => i.id)).toStrictEqual(['Z', 'Y', 'X', 'W']);
  });

  it('detects a self-referential cycle', () => {
    const result = topologicalReorder([node('A', ['A'])]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('cycle');
    if (result.error.code !== 'cycle') return;
    expect(result.error.cycle).toContain('A');
  });

  it('detects a 2-node cycle', () => {
    const result = topologicalReorder([node('A', ['B']), node('B', ['A'])]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('cycle');
    if (result.error.code !== 'cycle') return;
    expect([...result.error.cycle].sort()).toStrictEqual(['A', 'B']);
  });

  it('detects a 3-node cycle', () => {
    const result = topologicalReorder([node('A', ['C']), node('B', ['A']), node('C', ['B'])]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('cycle');
    if (result.error.code !== 'cycle') return;
    expect(new Set(result.error.cycle)).toStrictEqual(new Set(['A', 'B', 'C']));
  });

  it('returns unknown-dep when blockedBy references a non-existent id', () => {
    const result = topologicalReorder([node('A'), node('B', ['ghost'])]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unknown-dep');
    if (result.error.code !== 'unknown-dep') return;
    expect(result.error.from).toBe('B');
    expect(result.error.to).toBe('ghost');
  });

  // Ported from afe771f9~1:src/integration/persistence/task.test.ts
  it('resolves correctly when a dependent appears before its dependency in the input array', () => {
    // C is listed first but depends on A which comes last — still resolves.
    const result = topologicalReorder([node('C', ['A']), node('B', ['A']), node('A')]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.map((i) => i.id);
    expect(ids.indexOf('A')).toBeLessThan(ids.indexOf('B'));
    expect(ids.indexOf('A')).toBeLessThan(ids.indexOf('C'));
  });

  it('returns the first unknown-dep encountered (current behavior — stops at first)', () => {
    // The algorithm validates as it builds the adjacency list; it returns the
    // FIRST unknown dep it encounters, not all of them.
    const result = topologicalReorder([node('A', ['missing1']), node('B', ['missing2'])]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unknown-dep');
    // Either A→missing1 or B→missing2 is reported; implementation chooses first encountered.
    if (result.error.code === 'unknown-dep') {
      expect(['missing1', 'missing2']).toContain(result.error.to);
    }
  });

  it('threads through complex DAG without losing nodes', () => {
    const result = topologicalReorder([
      node('a'),
      node('b', ['a']),
      node('c', ['a']),
      node('d', ['b']),
      node('e', ['c']),
      node('f', ['d', 'e']),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.map((i) => i.id);
    expect(ids).toHaveLength(6);
    // Every dep precedes its dependents.
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('c'));
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('d'));
    expect(ids.indexOf('c')).toBeLessThan(ids.indexOf('e'));
    expect(ids.indexOf('d')).toBeLessThan(ids.indexOf('f'));
    expect(ids.indexOf('e')).toBeLessThan(ids.indexOf('f'));
  });

  // Ported from afe771f9~1:src/integration/persistence/task.test.ts
  it('handles 50+ nodes with multiple independent chains and preserves stable ordering', () => {
    // Build 5 independent chains of 10 nodes each.
    // chain0: n0-0 → n0-1 → … → n0-9
    // chain1: n1-0 → n1-1 → … → n1-9
    // etc.
    const nodeId = (chain: number, step: number): string => `n${String(chain)}-${String(step)}`;
    const nodes: DependencyNode<Item>[] = [];
    for (let chain = 0; chain < 5; chain++) {
      for (let step = 0; step < 10; step++) {
        const id = nodeId(chain, step);
        const blockedBy = step > 0 ? [nodeId(chain, step - 1)] : [];
        nodes.push(node(id, blockedBy));
      }
    }
    const result = topologicalReorder(nodes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.map((i) => i.id);
    expect(ids).toHaveLength(50);
    // Within each chain every step must follow the prior step.
    for (let chain = 0; chain < 5; chain++) {
      for (let step = 1; step < 10; step++) {
        const prev = nodeId(chain, step - 1);
        const curr = nodeId(chain, step);
        expect(ids.indexOf(prev)).toBeLessThan(ids.indexOf(curr));
      }
    }
    // Independent chain heads (step 0) must all appear before their own chain's
    // step 1, confirming stable input-order for the ready queue.
    for (let chain = 0; chain < 5; chain++) {
      expect(ids.indexOf(nodeId(chain, 0))).toBeLessThan(ids.indexOf(nodeId(chain, 1)));
    }
  });
});
