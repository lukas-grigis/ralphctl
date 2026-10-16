import { homedir } from 'node:os';
import { join } from 'node:path';

// Only a leading `~` or `~/` expands; an embedded `~` stays so the AbsolutePath validator can reject it.
export const expandHome = (input: string): string => {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
};
