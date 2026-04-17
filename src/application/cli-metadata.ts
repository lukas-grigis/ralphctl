import pkg from '../../package.json' with { type: 'json' };

export const cliMetadata = {
  name: 'ralphctl',
  version: pkg.version,
  description: "I'm helping! Plan sprints and execute tasks with AI",
} as const;
