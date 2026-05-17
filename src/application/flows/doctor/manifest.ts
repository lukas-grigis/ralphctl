import type { FlowManifest } from '@src/application/registry.ts';

export const doctorManifest: FlowManifest = {
  id: 'doctor',
  title: 'Doctor — sanity probes',
  description: 'Check that storage roots are reachable and core repositories respond.',
  canBackground: false,
  triggers: {},
};
