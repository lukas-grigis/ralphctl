import type { FlowManifest } from '@src/application/registry.ts';

export const settingsSetProviderManifest: FlowManifest = {
  id: 'settings-set-provider',
  title: 'Settings — switch provider',
  description: "Switch the AI provider and reset the four chain models to that provider's defaults.",
  canBackground: false,
  triggers: {},
};
