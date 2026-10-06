import type { Element, ElementKind, WorkItemRef } from '@src/application/chain/element.ts';

/** One node of a chain's upfront step plan — the display-relevant facts of an `Element`. */
export interface PlanNode {
  readonly name: string;
  readonly label?: string;
  readonly kind: ElementKind;
  readonly internal: boolean;
  readonly workItem?: WorkItemRef;
  readonly maxIterations?: number;
  readonly children: readonly PlanNode[];
}

/**
 * Derive the plan tree from an element without executing anything. Hand-written elements carry no
 * `kind`: they read as `sequential` when they expose children, otherwise as `leaf`. Its leaves, in
 * DFS order, are exactly `flattenLeaves(element)`.
 */
export const buildPlanTree = <TCtx>(element: Element<TCtx>): PlanNode => {
  const children = (element.children ?? []).map((c) => buildPlanTree(c));
  const kind: ElementKind = element.kind ?? (children.length > 0 ? 'sequential' : 'leaf');
  return {
    name: element.name,
    ...(element.label !== undefined ? { label: element.label } : {}),
    kind,
    internal: element.display?.internal === true,
    ...(element.display?.workItem !== undefined ? { workItem: element.display.workItem } : {}),
    ...(element.maxIterations !== undefined ? { maxIterations: element.maxIterations } : {}),
    children,
  };
};
