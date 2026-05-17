import type { FlowManifest } from '@src/application/registry.ts';

export const planManifest: FlowManifest = {
  id: 'plan',
  title: 'Plan',
  description: 'Plan a draft sprint: turn approved tickets into a dependency-ordered task list.',
  canBackground: false,
  triggers: { currentSprintStatus: ['draft'], minApprovedTickets: 1 },
};
