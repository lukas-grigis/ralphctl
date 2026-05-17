import type { FlowManifest } from '@src/application/registry.ts';

export const ticketRemoveManifest: FlowManifest = {
  id: 'ticket-remove',
  title: 'Remove ticket',
  description: 'Drop a ticket from a draft sprint.',
  canBackground: false,
  triggers: { currentSprintStatus: ['draft'] },
};
