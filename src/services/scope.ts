import { nanoid } from 'nanoid';
import {
  getScopesDir,
  getScopeDir,
  getScopeFilePath,
  getTasksFilePath,
  getProgressFilePath,
} from '@src/utils/paths.ts';
import {
  readValidatedJson,
  writeValidatedJson,
  listDirs,
  fileExists,
  ensureDir,
  appendToFile,
} from '@src/utils/storage.ts';
import { ScopeSchema, TasksSchema, type Scope, type ScopeStatus } from '@src/schemas/index.ts';
import { getActiveScope, setActiveScope } from '@src/services/config.ts';

export class ScopeNotFoundError extends Error {
  constructor(scopeId: string) {
    super(`Scope not found: ${scopeId}`);
    this.name = 'ScopeNotFoundError';
  }
}

export class ScopeStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeStatusError';
  }
}

function generateScopeId(): string {
  const now = new Date();
  const date = now.toISOString().split('T')[0] ?? '';
  const suffix = nanoid(4).toLowerCase();
  return `${date}-${suffix}`;
}

export async function createScope(name: string): Promise<Scope> {
  const id = generateScopeId();
  const now = new Date().toISOString();

  const scope: Scope = {
    id,
    name,
    status: 'draft',
    createdAt: now,
    activatedAt: null,
    closedAt: null,
    tickets: [],
  };

  const scopeDir = getScopeDir(id);
  await ensureDir(scopeDir);

  await writeValidatedJson(getScopeFilePath(id), scope, ScopeSchema);
  await writeValidatedJson(getTasksFilePath(id), [], TasksSchema);
  await appendToFile(
    getProgressFilePath(id),
    `# Scope: ${name}\n\nCreated: ${now}\n\n---\n\n`
  );

  return scope;
}

export async function getScope(scopeId: string): Promise<Scope> {
  const scopePath = getScopeFilePath(scopeId);
  if (!(await fileExists(scopePath))) {
    throw new ScopeNotFoundError(scopeId);
  }
  return readValidatedJson(scopePath, ScopeSchema);
}

export async function saveScope(scope: Scope): Promise<void> {
  await writeValidatedJson(getScopeFilePath(scope.id), scope, ScopeSchema);
}

export async function listScopes(): Promise<Scope[]> {
  const scopesDir = getScopesDir();
  const dirs = await listDirs(scopesDir);

  const scopes: Scope[] = [];
  for (const dir of dirs) {
    try {
      const scope = await getScope(dir);
      scopes.push(scope);
    } catch {
      // Skip invalid scope directories
    }
  }

  // Sort by creation date (newest first)
  return scopes.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export async function activateScope(scopeId: string): Promise<Scope> {
  const scope = await getScope(scopeId);

  if (scope.status !== 'draft') {
    throw new ScopeStatusError(
      `Cannot activate scope: current status is '${scope.status}' (must be 'draft')`
    );
  }

  scope.status = 'active';
  scope.activatedAt = new Date().toISOString();
  await saveScope(scope);
  await setActiveScope(scopeId);

  return scope;
}

export async function closeScope(scopeId: string): Promise<Scope> {
  const scope = await getScope(scopeId);

  if (scope.status !== 'active') {
    throw new ScopeStatusError(
      `Cannot close scope: current status is '${scope.status}' (must be 'active')`
    );
  }

  scope.status = 'closed';
  scope.closedAt = new Date().toISOString();
  await saveScope(scope);

  // Clear active scope if this was the active one
  const activeScopeId = await getActiveScope();
  if (activeScopeId === scopeId) {
    await setActiveScope(null);
  }

  return scope;
}

export async function getActiveScopeOrThrow(): Promise<Scope> {
  const activeScopeId = await getActiveScope();
  if (!activeScopeId) {
    throw new Error('No active scope. Use "ralphctl scope activate <id>" to set one.');
  }
  return getScope(activeScopeId);
}

export async function resolveScopeId(scopeId?: string): Promise<string> {
  if (scopeId) {
    return scopeId;
  }
  const activeScopeId = await getActiveScope();
  if (!activeScopeId) {
    throw new Error('No scope specified and no active scope set.');
  }
  return activeScopeId;
}

export function formatScopeStatus(status: ScopeStatus): string {
  const colors: Record<ScopeStatus, string> = {
    draft: '\x1b[33m', // yellow
    active: '\x1b[32m', // green
    closed: '\x1b[90m', // gray
  };
  const reset = '\x1b[0m';
  return `${colors[status]}${status}${reset}`;
}
