import { describe, expect, it, vi } from 'vitest';
import { StorageError } from '@src/domain/errors.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { FilesystemPort } from '@src/business/ports/filesystem.ts';
import type { Project, Sprint, Task } from '@src/domain/models.ts';
import type { PerTaskContext } from '../per-task-context.ts';
import { contractNegotiate } from './contract-negotiate.ts';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-1',
    name: 'Add guard',
    description: 'null-safety in handler',
    steps: ['read', 'write', 'test'],
    verificationCriteria: ['passes'],
    status: 'todo',
    order: 1,
    blockedBy: [],
    projectPath: '/repo',
    verified: false,
    evaluated: false,
    ...overrides,
  };
}

function sprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: 'sprint-1',
    name: 'Demo',
    status: 'draft',
    createdAt: '2026-04-16T00:00:00Z',
    activatedAt: null,
    closedAt: null,
    tickets: [{ id: 'tk1', title: 'T', projectName: 'p', requirementStatus: 'approved' }],
    checkRanAt: {},
    branch: null,
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    name: 'p',
    displayName: 'P',
    repositories: [{ name: 'repo', path: '/repo', checkScript: 'pnpm test' }],
    ...overrides,
  };
}

function makeCtx(overrides: Partial<PerTaskContext> = {}): PerTaskContext {
  return {
    sprintId: 'sprint-1',
    task: task(),
    sprint: sprint(),
    ...overrides,
  };
}

function makeDeps(persistenceOverrides: Partial<PersistencePort> = {}, fsOverrides: Partial<FilesystemPort> = {}) {
  const fsImpl: Partial<FilesystemPort> = {
    getSprintDir: () => '/tmp/sprint-dir',
    ensureDir: vi.fn(() => Promise.resolve()),
    writeFile: vi.fn(() => Promise.resolve()),
    ...fsOverrides,
  };
  const persistenceImpl: Partial<PersistencePort> = {
    getProject: (name: string) => {
      if (name === 'p') return Promise.resolve(project());
      return Promise.reject(new Error('unknown project'));
    },
    ...persistenceOverrides,
  };
  return {
    persistence: persistenceImpl as PersistencePort,
    fs: fsImpl as FilesystemPort,
  };
}

describe('contract-negotiate step', () => {
  it('writes the contract to <sprintDir>/contracts/<taskId>.md and populates ctx.contractPath', async () => {
    const writeFile = vi.fn<(path: string, content: string) => Promise<void>>(() => Promise.resolve());
    const ensureDir = vi.fn(() => Promise.resolve());
    const deps = makeDeps({}, { writeFile, ensureDir });

    const stepDef = contractNegotiate(deps);
    const result = await stepDef.execute(makeCtx());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(ensureDir).toHaveBeenCalledWith('/tmp/sprint-dir/contracts');
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [writePath, writeContent] = writeFile.mock.calls[0] ?? [];
    expect(writePath).toBe('/tmp/sprint-dir/contracts/t-1.md');
    expect(String(writeContent)).toContain('Sprint Contract — Add guard');
    expect(String(writeContent)).toContain('pnpm test');

    expect(result.value.contractPath).toBe('/tmp/sprint-dir/contracts/t-1.md');
  });

  it('renders the no-check-script fallback when the repo has no checkScript', async () => {
    const writeFile = vi.fn<(path: string, content: string) => Promise<void>>(() => Promise.resolve());
    const deps = makeDeps(
      {
        getProject: () => Promise.resolve(project({ repositories: [{ name: 'repo', path: '/repo' }] })),
      },
      { writeFile }
    );

    const stepDef = contractNegotiate(deps);
    const result = await stepDef.execute(makeCtx());

    expect(result.ok).toBe(true);
    const written = writeFile.mock.calls[0]?.[1] ?? '';
    expect(written).toContain('no check script configured');
    expect(written).not.toContain('```sh');
  });

  it('falls back cleanly when no project can be resolved for the task path', async () => {
    const writeFile = vi.fn<(path: string, content: string) => Promise<void>>(() => Promise.resolve());
    const deps = makeDeps(
      {
        getProject: () => Promise.reject(new Error('not found')),
      },
      { writeFile }
    );

    const stepDef = contractNegotiate(deps);
    const result = await stepDef.execute(makeCtx());

    expect(result.ok).toBe(true);
    const written = writeFile.mock.calls[0]?.[1] ?? '';
    expect(written).toContain('no check script configured');
  });

  it('returns StorageError when writeFile throws', async () => {
    const deps = makeDeps(
      {},
      {
        writeFile: () => Promise.reject(new Error('disk full')),
      }
    );

    const stepDef = contractNegotiate(deps);
    const result = await stepDef.execute(makeCtx());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(StorageError);
    expect(result.error.message).toContain('Failed to write sprint contract');
    expect(result.error.message).toContain('disk full');
  });

  it('uses the task id as the filename (even for ids with unusual characters)', async () => {
    const writeFile = vi.fn<(path: string, content: string) => Promise<void>>(() => Promise.resolve());
    const deps = makeDeps({}, { writeFile });

    const stepDef = contractNegotiate(deps);
    await stepDef.execute(makeCtx({ task: task({ id: 'abc-xyz-789' }) }));

    expect(writeFile.mock.calls[0]?.[0]).toBe('/tmp/sprint-dir/contracts/abc-xyz-789.md');
  });
});
