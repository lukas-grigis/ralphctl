import type { FlowManifest } from '@src/application/registry.ts';

/**
 * Implement chain — runs the generator–evaluator loop on every todo task in a planned/active
 * sprint. Backgroundable: this is the long-running flow the TUI detaches and re-attaches to.
 */
export const implementManifest: FlowManifest = {
  id: 'implement',
  title: 'Implement',
  description: 'Run the generator–evaluator loop on every todo task in a planned/active sprint.',
  canBackground: true,
  triggers: { currentSprintStatus: ['planned', 'active'], minResumableTasks: 1 },
};
