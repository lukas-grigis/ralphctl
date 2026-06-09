import type { FlowManifest } from '@src/application/registry.ts';

export const ticketRemoveManifest: FlowManifest = {
  id: 'remove-ticket',
  title: 'Remove ticket',
  description: 'Drop a ticket from a draft sprint.',
  canBackground: false,
  triggers: { currentSprintStatus: ['draft'] },
};
