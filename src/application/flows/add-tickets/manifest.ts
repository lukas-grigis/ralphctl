import type { FlowManifest } from '@src/application/registry.ts';

export const addTicketsManifest: FlowManifest = {
  id: 'add-tickets',
  title: 'Add tickets',
  description: 'Interactively add one or more tickets to a draft sprint.',
  canBackground: false,
  triggers: { currentSprintStatus: ['draft'] },
};
