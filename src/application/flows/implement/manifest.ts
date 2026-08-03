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
  triggers: {
    currentSprintStatus: ['planned', 'active'],
    currentSprintStatusHint: 'Plan this sprint first — it must be planned (or active) before you can implement.',
    minResumableTasks: 1,
  },
  costHint: 'generator–evaluator loop per task — higher token spend, independently verified output',
};
