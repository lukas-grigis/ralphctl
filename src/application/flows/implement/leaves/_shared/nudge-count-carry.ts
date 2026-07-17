/**
 * Conditional per-attempt counter carry for the corrective-nudge cost-visibility tally — returns
 * `{ [field]: prior + delta }` only when `delta` is positive (a turn that needed no nudge
 * contributes nothing), else `{}`. Shared by the generator/evaluator leaves' `xOutput` ctx-merge
 * functions so a zero-delta turn (the common case) adds no extra branch to their already-branchy
 * reducers.
 */
export const positiveCountCarry = <K extends string>(
  field: K,
  delta: number,
  prior: number | undefined
): Partial<Record<K, number>> => (delta > 0 ? ({ [field]: (prior ?? 0) + delta } as Partial<Record<K, number>>) : {});
