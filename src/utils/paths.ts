import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Get the ralphctl root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const RALPHCTL_ROOT = join(__dirname, '..', '..');

// Directory and file paths
export function getScopesDir(): string {
  return join(RALPHCTL_ROOT, 'scopes');
}

export function getScopeDir(scopeId: string): string {
  return join(getScopesDir(), scopeId);
}

export function getScopeFilePath(scopeId: string): string {
  return join(getScopeDir(scopeId), 'scope.json');
}

export function getTasksFilePath(scopeId: string): string {
  return join(getScopeDir(scopeId), 'tasks.json');
}

export function getProgressFilePath(scopeId: string): string {
  return join(getScopeDir(scopeId), 'progress.md');
}

export function getConfigPath(): string {
  return join(RALPHCTL_ROOT, 'config.json');
}
