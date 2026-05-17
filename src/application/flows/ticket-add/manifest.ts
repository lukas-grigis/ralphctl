import type { FlowManifest } from '@src/application/registry.ts';

export const ticketAddManifest: FlowManifest = {
  id: 'ticket-add',
  title: 'Add ticket',
  description: 'Append a pending ticket to a draft sprint.',
  canBackground: false,
  triggers: { currentSprintStatus: ['draft'] },
};
