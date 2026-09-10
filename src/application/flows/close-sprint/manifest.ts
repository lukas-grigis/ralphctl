import type { FlowManifest } from '@src/application/registry.ts';

/**
 * Close-sprint chain — the explicit "I'm done with this sprint" path. Loads the sprint,
 * asserts it's in `review`, transitions to `done`. No AI feedback loop, no PR creation —
 * those live in `review` and `create-pr` respectively. A user who wants iterative feedback
 * before closing picks `review` (which auto-closes on empty submission); a user who's
 * already happy picks this flow.
 *
 * Surfaced in the Flows menu only when the current sprint is `review`. Closing with blocked
 * tasks is a confirm, not a refusal — `maxBlockedTasks` below documents that threshold without
 * gating the menu entry on it; the launcher names the blocked tasks instead.
 */
export const closeSprintManifest: FlowManifest = {
  id: 'close-sprint',
  title: 'Close sprint',
  description: 'Mark this sprint done (review → done). Use review for iterative feedback before closing.',
  canBackground: false,
  triggers: {
    currentSprintStatus: ['review'],
    currentSprintStatusHint: 'Run Implement to completion first — this flow needs a review-status sprint.',
    maxBlockedTasks: 0,
    maxBlockedTasksHint: 'Blocked tasks are named in the close confirmation instead of blocking the close.',
  },
};
