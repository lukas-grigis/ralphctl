import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestEnvironment } from '@src/test-utils/setup.ts';
import { captureOutput, createTestEnv } from '@src/test-utils/setup.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

let testEnv: TestEnvironment;

beforeEach(async () => {
  vi.resetModules();
  testEnv = await createTestEnv();
  process.env['RALPHCTL_ROOT'] = testEnv.testDir;
  process.exitCode = undefined;
});

afterEach(async () => {
  delete process.env['RALPHCTL_ROOT'];
  process.exitCode = undefined;
  await testEnv.cleanup();
  vi.restoreAllMocks();
});

// ============================================================================
// Unit tests — assert on CheckResult objects directly
// ============================================================================

describe('check functions', () => {
  it('checkNodeVersion returns pass for Node >= 24', async () => {
    const { checkNodeVersion } = await import('./doctor.ts');
    const result = checkNodeVersion();

    expect(result.status).toBe('pass');
    expect(result.name).toBe('Node.js version');
    expect(result.detail).toMatch(/^v\d+/);
  });

  it('checkGitInstalled returns pass when git is available', async () => {
    const { checkGitInstalled } = await import('./doctor.ts');
    const result = checkGitInstalled();

    expect(result.status).toBe('pass');
    expect(result.name).toBe('Git installed');
    expect(result.detail).toMatch(/git version/);
  });

  it('checkGitIdentity returns pass or warn', async () => {
    const { checkGitIdentity } = await import('./doctor.ts');
    const result = checkGitIdentity();

    expect(result.name).toBe('Git identity');
    // CI may not have git identity configured — warn is acceptable
    expect(['pass', 'warn']).toContain(result.status);
    if (result.status === 'pass') {
      expect(result.detail).toContain('<');
    } else {
      expect(result.detail).toContain('missing');
    }
  });

  it('checkAiProvider returns skip when not configured', async () => {
    const { checkAiProvider } = await import('./doctor.ts');
    const result = await checkAiProvider();

    expect(result.status).toBe('skip');
    expect(result.detail).toBe('not configured');
  });

  it('checkAiProvider checks binary when configured', async () => {
    await writeFile(
      join(testEnv.testDir, 'config.json'),
      JSON.stringify({ currentSprint: null, aiProvider: 'claude' })
    );

    const { checkAiProvider } = await import('./doctor.ts');
    const result = await checkAiProvider();

    expect(result.name).toBe('AI provider binary');
    expect(result.detail).toContain('claude');
    // Pass or fail depending on whether claude CLI is installed
    expect(['pass', 'fail']).toContain(result.status);
  });

  it('checkDataDirectory returns pass for writable dir', async () => {
    const { checkDataDirectory } = await import('./doctor.ts');
    const result = await checkDataDirectory();

    expect(result.status).toBe('pass');
    expect(result.detail).toBe(testEnv.testDir);
  });

  it('checkProjectPaths returns skip when no projects', async () => {
    await writeFile(join(testEnv.testDir, 'projects.json'), JSON.stringify([]));

    const { checkProjectPaths } = await import('./doctor.ts');
    const result = await checkProjectPaths();

    expect(result.status).toBe('skip');
    expect(result.detail).toBe('no projects registered');
  });

  it('checkProjectPaths returns fail when path is not a git repo', async () => {
    // Default test env has a project dir without .git
    const { checkProjectPaths } = await import('./doctor.ts');
    const result = await checkProjectPaths();

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('not a git repository');
  });

  it('checkProjectPaths returns pass when repo has .git', async () => {
    await mkdir(join(testEnv.projectDir, '.git'), { recursive: true });

    const { checkProjectPaths } = await import('./doctor.ts');
    const result = await checkProjectPaths();

    expect(result.status).toBe('pass');
    expect(result.detail).toBe('1 repo verified');
  });

  it('checkProjectPaths detects missing path', async () => {
    await writeFile(
      join(testEnv.testDir, 'projects.json'),
      JSON.stringify([
        {
          id: 'prjghost1',
          name: 'ghost-project',
          displayName: 'Ghost Project',
          repositories: [{ id: 'repoghost', name: 'ghost', path: '/tmp/this-definitely-does-not-exist-ralphctl-test' }],
        },
      ])
    );

    const { checkProjectPaths } = await import('./doctor.ts');
    const result = await checkProjectPaths();

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('ghost-project');
  });

  it('checkProjectPaths passes for tilde path pointing to existing directory', async () => {
    // Create a .git dir so the repo check also passes
    await mkdir(join(testEnv.projectDir, '.git'), { recursive: true });

    // Create a subdirectory to use as a tilde-expanded path
    const fakeHome = testEnv.projectDir;
    const subDir = join(fakeHome, 'myrepo');
    await mkdir(join(subDir, '.git'), { recursive: true });

    // Store a project with a tilde path — mock homedir so ~ resolves to fakeHome
    vi.doMock('node:os', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:os')>();
      return { ...actual, homedir: () => fakeHome };
    });

    await writeFile(
      join(testEnv.testDir, 'projects.json'),
      JSON.stringify([
        {
          id: 'prjtilde1',
          name: 'tilde-project',
          displayName: 'Tilde Project',
          repositories: [{ id: 'repotild1', name: 'myrepo', path: '~/myrepo' }],
        },
      ])
    );

    const { checkProjectPaths } = await import('./doctor.ts');
    const result = await checkProjectPaths();

    expect(result.status).toBe('pass');
    expect(result.detail).toBe('1 repo verified');
  });

  it('checkProjectPaths fails for tilde path pointing to nonexistent directory', async () => {
    const fakeHome = testEnv.projectDir;

    vi.doMock('node:os', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:os')>();
      return { ...actual, homedir: () => fakeHome };
    });

    await writeFile(
      join(testEnv.testDir, 'projects.json'),
      JSON.stringify([
        {
          id: 'prjghost2',
          name: 'ghost-tilde',
          displayName: 'Ghost Tilde',
          repositories: [{ id: 'reponope1', name: 'nope', path: '~/nonexistent-dir' }],
        },
      ])
    );

    const { checkProjectPaths } = await import('./doctor.ts');
    const result = await checkProjectPaths();

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('ghost-tilde');
  });

  it('checkCurrentSprint returns skip when none set', async () => {
    const { checkCurrentSprint } = await import('./doctor.ts');
    const result = await checkCurrentSprint();

    expect(result.status).toBe('skip');
    expect(result.detail).toBe('no current sprint set');
  });

  it('checkCurrentSprint returns pass for valid sprint', async () => {
    const { createSprint } = await import('@src/integration/persistence/sprint.ts');
    const { setCurrentSprint } = await import('@src/integration/persistence/config.ts');

    const sprint = await createSprint({ projectId: testEnv.projectId, name: 'Doctor Test' });
    await setCurrentSprint(sprint.id);

    const { checkCurrentSprint } = await import('./doctor.ts');
    const result = await checkCurrentSprint();

    expect(result.status).toBe('pass');
    expect(result.detail).toContain('Doctor Test');
  });

  it('checkCurrentSprint returns fail for missing sprint file', async () => {
    await writeFile(join(testEnv.testDir, 'config.json'), JSON.stringify({ currentSprint: '99999999-999999-ghost' }));

    const { checkCurrentSprint } = await import('./doctor.ts');
    const result = await checkCurrentSprint();

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('sprint file missing');
  });

  it('checkEvaluationConfig warns when evaluationIterations not set', async () => {
    // Default config.json has no evaluationIterations field
    const { checkEvaluationConfig } = await import('./doctor.ts');
    const result = await checkEvaluationConfig();

    expect(result.name).toBe('Evaluation config');
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('not set');
  });

  it('checkEvaluationConfig passes when evaluationIterations is set', async () => {
    const { setEvaluationIterations } = await import('@src/integration/persistence/config.ts');
    await setEvaluationIterations(2);

    const { checkEvaluationConfig } = await import('./doctor.ts');
    const result = await checkEvaluationConfig();

    expect(result.status).toBe('pass');
    expect(result.detail).toContain('2');
  });

  it('checkEvaluationConfig passes when evaluationIterations is explicitly 0 (disabled)', async () => {
    const { setEvaluationIterations } = await import('@src/integration/persistence/config.ts');
    await setEvaluationIterations(0);

    const { checkEvaluationConfig } = await import('./doctor.ts');
    const result = await checkEvaluationConfig();

    expect(result.status).toBe('pass');
    expect(result.detail).toContain('0');
  });
});

// ============================================================================
// Integration tests — full command output
// ============================================================================

describe('doctor command', () => {
  it('prints all check names and summary', async () => {
    const { doctorCommand } = await import('./doctor.ts');
    const output = await captureOutput(() => doctorCommand());

    expect(output).toContain('Node.js version');
    expect(output).toContain('Git installed');
    expect(output).toContain('Git identity');
    expect(output).toContain('AI provider binary');
    expect(output).toContain('Data directory');
    expect(output).toContain('Project paths');
    expect(output).toContain('Current sprint');
    expect(output).toMatch(/checks passed/);
  });

  it('shows Ralph quote at the end', async () => {
    const { doctorCommand } = await import('./doctor.ts');
    const output = await captureOutput(() => doctorCommand());

    expect(output).toContain('"');
  });

  it('sets exit code when checks fail', async () => {
    // Point to a nonexistent data directory
    process.env['RALPHCTL_ROOT'] = '/tmp/this-definitely-does-not-exist-ralphctl-doctor';

    const { doctorCommand } = await import('./doctor.ts');
    await captureOutput(() => doctorCommand());

    expect(process.exitCode).toBe(1);
  });

  it('does not set exit code when only warnings present', async () => {
    // Create .git so project paths pass
    await mkdir(join(testEnv.projectDir, '.git'), { recursive: true });

    const { doctorCommand } = await import('./doctor.ts');
    await captureOutput(() => doctorCommand());

    // Git identity might warn, but no failures — exit code should remain unset
    expect(process.exitCode).toBeUndefined();
  });
});
