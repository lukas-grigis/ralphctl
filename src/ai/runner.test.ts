import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildFullTaskContext,
  type CheckStatus,
  getEffectiveCheckScript,
  getRecentGitHistory,
  type TaskContext,
} from './task-context.ts';
import { parseExecutionResult } from './parser.ts';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Project, Sprint, Task } from '@src/schemas/index.ts';

describe('parseExecutionResult', () => {
  describe('completion signals', () => {
    it('marks success when task-complete with task-verified', () => {
      const output = `
        Did some work...
        <task-verified>
        $ npm run lint
        ✓ No lint errors
        $ npm run test
        ✓ All tests passed
        </task-verified>
        <task-complete>
      `;
      const result = parseExecutionResult(output);
      expect(result.success).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.verificationOutput).toContain('No lint errors');
      expect(result.verificationOutput).toContain('All tests passed');
    });

    it('fails when task-complete without task-verified', () => {
      const output = `
        Did some work...
        <task-complete>
      `;
      const result = parseExecutionResult(output);
      expect(result.success).toBe(false);
      expect(result.blockedReason).toContain('without verification');
    });

    it('parses task-blocked signal', () => {
      const output = `
        Tried to do work but...
        <task-blocked>Cannot find required dependency</task-blocked>
      `;
      const result = parseExecutionResult(output);
      expect(result.success).toBe(false);
      expect(result.blockedReason).toBe('Cannot find required dependency');
    });

    it('returns incomplete when no signal found', () => {
      const output = 'Did some work but never finished';
      const result = parseExecutionResult(output);
      expect(result.success).toBe(false);
      expect(result.blockedReason).toBe('No completion signal received');
    });

    it('extracts verification output even when blocked', () => {
      const output = `
        <task-verified>
        $ npm run lint
        ✓ Passed
        </task-verified>
        <task-blocked>Tests failed unexpectedly</task-blocked>
      `;
      const result = parseExecutionResult(output);
      expect(result.success).toBe(false);
      expect(result.verified).toBe(true);
      expect(result.verificationOutput).toContain('Passed');
      expect(result.blockedReason).toBe('Tests failed unexpectedly');
    });

    it('handles multiline verification output', () => {
      const output = `
        <task-verified>
        $ npm run lint

        > project@1.0.0 lint
        > eslint .

        ✓ 42 files passed

        $ npm run test

        PASS  src/test.ts
          ✓ test 1
          ✓ test 2

        Tests: 2 passed
        </task-verified>
        <task-complete>
      `;
      const result = parseExecutionResult(output);
      expect(result.success).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.verificationOutput).toContain('42 files passed');
      expect(result.verificationOutput).toContain('Tests: 2 passed');
    });
  });
});

describe('getEffectiveCheckScript', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ralphctl-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses explicit repository checkScript when available', () => {
    const project: Project = {
      name: 'test',
      displayName: 'Test',
      repositories: [{ name: 'test', path: tempDir, checkScript: 'custom-verify-command' }],
    };

    // Even if there's a package.json, explicit script takes priority
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: { test: 'jest' },
      })
    );

    const result = getEffectiveCheckScript(project, tempDir);
    expect(result).toBe('custom-verify-command');
  });

  it('returns null when no explicit script (no runtime auto-detection)', () => {
    const project: Project = {
      name: 'test',
      displayName: 'Test',
      repositories: [{ name: 'test', path: tempDir }],
    };

    // package.json exists but no explicit checkScript — should return null
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: { test: 'jest' },
      })
    );

    const result = getEffectiveCheckScript(project, tempDir);
    expect(result).toBeNull();
  });

  it('returns null when no project', () => {
    const result = getEffectiveCheckScript(undefined, tempDir);
    expect(result).toBeNull();
  });
});

describe('getRecentGitHistory', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ralphctl-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns error message for non-git directory', () => {
    const result = getRecentGitHistory(tempDir);
    expect(result).toContain('Unable to retrieve git history');
  });

  it('returns error message for non-existent directory', () => {
    const result = getRecentGitHistory('/nonexistent/path/that/does/not/exist');
    expect(result).toContain('Unable to retrieve git history');
  });
});

describe('buildFullTaskContext with check status', () => {
  const baseTask: Task = {
    id: 'task-1',
    name: 'Test task',
    steps: ['Step 1'],
    verificationCriteria: [],
    status: 'in_progress',
    order: 1,
    blockedBy: [],
    projectPath: '/tmp/test-project',
    verified: false,
    evaluated: false,
  };

  const baseSprint: Sprint = {
    id: 'sprint-1',
    name: 'Test sprint',
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    activatedAt: '2026-01-01T00:00:00Z',
    closedAt: null,
    tickets: [],
    checkRanAt: {},
    branch: null,
  };

  const baseCtx: TaskContext = { sprint: baseSprint, task: baseTask };
  const gitHistory = 'abc1234 some commit';

  it('shows check script info when check ran successfully', () => {
    const checkStatus: CheckStatus = { ran: true, script: 'pnpm install' };
    const result = buildFullTaskContext(baseCtx, null, gitHistory, 'pnpm test', checkStatus);

    expect(result).toContain('## Environment Status');
    expect(result).toContain('The check script ran successfully at sprint start');
  });

  it('tells agent no check script is configured when ran is false', () => {
    const checkStatus: CheckStatus = { ran: false, reason: 'no-script' };
    const result = buildFullTaskContext(baseCtx, null, gitHistory, null, checkStatus);

    expect(result).toContain('## Environment Status');
    expect(result).toContain('No check script is configured for this repository');
    expect(result).toContain('CLAUDE.md');
  });

  it('shows check script section when verify exists but no check ran', () => {
    const checkStatus: CheckStatus = { ran: false, reason: 'no-script' };
    const result = buildFullTaskContext(baseCtx, null, gitHistory, 'pnpm test', checkStatus);

    expect(result).toContain('## Environment Status');
    expect(result).toContain('No check script is configured for this repository');
  });

  it('omits section when checkStatus is undefined (backward compat)', () => {
    const result = buildFullTaskContext(baseCtx, null, gitHistory, 'pnpm test');

    expect(result).not.toContain('## Environment Status');
  });
});

// ============================================================================
// Branch context rendering tests
// ============================================================================

describe('buildFullTaskContext with branch', () => {
  const baseTask: Task = {
    id: 'task-1',
    name: 'Test task',
    steps: ['Step 1'],
    verificationCriteria: [],
    status: 'in_progress',
    order: 1,
    blockedBy: [],
    projectPath: '/tmp/test-project',
    verified: false,
    evaluated: false,
  };

  const gitHistory = 'abc1234 some commit';

  it('includes branch section when sprint.branch is set', () => {
    const sprint: Sprint = {
      id: '20260224-143200-auth-feature',
      name: 'Test sprint',
      status: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      activatedAt: '2026-01-01T00:00:00Z',
      closedAt: null,
      tickets: [],
      checkRanAt: {},
      branch: 'ralphctl/20260224-143200-auth-feature',
    };

    const ctx: TaskContext = { sprint, task: baseTask };
    const result = buildFullTaskContext(ctx, null, gitHistory, 'pnpm test');

    expect(result).toContain('## Branch');
    expect(result).toContain('ralphctl/20260224-143200-auth-feature');
    expect(result).toContain('Do not switch branches');
  });

  it('omits branch section when sprint.branch is null', () => {
    const sprint: Sprint = {
      id: '20260224-143200-auth-feature',
      name: 'Test sprint',
      status: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      activatedAt: '2026-01-01T00:00:00Z',
      closedAt: null,
      tickets: [],
      checkRanAt: {},
      branch: null,
    };

    const ctx: TaskContext = { sprint, task: baseTask };
    const result = buildFullTaskContext(ctx, null, gitHistory, 'pnpm test');

    expect(result).not.toContain('## Branch');
  });
});

// ============================================================================
// runCheckScripts tests
// ============================================================================

vi.mock('@src/store/task.ts', () => ({
  getTasks: vi.fn(),
}));

vi.mock('@src/store/sprint.ts', () => ({
  saveSprint: vi.fn(),
  activateSprint: vi.fn(),
  assertSprintStatus: vi.fn(),
  closeSprint: vi.fn(),
  getSprint: vi.fn(),
  resolveSprintId: vi.fn(),
  areAllTasksDone: vi.fn(),
  getRemainingTasks: vi.fn(),
  reorderByDependencies: vi.fn(),
}));

vi.mock('@src/ai/task-context.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@src/ai/task-context.ts')>();
  return {
    ...actual,
    getProjectForTask: vi.fn(),
  };
});

vi.mock('@src/ai/lifecycle.ts', () => ({
  runLifecycleHook: vi.fn(),
}));

describe('runCheckScripts', () => {
  const makeTask = (projectPath: string, status: 'todo' | 'in_progress' | 'done' = 'todo'): Task => ({
    id: `task-${projectPath}`,
    name: `Task for ${projectPath}`,
    steps: [],
    verificationCriteria: [],
    status,
    order: 1,
    blockedBy: [],
    projectPath,
    verified: false,
    evaluated: false,
  });

  const makeSprint = (checkRanAt: Record<string, string> = {}, branch: string | null = null): Sprint => ({
    id: '20260101-000000-test',
    name: 'Test sprint',
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    activatedAt: '2026-01-01T00:00:00Z',
    closedAt: null,
    tickets: [],
    checkRanAt,
    branch,
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // Default: runLifecycleHook succeeds
    const { runLifecycleHook } = await import('@src/ai/lifecycle.ts');
    vi.mocked(runLifecycleHook).mockReturnValue({ passed: true, output: 'ok' });

    const sprintStore = await import('@src/store/sprint.ts');
    vi.mocked(sprintStore.saveSprint).mockResolvedValue(undefined);

    // Mock getEffectiveCheckScript per-suite (the real impl is tested separately above)
    const taskContext = await import('@src/ai/task-context.ts');
    vi.spyOn(taskContext, 'getEffectiveCheckScript').mockReturnValue(null);
  });

  it('records timestamp on successful check run', async () => {
    const { runCheckScripts } = await import('./runner.ts');
    const { getTasks } = await import('@src/store/task.ts');
    const taskContext = await import('@src/ai/task-context.ts');
    const { saveSprint } = await import('@src/store/sprint.ts');

    const task = makeTask('/repo/alpha');
    const sprint = makeSprint();

    vi.mocked(getTasks).mockResolvedValue([task]);
    vi.mocked(taskContext.getProjectForTask).mockResolvedValue(undefined);
    vi.mocked(taskContext.getEffectiveCheckScript).mockReturnValue('pnpm install');

    const result = await runCheckScripts('sprint-1', sprint);

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Timestamp was written to the sprint object
    expect(sprint.checkRanAt['/repo/alpha']).toBeDefined();
    expect(typeof sprint.checkRanAt['/repo/alpha']).toBe('string');

    // saveSprint was called to persist the timestamp
    expect(saveSprint).toHaveBeenCalledWith(sprint);

    // Result map contains { ran: true, script }
    expect(result.results.get('/repo/alpha')).toEqual({ ran: true, script: 'pnpm install' });
  });

  it('skips check and returns ran:true when checkRanAt already has a timestamp', async () => {
    const { runCheckScripts } = await import('./runner.ts');
    const { getTasks } = await import('@src/store/task.ts');
    const taskContext = await import('@src/ai/task-context.ts');
    const { saveSprint } = await import('@src/store/sprint.ts');
    const { runLifecycleHook } = await import('@src/ai/lifecycle.ts');

    const task = makeTask('/repo/alpha');
    const sprint = makeSprint({ '/repo/alpha': '2026-01-01T00:00:00Z' });

    vi.mocked(getTasks).mockResolvedValue([task]);
    vi.mocked(taskContext.getProjectForTask).mockResolvedValue(undefined);
    vi.mocked(taskContext.getEffectiveCheckScript).mockReturnValue('pnpm install');

    const result = await runCheckScripts('sprint-1', sprint);

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Script was NOT actually executed
    expect(runLifecycleHook).not.toHaveBeenCalled();

    // saveSprint was NOT called (nothing changed)
    expect(saveSprint).not.toHaveBeenCalled();

    // Result still reports ran:true so the AI agent context is correct
    expect(result.results.get('/repo/alpha')).toEqual({ ran: true, script: 'pnpm install' });
  });

  it('re-runs check when refreshCheck=true even if checkRanAt has a timestamp', async () => {
    const { runCheckScripts } = await import('./runner.ts');
    const { getTasks } = await import('@src/store/task.ts');
    const taskContext = await import('@src/ai/task-context.ts');
    const { saveSprint } = await import('@src/store/sprint.ts');
    const { runLifecycleHook } = await import('@src/ai/lifecycle.ts');

    const task = makeTask('/repo/alpha');
    const sprint = makeSprint({ '/repo/alpha': '2026-01-01T00:00:00Z' });

    vi.mocked(getTasks).mockResolvedValue([task]);
    vi.mocked(taskContext.getProjectForTask).mockResolvedValue(undefined);
    vi.mocked(taskContext.getEffectiveCheckScript).mockReturnValue('pnpm install');

    const result = await runCheckScripts('sprint-1', sprint, true /* refreshCheck */);

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Script WAS executed despite existing timestamp
    expect(runLifecycleHook).toHaveBeenCalledWith('/repo/alpha', 'pnpm install', 'sprintStart', undefined);

    // Timestamp was updated and sprint persisted
    expect(saveSprint).toHaveBeenCalledWith(sprint);
    expect(result.results.get('/repo/alpha')).toEqual({ ran: true, script: 'pnpm install' });
  });

  it('persists first repo timestamp even when second repo check fails', async () => {
    const { runCheckScripts } = await import('./runner.ts');
    const { getTasks } = await import('@src/store/task.ts');
    const taskContext = await import('@src/ai/task-context.ts');
    const { saveSprint } = await import('@src/store/sprint.ts');
    const { runLifecycleHook } = await import('@src/ai/lifecycle.ts');

    const taskAlpha = makeTask('/repo/alpha');
    const taskBeta = makeTask('/repo/beta');
    const sprint = makeSprint();

    vi.mocked(getTasks).mockResolvedValue([taskAlpha, taskBeta]);
    vi.mocked(taskContext.getProjectForTask).mockResolvedValue(undefined);
    vi.mocked(taskContext.getEffectiveCheckScript).mockImplementation((_project, path) =>
      path === '/repo/alpha' ? 'pnpm install' : 'npm ci'
    );

    // First call (alpha) succeeds; second call (beta) fails
    vi.mocked(runLifecycleHook)
      .mockReturnValueOnce({ passed: true, output: '' })
      .mockReturnValueOnce({ passed: false, output: 'failed' });

    const result = await runCheckScripts('sprint-1', sprint);

    expect(result.success).toBe(false);

    // Alpha's timestamp was saved before beta failed
    expect(sprint.checkRanAt['/repo/alpha']).toBeDefined();
    expect(sprint.checkRanAt['/repo/beta']).toBeUndefined();

    // saveSprint was called exactly once (for alpha's successful run)
    expect(saveSprint).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// ensureSprintBranches tests
// ============================================================================

vi.mock('@src/utils/git.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@src/utils/git.ts')>();
  return {
    ...actual,
    hasUncommittedChanges: vi.fn(),
    getCurrentBranch: vi.fn(),
    createAndCheckoutBranch: vi.fn(),
    isValidBranchName: actual.isValidBranchName,
    generateBranchName: actual.generateBranchName,
    verifyCurrentBranch: actual.verifyCurrentBranch,
  };
});

describe('ensureSprintBranches', () => {
  const makeTask = (projectPath: string, status: 'todo' | 'in_progress' | 'done' = 'todo'): Task => ({
    id: `task-${projectPath.replace(/\//g, '-')}`,
    name: `Task for ${projectPath}`,
    steps: [],
    verificationCriteria: [],
    status,
    order: 1,
    blockedBy: [],
    projectPath,
    verified: false,
    evaluated: false,
  });

  const makeSprint = (branch: string | null = null): Sprint => ({
    id: '20260101-000000-test',
    name: 'Test sprint',
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    activatedAt: '2026-01-01T00:00:00Z',
    closedAt: null,
    tickets: [],
    checkRanAt: {},
    branch,
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    const taskStore = await import('@src/store/task.ts');
    vi.mocked(taskStore.getTasks).mockResolvedValue([]);

    const sprintStore = await import('@src/store/sprint.ts');
    vi.mocked(sprintStore.saveSprint).mockResolvedValue(undefined);

    const git = await import('@src/utils/git.ts');
    vi.mocked(git.hasUncommittedChanges).mockReturnValue(false);
    vi.mocked(git.getCurrentBranch).mockReturnValue('main');
    vi.mocked(git.createAndCheckoutBranch).mockReturnValue(undefined);
  });

  it('creates branches in all repos with remaining tasks', async () => {
    const { ensureSprintBranches } = await import('./runner.ts');
    const { getTasks } = await import('@src/store/task.ts');
    const { saveSprint } = await import('@src/store/sprint.ts');
    const git = await import('@src/utils/git.ts');

    vi.mocked(getTasks).mockResolvedValue([makeTask('/repo/alpha'), makeTask('/repo/beta')]);

    const sprint = makeSprint();
    await ensureSprintBranches('sprint-1', sprint, 'ralphctl/20260101-000000-test');

    expect(git.createAndCheckoutBranch).toHaveBeenCalledWith('/repo/alpha', 'ralphctl/20260101-000000-test');
    expect(git.createAndCheckoutBranch).toHaveBeenCalledWith('/repo/beta', 'ralphctl/20260101-000000-test');
    expect(sprint.branch).toBe('ralphctl/20260101-000000-test');
    expect(saveSprint).toHaveBeenCalledWith(sprint);
  });

  it('skips done tasks', async () => {
    const { ensureSprintBranches } = await import('./runner.ts');
    const { getTasks } = await import('@src/store/task.ts');
    const git = await import('@src/utils/git.ts');

    vi.mocked(getTasks).mockResolvedValue([makeTask('/repo/alpha', 'done'), makeTask('/repo/beta', 'todo')]);

    const sprint = makeSprint();
    await ensureSprintBranches('sprint-1', sprint, 'ralphctl/test');

    expect(git.createAndCheckoutBranch).toHaveBeenCalledTimes(1);
    expect(git.createAndCheckoutBranch).toHaveBeenCalledWith('/repo/beta', 'ralphctl/test');
  });

  it('skips create when already on the target branch', async () => {
    const { ensureSprintBranches } = await import('./runner.ts');
    const { getTasks } = await import('@src/store/task.ts');
    const git = await import('@src/utils/git.ts');

    vi.mocked(getTasks).mockResolvedValue([makeTask('/repo/alpha')]);
    vi.mocked(git.getCurrentBranch).mockReturnValue('ralphctl/test');

    const sprint = makeSprint();
    await ensureSprintBranches('sprint-1', sprint, 'ralphctl/test');

    expect(git.createAndCheckoutBranch).not.toHaveBeenCalled();
  });

  it('fails fast when repo has uncommitted changes', async () => {
    const { ensureSprintBranches } = await import('./runner.ts');
    const { getTasks } = await import('@src/store/task.ts');
    const git = await import('@src/utils/git.ts');

    vi.mocked(getTasks).mockResolvedValue([makeTask('/repo/alpha')]);
    vi.mocked(git.hasUncommittedChanges).mockReturnValue(true);

    const sprint = makeSprint();
    await expect(ensureSprintBranches('sprint-1', sprint, 'ralphctl/test')).rejects.toThrow('uncommitted changes');
  });

  it('does not call saveSprint when branch is already set', async () => {
    const { ensureSprintBranches } = await import('./runner.ts');
    const { getTasks } = await import('@src/store/task.ts');
    const { saveSprint } = await import('@src/store/sprint.ts');
    const git = await import('@src/utils/git.ts');

    vi.mocked(getTasks).mockResolvedValue([makeTask('/repo/alpha')]);
    vi.mocked(git.getCurrentBranch).mockReturnValue('ralphctl/test');

    const sprint = makeSprint('ralphctl/test');
    await ensureSprintBranches('sprint-1', sprint, 'ralphctl/test');

    expect(saveSprint).not.toHaveBeenCalled();
  });

  it('rejects invalid branch names', async () => {
    const { ensureSprintBranches } = await import('./runner.ts');
    const { getTasks } = await import('@src/store/task.ts');

    vi.mocked(getTasks).mockResolvedValue([makeTask('/repo/alpha')]);

    const sprint = makeSprint();
    await expect(ensureSprintBranches('sprint-1', sprint, 'bad name with spaces')).rejects.toThrow(
      'Invalid branch name'
    );
  });
});
