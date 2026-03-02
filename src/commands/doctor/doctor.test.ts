import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestEnvironment } from '@src/test-utils/setup.ts';
import { createTestEnv } from '@src/test-utils/setup.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

let testEnv: TestEnvironment;

beforeEach(async () => {
  testEnv = await createTestEnv();
  process.env['RALPHCTL_ROOT'] = testEnv.testDir;
});

afterEach(async () => {
  delete process.env['RALPHCTL_ROOT'];
  await testEnv.cleanup();
  vi.restoreAllMocks();
});

/** Capture console.log output during a callback */
async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return logs.join('\n');
}

describe('doctor command', () => {
  it('reports Node.js version as pass', async () => {
    const { doctorCommand } = await import('./doctor.ts');
    const output = await captureOutput(() => doctorCommand());

    // Node >= 24 in this project
    expect(output).toContain('Node.js version');
    expect(output).toMatch(/\+.*Node\.js version/);
  });

  it('reports git installed as pass', async () => {
    const { doctorCommand } = await import('./doctor.ts');
    const output = await captureOutput(() => doctorCommand());

    expect(output).toContain('Git installed');
    expect(output).toMatch(/\+.*Git installed/);
  });

  it('reports git identity check', async () => {
    const { doctorCommand } = await import('./doctor.ts');
    const output = await captureOutput(() => doctorCommand());

    // In test environments git identity may or may not be set
    expect(output).toContain('Git identity');
  });

  it('skips AI provider when not configured', async () => {
    const { doctorCommand } = await import('./doctor.ts');
    const output = await captureOutput(() => doctorCommand());

    expect(output).toContain('AI provider binary');
    expect(output).toContain('not configured');
  });

  it('checks AI provider binary when configured', async () => {
    // Set provider to claude in config
    await writeFile(
      join(testEnv.testDir, 'config.json'),
      JSON.stringify({ currentSprint: null, aiProvider: 'claude' })
    );

    const { doctorCommand } = await import('./doctor.ts');
    const output = await captureOutput(() => doctorCommand());

    expect(output).toContain('AI provider binary');
    expect(output).toContain('claude');
  });

  it('reports data directory status', async () => {
    const { doctorCommand } = await import('./doctor.ts');
    const output = await captureOutput(() => doctorCommand());

    expect(output).toContain('Data directory');
    // The test env creates the data dir, so it should pass
    expect(output).toMatch(/\+.*Data directory/);
  });

  it('reports project paths when projects exist', async () => {
    // createTestEnv sets up a project with a valid path
    const { doctorCommand } = await import('./doctor.ts');
    const output = await captureOutput(() => doctorCommand());

    expect(output).toContain('Project paths');
    // The test project path exists but may not have .git — expect fail or pass
  });

  it('skips project paths when no projects registered', async () => {
    // Overwrite projects.json with empty array
    await writeFile(join(testEnv.testDir, 'projects.json'), JSON.stringify([]));

    const { doctorCommand } = await import('./doctor.ts');
    const output = await captureOutput(() => doctorCommand());

    expect(output).toContain('Project paths');
    expect(output).toContain('no projects registered');
  });

  it('skips current sprint when none set', async () => {
    const { doctorCommand } = await import('./doctor.ts');
    const output = await captureOutput(() => doctorCommand());

    expect(output).toContain('Current sprint');
    expect(output).toContain('no current sprint set');
  });

  it('validates current sprint when set', async () => {
    // Create a sprint and set it as current
    const { createSprint } = await import('@src/store/sprint.ts');
    const { setCurrentSprint } = await import('@src/store/config.ts');

    const sprint = await createSprint('Doctor Test');
    await setCurrentSprint(sprint.id);

    const { doctorCommand } = await import('./doctor.ts');
    const output = await captureOutput(() => doctorCommand());

    expect(output).toContain('Current sprint');
    expect(output).toContain('Doctor Test');
    expect(output).toMatch(/\+.*Current sprint/);
  });

  it('detects invalid current sprint reference', async () => {
    // Set a nonexistent sprint ID
    await writeFile(join(testEnv.testDir, 'config.json'), JSON.stringify({ currentSprint: '99999999-999999-ghost' }));

    const { doctorCommand } = await import('./doctor.ts');
    const output = await captureOutput(() => doctorCommand());

    expect(output).toContain('Current sprint');
    expect(output).toMatch(/x.*Current sprint/);
  });

  it('shows summary line', async () => {
    const { doctorCommand } = await import('./doctor.ts');
    const output = await captureOutput(() => doctorCommand());

    // Should contain a summary with checks passed count
    expect(output).toMatch(/checks passed/);
  });

  it('shows Ralph quote at the end', async () => {
    const { doctorCommand } = await import('./doctor.ts');
    const output = await captureOutput(() => doctorCommand());

    // Should end with a quoted Ralph Wiggum line (contains ")
    expect(output).toContain('"');
  });

  it('detects missing project path', async () => {
    // Set up a project with a nonexistent path
    await writeFile(
      join(testEnv.testDir, 'projects.json'),
      JSON.stringify([
        {
          name: 'ghost-project',
          displayName: 'Ghost Project',
          repositories: [{ name: 'ghost', path: '/tmp/this-definitely-does-not-exist-ralphctl-test' }],
        },
      ])
    );

    const { doctorCommand } = await import('./doctor.ts');
    const output = await captureOutput(() => doctorCommand());

    expect(output).toMatch(/x.*Project paths/);
    expect(output).toContain('ghost-project');
  });

  it('detects project path that is not a git repo', async () => {
    // The test project dir exists but doesn't have .git
    const { doctorCommand } = await import('./doctor.ts');
    const output = await captureOutput(() => doctorCommand());

    expect(output).toContain('Project paths');
    // projectDir from createTestEnv doesn't have .git, so should fail
    expect(output).toContain('not a git repository');
  });

  it('passes project paths when repo has .git', async () => {
    // Create a .git directory in the test project dir
    await mkdir(join(testEnv.projectDir, '.git'), { recursive: true });

    const { doctorCommand } = await import('./doctor.ts');
    const output = await captureOutput(() => doctorCommand());

    expect(output).toContain('Project paths');
    expect(output).toMatch(/\+.*Project paths/);
    expect(output).toContain('1 repo verified');
  });
});
