import type { FlowManifest } from '@src/application/registry.ts';

export const exportContextManifest: FlowManifest = {
  id: 'export-context',
  title: 'Export harness context',
  description: 'Write a snapshot of sprint + tickets + tasks + project to a markdown file.',
  canBackground: false,
  // Needs both a project AND a sprint loaded — the renderer pulls sprint + project + tasks.
  // `currentSprintStatus` covers every variant so the gate is effectively "any sprint selected".
  triggers: { requiresProject: true, currentSprintStatus: ['draft', 'planned', 'active', 'review', 'done'] },
};
