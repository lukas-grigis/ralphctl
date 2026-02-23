import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildFullTaskContext,
  getEffectiveVerifyScript,
  getRecentGitHistory,
  type PreFlightResult,
  type SetupStatus,
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

describe('getEffectiveVerifyScript', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ralphctl-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses explicit repository verifyScript when available', () => {
    const project: Project = {
      name: 'test',
      displayName: 'Test',
      repositories: [{ name: 'test', path: tempDir, verifyScript: 'custom-verify-command' }],
    };

    // Even if there's a package.json, explicit script takes priority
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: { test: 'jest' },
      })
    );

    const result = getEffectiveVerifyScript(project, tempDir);
    expect(result).toBe('custom-verify-command');
  });

  it('returns null when no explicit script (no runtime auto-detection)', () => {
    const project: Project = {
      name: 'test',
      displayName: 'Test',
      repositories: [{ name: 'test', path: tempDir }],
    };

    // package.json exists but no explicit verifyScript — should return null
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: { test: 'jest' },
      })
    );

    const result = getEffectiveVerifyScript(project, tempDir);
    expect(result).toBeNull();
  });

  it('returns null when no project', () => {
    const result = getEffectiveVerifyScript(undefined, tempDir);
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

describe('buildFullTaskContext with setup status', () => {
  const baseTask: Task = {
    id: 'task-1',
    name: 'Test task',
    steps: ['Step 1'],
    status: 'in_progress',
    order: 1,
    blockedBy: [],
    projectPath: '/tmp/test-project',
    verified: false,
  };

  const baseSprint: Sprint = {
    id: 'sprint-1',
    name: 'Test sprint',
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    activatedAt: '2026-01-01T00:00:00Z',
    closedAt: null,
    tickets: [],
    setupRanAt: {},
  };

  const baseCtx: TaskContext = { sprint: baseSprint, task: baseTask };
  const gitHistory = 'abc1234 some commit';

  it('shows setup command when setup ran successfully', () => {
    const setupStatus: SetupStatus = { ran: true, script: 'pnpm install' };
    const result = buildFullTaskContext(baseCtx, null, gitHistory, 'pnpm test', setupStatus);

    expect(result).toContain('## Environment Setup');
    expect(result).toContain('pnpm install');
    expect(result).toContain('Do not re-run this command');
  });

  it('tells agent to discover commands when no setup and no verify', () => {
    const setupStatus: SetupStatus = { ran: false, reason: 'no-script' };
    const result = buildFullTaskContext(baseCtx, null, gitHistory, null, setupStatus);

    expect(result).toContain('## Environment Setup');
    expect(result).toContain('No setup or verify scripts are configured');
    expect(result).toContain('CLAUDE.md');
  });

  it('gives targeted guidance when no setup but verify exists', () => {
    const setupStatus: SetupStatus = { ran: false, reason: 'no-script' };
    const result = buildFullTaskContext(baseCtx, null, gitHistory, 'pnpm test', setupStatus);

    expect(result).toContain('## Environment Setup');
    expect(result).toContain('No setup script is configured');
    expect(result).toContain('missing dependency errors');
  });

  it('omits section when setupStatus is undefined (backward compat)', () => {
    const result = buildFullTaskContext(baseCtx, null, gitHistory, 'pnpm test');

    expect(result).not.toContain('## Environment Setup');
  });
});

// ============================================================================
// Pre-flight context rendering tests
// ============================================================================

describe('buildFullTaskContext with preFlightResult', () => {
  const baseTask: Task = {
    id: 'task-1',
    name: 'Test task',
    steps: ['Step 1'],
    status: 'in_progress',
    order: 1,
    blockedBy: [],
    projectPath: '/tmp/test-project',
    verified: false,
  };

  const baseSprint: Sprint = {
    id: 'sprint-1',
    name: 'Test sprint',
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    activatedAt: '2026-01-01T00:00:00Z',
    closedAt: null,
    tickets: [],
    setupRanAt: {},
  };

  const baseCtx: TaskContext = { sprint: baseSprint, task: baseTask };
  const gitHistory = 'abc1234 some commit';
  const setupStatus: SetupStatus = { ran: true, script: 'pnpm install' };

  it('renders passed pre-flight — includes "Environment is clean"', () => {
    const preFlightResult: PreFlightResult = { status: 'passed', script: 'pnpm test' };
    const result = buildFullTaskContext(baseCtx, null, gitHistory, 'pnpm test', setupStatus, preFlightResult);

    expect(result).toContain('## Pre-Flight Verification');
    expect(result).toContain('Environment is clean');
    expect(result).toContain('pnpm test');
  });

  it('renders failed-resuming pre-flight — includes failure output and "Assess the failure"', () => {
    const preFlightResult: PreFlightResult = {
      status: 'failed-resuming',
      script: 'pnpm test',
      output: 'Error: 3 tests failed\n  - test A\n  - test B',
    };
    const result = buildFullTaskContext(baseCtx, null, gitHistory, 'pnpm test', setupStatus, preFlightResult);

    expect(result).toContain('## Pre-Flight Verification');
    expect(result).toContain('Resuming task');
    expect(result).toContain('3 tests failed');
    expect(result).toContain('Assess the failure');
  });

  it('omits pre-flight section when preFlightResult is null', () => {
    const result = buildFullTaskContext(baseCtx, null, gitHistory, 'pnpm test', setupStatus, null);

    expect(result).not.toContain('## Pre-Flight Verification');
  });

  it('omits pre-flight section when preFlightResult is undefined', () => {
    const result = buildFullTaskContext(baseCtx, null, gitHistory, 'pnpm test', setupStatus);

    expect(result).not.toContain('## Pre-Flight Verification');
  });
});

// ============================================================================
// runSetupScripts tests
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
    getEffectiveSetupScript: vi.fn(),
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

describe('runSetupScripts', () => {
  const makeTask = (projectPath: string, status: 'todo' | 'in_progress' | 'done' = 'todo'): Task => ({
    id: `task-${projectPath}`,
    name: `Task for ${projectPath}`,
    steps: [],
    status,
    order: 1,
    blockedBy: [],
    projectPath,
    verified: false,
  });

  const makeSprint = (setupRanAt: Record<string, string> = {}): Sprint => ({
    id: '20260101-000000-test',
    name: 'Test sprint',
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    activatedAt: '2026-01-01T00:00:00Z',
    closedAt: null,
    tickets: [],
    setupRanAt,
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // Default: spawnSync succeeds
    const { spawnSync } = await import('node:child_process');
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '', stderr: '', pid: 1, output: [], signal: null });

    const sprintStore = await import('@src/store/sprint.ts');
    vi.mocked(sprintStore.saveSprint).mockResolvedValue(undefined);
  });

  it('records timestamp on successful setup run', async () => {
    const { runSetupScripts } = await import('./runner.ts');
    const { getTasks } = await import('@src/store/task.ts');
    const { getProjectForTask, getEffectiveSetupScript } = await import('@src/ai/task-context.ts');
    const { saveSprint } = await import('@src/store/sprint.ts');

    const task = makeTask('/repo/alpha');
    const sprint = makeSprint();

    vi.mocked(getTasks).mockResolvedValue([task]);
    vi.mocked(getProjectForTask).mockResolvedValue(undefined);
    vi.mocked(getEffectiveSetupScript).mockReturnValue('pnpm install');

    const result = await runSetupScripts('sprint-1', sprint);

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Timestamp was written to the sprint object
    expect(sprint.setupRanAt['/repo/alpha']).toBeDefined();
    expect(typeof sprint.setupRanAt['/repo/alpha']).toBe('string');

    // saveSprint was called to persist the timestamp
    expect(saveSprint).toHaveBeenCalledWith(sprint);

    // Result map contains { ran: true, script }
    expect(result.results.get('/repo/alpha')).toEqual({ ran: true, script: 'pnpm install' });
  });

  it('skips setup and returns ran:true when setupRanAt already has a timestamp', async () => {
    const { runSetupScripts } = await import('./runner.ts');
    const { getTasks } = await import('@src/store/task.ts');
    const { getProjectForTask, getEffectiveSetupScript } = await import('@src/ai/task-context.ts');
    const { saveSprint } = await import('@src/store/sprint.ts');
    const { spawnSync } = await import('node:child_process');

    const task = makeTask('/repo/alpha');
    const sprint = makeSprint({ '/repo/alpha': '2026-01-01T00:00:00Z' });

    vi.mocked(getTasks).mockResolvedValue([task]);
    vi.mocked(getProjectForTask).mockResolvedValue(undefined);
    vi.mocked(getEffectiveSetupScript).mockReturnValue('pnpm install');

    const result = await runSetupScripts('sprint-1', sprint);

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Script was NOT actually executed
    expect(spawnSync).not.toHaveBeenCalled();

    // saveSprint was NOT called (nothing changed)
    expect(saveSprint).not.toHaveBeenCalled();

    // Result still reports ran:true so the AI agent context is correct
    expect(result.results.get('/repo/alpha')).toEqual({ ran: true, script: 'pnpm install' });
  });

  it('re-runs setup when refreshSetup=true even if setupRanAt has a timestamp', async () => {
    const { runSetupScripts } = await import('./runner.ts');
    const { getTasks } = await import('@src/store/task.ts');
    const { getProjectForTask, getEffectiveSetupScript } = await import('@src/ai/task-context.ts');
    const { saveSprint } = await import('@src/store/sprint.ts');
    const { spawnSync } = await import('node:child_process');

    const task = makeTask('/repo/alpha');
    const sprint = makeSprint({ '/repo/alpha': '2026-01-01T00:00:00Z' });

    vi.mocked(getTasks).mockResolvedValue([task]);
    vi.mocked(getProjectForTask).mockResolvedValue(undefined);
    vi.mocked(getEffectiveSetupScript).mockReturnValue('pnpm install');

    const result = await runSetupScripts('sprint-1', sprint, true /* refreshSetup */);

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Script WAS executed despite existing timestamp
    expect(spawnSync).toHaveBeenCalledWith(
      'pnpm install',
      expect.objectContaining({ cwd: '/repo/alpha', shell: true })
    );

    // Timestamp was updated and sprint persisted
    expect(saveSprint).toHaveBeenCalledWith(sprint);
    expect(result.results.get('/repo/alpha')).toEqual({ ran: true, script: 'pnpm install' });
  });

  it('persists first repo timestamp even when second repo setup fails', async () => {
    const { runSetupScripts } = await import('./runner.ts');
    const { getTasks } = await import('@src/store/task.ts');
    const { getProjectForTask, getEffectiveSetupScript } = await import('@src/ai/task-context.ts');
    const { saveSprint } = await import('@src/store/sprint.ts');
    const { spawnSync } = await import('node:child_process');

    const taskAlpha = makeTask('/repo/alpha');
    const taskBeta = makeTask('/repo/beta');
    const sprint = makeSprint();

    vi.mocked(getTasks).mockResolvedValue([taskAlpha, taskBeta]);
    vi.mocked(getProjectForTask).mockResolvedValue(undefined);
    vi.mocked(getEffectiveSetupScript).mockImplementation((_project, path) =>
      path === '/repo/alpha' ? 'pnpm install' : 'npm ci'
    );

    // First call (alpha) succeeds; second call (beta) fails with exit code 1
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '', pid: 1, output: [], signal: null })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'npm ci failed', pid: 2, output: [], signal: null });

    const result = await runSetupScripts('sprint-1', sprint);

    expect(result.success).toBe(false);

    // Alpha's timestamp was saved before beta failed
    expect(sprint.setupRanAt['/repo/alpha']).toBeDefined();
    expect(sprint.setupRanAt['/repo/beta']).toBeUndefined();

    // saveSprint was called exactly once (for alpha's successful run)
    expect(saveSprint).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// runPreFlightVerify and runPreFlightForTask tests
// ============================================================================

describe('runPreFlightVerify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns passed:true when spawnSync exits with 0', async () => {
    const { spawnSync } = await import('node:child_process');
    const { runPreFlightVerify } = await import('./executor.ts');

    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: 'All tests passed',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    });

    const result = runPreFlightVerify('/repo/alpha', 'pnpm test');

    expect(result.passed).toBe(true);
    expect(result.output).toContain('All tests passed');
  });

  it('returns passed:false when spawnSync exits with non-zero', async () => {
    const { spawnSync } = await import('node:child_process');
    const { runPreFlightVerify } = await import('./executor.ts');

    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: '',
      stderr: '3 tests failed',
      pid: 1,
      output: [],
      signal: null,
    });

    const result = runPreFlightVerify('/repo/alpha', 'pnpm test');

    expect(result.passed).toBe(false);
    expect(result.output).toContain('3 tests failed');
  });
});

describe('runPreFlightForTask', () => {
  const makeTask = (status: 'todo' | 'in_progress' | 'done' = 'todo'): Task => ({
    id: 'task-1',
    name: 'My task',
    steps: [],
    status,
    order: 1,
    blockedBy: [],
    projectPath: '/repo/alpha',
    verified: false,
  });

  const sprint: Sprint = {
    id: '20260101-000000-test',
    name: 'Test sprint',
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    activatedAt: '2026-01-01T00:00:00Z',
    closedAt: null,
    tickets: [],
    setupRanAt: {},
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns preFlightResult:null and blocked:false when no verifyScript', async () => {
    const { runPreFlightForTask } = await import('./executor.ts');

    const ctx: TaskContext = { sprint, task: makeTask() };
    const result = runPreFlightForTask(ctx, null);

    expect(result.preFlightResult).toBeNull();
    expect(result.blocked).toBe(false);
  });

  it('returns status:passed when verify script exits with 0', async () => {
    const { spawnSync } = await import('node:child_process');
    const { runPreFlightForTask } = await import('./executor.ts');

    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: 'All green',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    });

    const ctx: TaskContext = { sprint, task: makeTask('todo') };
    const result = runPreFlightForTask(ctx, 'pnpm test');

    expect(result.preFlightResult).toEqual({ status: 'passed', script: 'pnpm test' });
    expect(result.blocked).toBe(false);
  });

  it('returns status:failed-resuming when verify fails on an in_progress task', async () => {
    const { spawnSync } = await import('node:child_process');
    const { runPreFlightForTask } = await import('./executor.ts');

    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: '',
      stderr: '2 tests failed',
      pid: 1,
      output: [],
      signal: null,
    });

    const ctx: TaskContext = { sprint, task: makeTask('in_progress') };
    const result = runPreFlightForTask(ctx, 'pnpm test');

    expect(result.blocked).toBe(false);
    const pf = result.preFlightResult;
    if (pf?.status !== 'failed-resuming') {
      throw new Error('Expected failed-resuming pre-flight result');
    }
    expect(pf.status).toBe('failed-resuming');
    expect(pf.script).toBe('pnpm test');
    expect(pf.output).toContain('2 tests failed');
  });

  it('blocks the task when verify fails on todo task with no setupScript', async () => {
    const { spawnSync } = await import('node:child_process');
    const { getEffectiveSetupScript } = await import('@src/ai/task-context.ts');
    const { runPreFlightForTask } = await import('./executor.ts');

    // Verify fails
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'missing module',
      pid: 1,
      output: [],
      signal: null,
    });

    // No setup script configured
    vi.mocked(getEffectiveSetupScript).mockReturnValue(null);

    const ctx: TaskContext = { sprint, task: makeTask('todo') };
    const result = runPreFlightForTask(ctx, 'pnpm test');

    expect(result.blocked).toBe(true);
    expect(result.preFlightResult).toBeNull();
    expect(result.blockedReason).toContain('Pre-flight verification failed');
  });

  it('returns passed after successful self-heal (verify fails → setup → retry passes)', async () => {
    const { spawnSync } = await import('node:child_process');
    const { getEffectiveSetupScript } = await import('@src/ai/task-context.ts');
    const { runPreFlightForTask } = await import('./executor.ts');

    vi.mocked(getEffectiveSetupScript).mockReturnValue('pnpm install');

    // Call sequence:
    // 1. Initial verify → fails
    // 2. Setup (inherit stdio) → succeeds
    // 3. Retry verify → passes
    vi.mocked(spawnSync)
      // First verify call (piped stdio, returns stdout/stderr)
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'missing dep', pid: 1, output: [], signal: null })
      // Setup call (inherit stdio — stdout/stderr not captured, use empty strings)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '', pid: 2, output: [], signal: null })
      // Retry verify call (piped stdio, passes)
      .mockReturnValueOnce({ status: 0, stdout: 'all ok', stderr: '', pid: 3, output: [], signal: null });

    const ctx: TaskContext = { sprint, task: makeTask('todo') };
    const result = runPreFlightForTask(ctx, 'pnpm test');

    expect(result.blocked).toBe(false);
    expect(result.preFlightResult).toEqual({ status: 'passed', script: 'pnpm test' });
  });

  it('blocks task after self-heal when retry verify still fails', async () => {
    const { spawnSync } = await import('node:child_process');
    const { getEffectiveSetupScript } = await import('@src/ai/task-context.ts');
    const { runPreFlightForTask } = await import('./executor.ts');

    vi.mocked(getEffectiveSetupScript).mockReturnValue('pnpm install');

    // Call sequence:
    // 1. Initial verify → fails
    // 2. Setup → succeeds
    // 3. Retry verify → still fails
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'missing dep', pid: 1, output: [], signal: null })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '', pid: 2, output: [], signal: null })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'still failing', pid: 3, output: [], signal: null });

    const ctx: TaskContext = { sprint, task: makeTask('todo') };
    const result = runPreFlightForTask(ctx, 'pnpm test');

    expect(result.blocked).toBe(true);
    expect(result.preFlightResult).toBeNull();
    expect(result.blockedReason).toContain('Pre-flight verification failed');
  });
});
