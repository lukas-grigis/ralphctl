/** Focus-list discriminated union shared by the ticket and task panes. */

import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';

export type FocusItem =
  { readonly kind: 'ticket'; readonly ticket: Ticket } | { readonly kind: 'task'; readonly task: Task };

export const buildFocusList = (sprint: Sprint, tasks: readonly Task[]): readonly FocusItem[] => [
  ...sprint.tickets.map((ticket) => ({ kind: 'ticket' as const, ticket })),
  ...tasks.map((task) => ({ kind: 'task' as const, task })),
];

/** Per-section card budget for the windowed ticket / task lists. */
export const sectionWindowCards = (rows: number): number => Math.max(6, Math.min(14, Math.floor(rows / 3)));

/** Clamp an index into `[0, length - 1]`; `0` for an empty (`length <= 0`) list. */
export const clampFocusIndex = (n: number, length: number): number => Math.max(0, Math.min(n, length - 1));

/**
 * Index of the next blocked task in `focusList`, strictly after `fromIdx`, wrapping around the whole list back to
 * (and including) `fromIdx` itself.
 */
export const nextBlockedIndex = (focusList: readonly FocusItem[], fromIdx: number): number | undefined => {
  const total = focusList.length;
  if (total === 0) return undefined;
  for (let step = 1; step <= total; step += 1) {
    const idx = (fromIdx + step) % total;
    const item = focusList[idx];
    if (item?.kind === 'task' && item.task.status === 'blocked') return idx;
  }
  return undefined;
};

/** Index of the task with `taskId` in `focusList`, or `undefined` when absent. */
export const indexOfTask = (focusList: readonly FocusItem[], taskId: string): number | undefined => {
  const idx = focusList.findIndex((item) => item.kind === 'task' && String(item.task.id) === taskId);
  return idx >= 0 ? idx : undefined;
};

/**
 * Controls for the `B` jump-to-next-blocked chord (`shortcuts.ts`) and its footer hint (`detail-body.tsx`'s
 * `buildDetailHints`).
 */
export interface JumpControls {
  readonly active: boolean;
  /** Page size for PgUp / PgDn while `active` — mirrors the page `useListWindow` itself uses. */
  readonly pageSize: number;
  /** Gates both the `B` chord and its footer hint — true whenever any task in the sprint is blocked. */
  readonly available: boolean;
  readonly jumpToNextBlocked: () => void;
  readonly moveBy: (delta: number) => void;
  readonly moveToEdge: (edge: 'start' | 'end') => void;
}
