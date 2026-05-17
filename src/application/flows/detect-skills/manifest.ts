import type { FlowManifest } from '@src/application/registry.ts';

export const detectSkillsManifest: FlowManifest = {
  id: 'detect-skills',
  title: 'Detect setup & verify skills',
  description:
    'Read-only AI inventory of one repository. Authors multi-paragraph setup + verify skills (markdown) that are installed into future AI sessions; the user reviews before either lands on the repo.',
  canBackground: false,
  triggers: { requiresProject: true },
};
