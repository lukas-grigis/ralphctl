import type { FlowManifest } from '@src/application/registry.ts';

export const readinessManifest: FlowManifest = {
  id: 'readiness',
  title: 'AI readiness',
  description:
    'Inventory a repository with the AI and write a tool-native context file (CLAUDE.md / AGENTS.md / Copilot instructions).',
  canBackground: false,
  triggers: { requiresProject: true },
};
