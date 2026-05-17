import type { FlowManifest } from '@src/application/registry.ts';

export const createSprintManifest: FlowManifest = {
  id: 'create-sprint',
  title: 'Create sprint',
  description: 'Create a new draft sprint by picking its name and affected repositories.',
  canBackground: false,
  triggers: { requiresProject: true },
};
