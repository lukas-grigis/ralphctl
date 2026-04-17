import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

describe('runLifecycleHook', () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), 'ralphctl-lifecycle-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env['RALPHCTL_SETUP_TIMEOUT_MS'];
  });

  it('returns passed:true on exit 0', async () => {
    const { spawnSync } = await import('node:child_process');
    const { runLifecycleHook } = await import('./lifecycle.ts');

    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: 'All tests passed',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    });

    const result = runLifecycleHook(tempDir, 'pnpm test', 'taskComplete');

    expect(result.passed).toBe(true);
    expect(result.output).toContain('All tests passed');
  });

  it('returns passed:false on non-zero exit', async () => {
    const { spawnSync } = await import('node:child_process');
    const { runLifecycleHook } = await import('./lifecycle.ts');

    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: '',
      stderr: '3 tests failed',
      pid: 1,
      output: [],
      signal: null,
    });

    const result = runLifecycleHook(tempDir, 'pnpm test', 'sprintStart');

    expect(result.passed).toBe(false);
    expect(result.output).toContain('3 tests failed');
  });

  it('captures both stdout and stderr in output', async () => {
    const { spawnSync } = await import('node:child_process');
    const { runLifecycleHook } = await import('./lifecycle.ts');

    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: 'stdout content',
      stderr: 'stderr content',
      pid: 1,
      output: [],
      signal: null,
    });

    const result = runLifecycleHook(tempDir, 'pnpm test', 'taskComplete');

    expect(result.output).toContain('stdout content');
    expect(result.output).toContain('stderr content');
  });

  it('uses RALPHCTL_SETUP_TIMEOUT_MS env var for timeout', async () => {
    const { spawnSync } = await import('node:child_process');
    const { runLifecycleHook } = await import('./lifecycle.ts');

    process.env['RALPHCTL_SETUP_TIMEOUT_MS'] = '30000';

    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    });

    runLifecycleHook(tempDir, 'pnpm test', 'sprintStart');

    expect(spawnSync).toHaveBeenCalledWith('pnpm test', expect.objectContaining({ timeout: 30000 }));
  });
});
