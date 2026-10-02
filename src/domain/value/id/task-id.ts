import { uuidv7Id } from '@src/domain/value/uuid7.ts';

declare const __taskId: unique symbol;
export type TaskId = string & { readonly [__taskId]: 'TaskId' };

export const TaskId = uuidv7Id<TaskId>('task');
