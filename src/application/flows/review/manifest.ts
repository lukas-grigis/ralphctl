import type { FlowManifest } from '@src/application/registry.ts';

/**
 * Review chain — runs the iterative feedback loop on an implemented sprint, then transitions
 * `review → done`. The user types revision requests into `feedback.md`, the AI applies them
 * against the sprint branch, the user re-edits or accepts. Empty / repeat feedback ends the
 * loop and the sprint moves to `done`.
 *
 * PR creation is intentionally separate (`create-pr` flow). Closing a sprint via review does
 * NOT open a PR — that's a deliberate downstream step the user runs only when they want the
 * branch published. A sprint can sit on its `ralphctl/<id>` branch forever after `done` if
 * the user prefers a stale-branch workflow over published reviews.
 */
export const reviewManifest: FlowManifest = {
  id: 'review',
  title: 'Review',
  description:
    'Iterative feedback loop on an implemented sprint; closes the sprint to done. PR creation is separate and optional.',
  canBackground: true,
  triggers: { currentSprintStatus: ['review'] },
  costHint: 'one AI session per revision cycle — cost scales with the number of feedback rounds',
};
