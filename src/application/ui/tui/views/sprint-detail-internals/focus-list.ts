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
  { readonly kind: 'ticket'; readonly ticket: Ticket } | { readonly kind: 'task'; readonly task: Task };

export const buildFocusList = (sprint: Sprint, tasks: readonly Task[]): readonly FocusItem[] => [
  ...sprint.tickets.map((ticket) => ({ kind: 'ticket' as const, ticket })),
  ...tasks.map((task) => ({ kind: 'task' as const, task })),
];

/**
 * Per-section card budget for the windowed ticket / task lists. Both panes share the same
 * viewport, so the cap is derived from the terminal row count rather than a hardcoded literal:
 * roughly one card per three rows, floored at 6 (so short lists never window) and clamped at 14
 * (so a very tall terminal does not try to paint an unbounded slice). Pure — both sibling panes
 * feed it the live `rows` from `useBreakpoint`.
 */
export const sectionWindowCards = (rows: number): number => Math.max(6, Math.min(14, Math.floor(rows / 3)));

/** Clamp an index into `[0, length - 1]`; `0` for an empty (`length <= 0`) list. */
export const clampFocusIndex = (n: number, length: number): number => Math.max(0, Math.min(n, length - 1));

/**
 * Index of the next blocked task in `focusList`, strictly after `fromIdx`, wrapping around the
 * whole list back to (and including) `fromIdx` itself — so a lone blocked task under the cursor
 * is still a valid jump target rather than a no-op, and repeated presses cycle through every
 * blocked task in list order. `undefined` when nothing is blocked.
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

/**
 * Controls for the `B` jump-to-next-blocked chord (`shortcuts.ts`) and its footer hint
 * (`detail-body.tsx`'s `buildDetailHints`).
 *
 * `useListWindow`'s own cursor is private hook state with no externally-callable setter — by
 * design, so a list reorder snaps focus to the nearest survivor rather than a caller silently
 * teleporting it. A "jump to this specific id" affordance can't be built by reaching into that
 * state, so once engaged this object takes over: `active` goes `true` and, from then on for the
 * rest of the mount, IT drives `cursorIdx` instead of `useListWindow`'s own resolved index.
 * `moveBy` / `moveToEdge` reimplement the small bit of index arithmetic (arrows / j / k / Home /
 * End / PgUp / PgDn) `useListWindow` would otherwise own, so those chords stay fully live on
 * both sides of a jump — "arrows stay primary" holds throughout.
 *
 * Trade-off: once active this is a plain index, not an id-tracked one, so it does not re-resolve
 * onto the same logical item across a ticket/task list reorder the way `useListWindow`'s own
 * cursor does. Accepted because the two things that could actually reorder this exact list —
 * ticket add/remove (`a`/`d`, gated to `draft` sprints) and a blocked task existing at all (only
 * from `planned` onward) — never overlap: a sprint is never both, so a jump is never active while
 * the list can reorder out from under it.
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
