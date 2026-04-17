import type { AsyncResult } from 'typescript-result';
import { Result } from 'typescript-result';

import type { DomainError } from './errors.ts';

export { Result };
export type { AsyncResult };

/** Standard result type for domain operations */
export type DomainResult<T> = Result<T, DomainError>;

/** Standard async result type for domain operations */
export type AsyncDomainResult<T> = Promise<DomainResult<T>>;
