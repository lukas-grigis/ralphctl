/**
 * Focus-list discriminated union shared by the ticket and task panes.
 *
 * The orchestrator builds a single flat array spanning both tickets and tasks so a single
 * `cursorIdx` can move across the two sections without each pane having to know about the
 * other. Both sibling files render against the same shape, so the type lives here rather
 * than being duplicated.
 */

import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';

export type FocusItem =
  | { readonly kind: 'ticket'; readonly ticket: Ticket }
  | { readonly kind: 'task'; readonly task: Task };

export const buildFocusList = (sprint: Sprint, tasks: readonly Task[]): readonly FocusItem[] => [
  ...sprint.tickets.map((ticket) => ({ kind: 'ticket' as const, ticket })),
  ...tasks.map((task) => ({ kind: 'task' as const, task })),
];
