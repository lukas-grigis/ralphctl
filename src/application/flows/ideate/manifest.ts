import type { FlowManifest } from '@src/application/registry.ts';

/**
 * Ideate — quick-start flow that combines refine + plan in one interactive AI session.
 * Takes a free-text idea + draft sprint, produces an `ApprovedTicket` and `Task[]` in one
 * shot. Useful when you want to bootstrap a sprint without two separate flows.
 */
export const ideateManifest: FlowManifest = {
  id: 'ideate',
  title: 'Ideate',
  description: 'Combine refine + plan in one interactive AI session — turn an idea into ticket + tasks.',
  canBackground: false,
  triggers: { currentSprintStatus: ['draft'], requiresProject: true },
};
