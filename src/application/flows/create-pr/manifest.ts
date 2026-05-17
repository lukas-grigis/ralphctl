import type { FlowManifest } from '@src/application/registry.ts';

export const createPrManifest: FlowManifest = {
  id: 'create-pr',
  title: 'Create pull request',
  description: 'Open a PR / MR for the sprint branch via gh or glab.',
  canBackground: false,
  // Needs a project (cwd is derived from the first repo's path) and a sprint that's reached
  // review or done — earlier states have no implementable work to PR.
  triggers: { requiresProject: true, currentSprintStatus: ['review', 'done'] },
};
