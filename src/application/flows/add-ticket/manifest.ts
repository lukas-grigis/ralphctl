import type { FlowManifest } from '@src/application/registry.ts';

export const ticketAddManifest: FlowManifest = {
  id: 'add-ticket',
  title: 'Add ticket',
  description: 'Append a pending ticket to the current sprint.',
  canBackground: false,
  triggers: { currentSprintStatus: ['draft'] },
};
