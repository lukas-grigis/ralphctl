import type { PlanNode } from '@src/application/chain/plan-tree.ts';

/** Leaf names of a plan tree in DFS order. */
export const planLeafNames = (node: PlanNode | undefined): readonly string[] =>
  node === undefined
    ? []
    : node.children.length === 0 && node.kind === 'leaf'
      ? [node.name]
      : node.children.flatMap((c) => planLeafNames(c));

/** Leaf `name → label` for every labelled leaf of a plan tree. */
export const planLeafLabels = (node: PlanNode | undefined): ReadonlyMap<string, string> => {
  const out = new Map<string, string>();
  const walk = (n: PlanNode): void => {
    if (n.kind === 'leaf' && n.label !== undefined && n.label.length > 0) out.set(n.name, n.label);
    n.children.forEach(walk);
  };
  if (node !== undefined) walk(node);
  return out;
};
