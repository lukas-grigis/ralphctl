import { uuidv7Id } from '@src/domain/value/uuid7.ts';

declare const __sprintId: unique symbol;
export type SprintId = string & { readonly [__sprintId]: 'SprintId' };

export const SprintId = uuidv7Id<SprintId>('sprint');
