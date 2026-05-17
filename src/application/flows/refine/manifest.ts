import type { FlowManifest } from '@src/application/registry.ts';

export const refineManifest: FlowManifest = {
  id: 'refine',
  title: 'Refine',
  description: 'Run requirements refinement on every pending ticket in a draft sprint.',
  canBackground: false,
  triggers: { currentSprintStatus: ['draft'], minPendingTickets: 1 },
};
