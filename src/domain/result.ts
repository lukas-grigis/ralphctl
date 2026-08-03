export { Result } from 'typescript-result';

/**
 * The async counterpart to {@link Result}. Currently unreferenced, but kept because this
 * module is the only sanctioned way to reach `typescript-result` — direct imports of the
 * package are ESLint-fenced, so dropping it would leave a future caller no way in.
 *
 * @public
 */
export type { AsyncResult } from 'typescript-result';
