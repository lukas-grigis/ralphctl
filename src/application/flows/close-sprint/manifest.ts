import type { FlowManifest } from '@src/application/registry.ts';

/**
 * Close-sprint chain — the explicit "I'm done with this sprint" path. Loads the sprint,
 * asserts it's in `review`, transitions to `done`. No AI feedback loop, no PR creation —
 * those live in `review` and `create-pr` respectively. A user who wants iterative feedback
 * before closing picks `review` (which auto-closes on empty submission); a user who's
 * already happy picks this flow.
 *
 * Surfaced in the Flows menu only when the current sprint is `review`.
 */
export const closeSprintManifest: FlowManifest = {
  id: 'close-sprint',
  title: 'Close sprint',
  description: 'Mark this sprint done (review → done). Use review for iterative feedback before closing.',
  canBackground: false,
  triggers: { currentSprintStatus: ['review'] },
};
