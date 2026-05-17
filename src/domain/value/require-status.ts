import { Result } from '@src/domain/result.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';

/**
 * State-machine guard. Returns `Result.ok(entity)` narrowed to the allowed-status variant if
 * the entity's `status` is in `allowed`; otherwise `Result.error(InvalidStateError)`.
 *
 * Eliminates the per-method `if (status !== ...) return Result.error(...)` boilerplate AND the
 * follow-up `as Variant` cast — the returned `Result.ok` value is already typed as the
 * narrowed variant.
 *
 * @example
 *   const guard = requireStatus('sprint', sprint, ['draft'] as const, 'add-ticket');
 *   if (!guard.ok) return Result.error(guard.error);
 *   const draft = guard.value;  // typed as DraftSprint
 */
export const requireStatus = <T extends { readonly status: string }, A extends T['status']>(
  entityName: string,
  entity: T,
  allowed: readonly A[],
  attemptedAction: string,
  hint?: string
): Result<Extract<T, { readonly status: A }>, InvalidStateError> => {
  type Narrowed = Extract<T, { readonly status: A }>;
  if ((allowed as readonly string[]).includes(entity.status)) {
    return Result.ok(entity as Narrowed) as Result<Narrowed, InvalidStateError>;
  }
  return Result.error(
    new InvalidStateError({
      entity: entityName,
      currentState: entity.status,
      attemptedAction,
      ...(hint !== undefined ? { hint } : {}),
    })
  );
};
