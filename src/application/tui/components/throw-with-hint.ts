/**
 * `throwWithHint` — convert a `Result.error` failure into a thrown Error that
 * carries the domain `hint` field across the boundary into `useWorkflow`.
 *
 * Most CRUD views in `crud/*.tsx` follow the pattern:
 *
 *   if (!result.ok) throw new Error(result.error.message);
 *
 * That pattern drops the optional `hint` field on the domain error. This
 * helper attaches the hint as an own-property on the thrown Error so
 * `useWorkflow` can surface it to `ResultCard`.
 */

interface MaybeHint {
  readonly hint?: unknown;
}

/**
 * Throw an `Error` whose message comes from `error.message` and whose `hint`
 * property mirrors the domain error's `hint` (when present and non-empty).
 *
 * Returns `never` so call sites can write `throw throwWithHint(error)` —
 * keeping it as a normal `throw` keeps control-flow analysis happy.
 */
export function throwWithHint(error: { readonly message: string } & MaybeHint): never {
  const wrapped = new Error(error.message);
  if (typeof error.hint === 'string' && error.hint.length > 0) {
    Object.assign(wrapped, { hint: error.hint });
  }
  throw wrapped;
}
