import { describe, expect, it } from 'vitest';

import { computeDepths, getDepth, sortByDepth, type DagItem } from './dag-depth.ts';

function item(id: string, blockedBy: string[] = []): DagItem {
  return { id, blockedBy };
}

describe('computeDepths', () => {
  it('assigns depth 0 to roots and 1+max(dep) downstream — linear chain', () => {
    const depths = computeDepths([item('a'), item('b', ['a']), item('c', ['b'])]);
    expect(depths).not.toBeNull();
    if (depths === null) return;
    expect(depths.get('a')).toBe(0);
    expect(depths.get('b')).toBe(1);
    expect(depths.get('c')).toBe(2);
  });

  it('handles a diamond DAG: A→B, A→C, B→D, C→D — D should be depth 2', () => {
    const depths = computeDepths([item('a'), item('b', ['a']), item('c', ['a']), item('d', ['b', 'c'])]);
    expect(depths).not.toBeNull();
    if (depths === null) return;
    expect(depths.get('a')).toBe(0);
    expect(depths.get('b')).toBe(1);
    expect(depths.get('c')).toBe(1);
    expect(depths.get('d')).toBe(2);
  });

  it('returns null on cycles', () => {
    expect(computeDepths([item('a', ['b']), item('b', ['a'])])).toBeNull();
  });

  it('ignores blockedBy entries that are not in the input set', () => {
    // Out-of-list deps (e.g. tasks already done and filtered out) must not
    // promote depth or trigger a false cycle.
    const depths = computeDepths([item('a', ['ghost']), item('b', ['a'])]);
    expect(depths).not.toBeNull();
    if (depths === null) return;
    expect(depths.get('a')).toBe(0);
    expect(depths.get('b')).toBe(1);
  });
});

describe('sortByDepth', () => {
  it('returns root tasks first when all independent (alphabetical within layer)', () => {
    const sorted = sortByDepth([item('c'), item('a'), item('b')]);
    expect(sorted.map((t) => t.id)).toStrictEqual(['a', 'b', 'c']);
  });

  it('puts dependents after their deps', () => {
    const sorted = sortByDepth([item('t2', ['t1']), item('t1')]);
    const ids = sorted.map((t) => t.id);
    expect(ids.indexOf('t1')).toBeLessThan(ids.indexOf('t2'));
  });

  it('orders diamond DAG layer-by-layer with stable id-secondary sort', () => {
    const sorted = sortByDepth([item('d', ['b', 'c']), item('a'), item('c', ['a']), item('b', ['a'])]);
    expect(sorted.map((t) => t.id)).toStrictEqual(['a', 'b', 'c', 'd']);
  });

  it('falls back to insertion order on cyclic deps (no crash)', () => {
    const tasks = [item('a', ['b']), item('b', ['a'])];
    expect(() => sortByDepth(tasks)).not.toThrow();
    const sorted = sortByDepth(tasks);
    expect(sorted.length).toBe(2);
    expect(sorted.map((t) => t.id)).toStrictEqual(['a', 'b']);
  });
});

describe('getDepth', () => {
  it('returns the cached depth when present', () => {
    const depths = new Map([['a', 3]]);
    expect(getDepth(item('a'), depths)).toBe(3);
  });

  it('returns 0 for unknown ids', () => {
    expect(getDepth(item('ghost'), new Map())).toBe(0);
  });

  it('returns 0 when the depth map is null (cycle case)', () => {
    expect(getDepth(item('a'), null)).toBe(0);
  });
});
