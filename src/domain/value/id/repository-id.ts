import { uuidv7Id } from '@src/domain/value/uuid7.ts';

declare const __repositoryId: unique symbol;
export type RepositoryId = string & { readonly [__repositoryId]: 'RepositoryId' };

export const RepositoryId = uuidv7Id<RepositoryId>('repository');
