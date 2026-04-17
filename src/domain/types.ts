import { Result } from 'typescript-result';

import type { DomainError } from './errors.ts';

export { Result };

/** Standard result type for domain operations */
export type DomainResult<T> = Result<T, DomainError>;
