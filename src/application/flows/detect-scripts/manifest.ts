import type { FlowManifest } from '@src/application/registry.ts';

export const detectScriptsManifest: FlowManifest = {
  id: 'detect-scripts',
  title: 'Detect setup & verify scripts',
  description:
    'Read-only AI inventory of one repository. Suggests a setup script (sprint prep) and a verify script (post-task gate); the user confirms before either lands on the repo.',
  canBackground: false,
  triggers: { requiresProject: true },
};
