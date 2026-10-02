import type { Task } from '@src/domain/entity/task.ts';

// Swaps the updated task into the ctx task list so downstream leaves see the persisted state.
export const replaceTask = (tasks: readonly Task[] | undefined, task: Task): Task[] =>
  (tasks ?? []).map((t) => (t.id === task.id ? task : t));
