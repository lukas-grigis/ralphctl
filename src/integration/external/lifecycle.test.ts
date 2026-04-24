import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runLifecycleHook } from './lifecycle.ts';

describe('runLifecycleHook', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ralphctl-lifecycle-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env['RALPHCTL_SETUP_TIMEOUT_MS'];
  });

  it('returns passed:true on exit 0', async () => {
    const result = await runLifecycleHook(tempDir, 'echo "All tests passed"', 'taskComplete');
    expect(result.passed).toBe(true);
    expect(result.output).toContain('All tests passed');
  });

  it('returns passed:false on non-zero exit', async () => {
    const result = await runLifecycleHook(tempDir, 'echo "3 tests failed" >&2; exit 1', 'sprintStart');
    expect(result.passed).toBe(false);
    expect(result.output).toContain('3 tests failed');
  });

  it('captures both stdout and stderr in output', async () => {
    const result = await runLifecycleHook(tempDir, 'echo stdout-content; echo stderr-content >&2', 'taskComplete');
    expect(result.output).toContain('stdout-content');
    expect(result.output).toContain('stderr-content');
  });

  it('captures >2MB of output without buffer overflow (regression for #maxBuffer)', async () => {
    // Emit 2 MB of stdout synchronously via fs.writeSync. With the old
    // spawnSync + default 1 MB maxBuffer, Node would kill the child with
    // SIGTERM and status: null, making the check spuriously "fail" even
    // though the script exited 0. fs.writeSync is used instead of
    // process.stdout.write so the bytes flush before the child exits
    // (process.stdout.write is asynchronous when stdio is piped).
    const script = 'node -e "const fs=require(\\"fs\\"); fs.writeSync(1, \\"x\\".repeat(2*1024*1024))"';
    const result = await runLifecycleHook(tempDir, script, 'sprintStart');
    expect(result.passed).toBe(true);
    expect(result.output.length).toBeGreaterThanOrEqual(2 * 1024 * 1024);
  }, 15_000);

  it('kills the child and marks failed on timeout', async () => {
    const result = await runLifecycleHook(tempDir, 'sleep 5', 'taskComplete', 200);
    expect(result.passed).toBe(false);
    expect(result.output).toContain('timeout exceeded after 200ms');
  });

  it('uses RALPHCTL_SETUP_TIMEOUT_MS env var when no explicit override given', async () => {
    process.env['RALPHCTL_SETUP_TIMEOUT_MS'] = '150';
    const result = await runLifecycleHook(tempDir, 'sleep 5', 'sprintStart');
    expect(result.passed).toBe(false);
    expect(result.output).toContain('timeout exceeded after 150ms');
  });
});
