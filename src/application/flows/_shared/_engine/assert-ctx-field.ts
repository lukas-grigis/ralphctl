import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';

/**
 * Assert that a ctx field is present (not `undefined`), and return its narrowed value. The
 * canonical use is inside a leaf's `input()` projector when a save-shaped leaf needs an
 * entity that an earlier load-shaped leaf must have produced. Throws an `InvalidStateError`
 * (a chain-construction error) when the field is missing — never silently no-op.
 *
 * `name` is the leaf name; it lands in the error message so a chain that wires the leaves in
 * the wrong order surfaces a clear "pre-save: ctx.<field> is undefined" message.
 */
export const assertCtxField = <TCtx extends object, K extends keyof TCtx>(
  ctx: TCtx,
  field: K,
  name: string
): NonNullable<TCtx[K]> => {
  const value = ctx[field];
  if (value === undefined || value === null) {
    throw new InvalidStateError({
      entity: 'chain',
      currentState: 'pre-save',
      attemptedAction: name,
      message: `${name}: ctx.${String(field)} is undefined — an upstream leaf must produce it before ${name} runs`,
    });
  }
  return value as NonNullable<TCtx[K]>;
};
