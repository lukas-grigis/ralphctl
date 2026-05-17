import type { FlowManifest } from '@src/application/registry.ts';

export const exportRequirementsManifest: FlowManifest = {
  id: 'export-requirements',
  title: 'Export requirements',
  description: "Write the sprint's approved-ticket requirements to a markdown file.",
  canBackground: false,
  // Needs a project (TUI uses the selection cursor) and at least one approved ticket — the
  // renderer iterates the approved subset. `requiresProject` keeps the row gated until a
  // project is picked even when storage somehow contains a sprint with approved tickets
  // before the selection has caught up.
  triggers: { requiresProject: true, minApprovedTickets: 1 },
};
