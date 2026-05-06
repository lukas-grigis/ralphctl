// Ported from afe771f9~1:src/integration/external/lifecycle.test.ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { CheckScriptRunner } from './check-script-runner.ts';

async function tmpAbs(): Promise<AbsolutePath> {
  const dir = await mkdtemp(join(tmpdir(), 'ralphctl-check-runner-'));
  return AbsolutePath.trustString(dir);
}

describe('CheckScriptRunner', () => {
  it('returns passed=true when the script exits zero', async () => {
    const cwd = await tmpAbs();
    const runner = new CheckScriptRunner();
    const r = await runner.run(cwd, 'echo hello', 'setup');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.passed).toBe(true);
      expect(r.value.output).toContain('hello');
    }
  });

  it('returns passed=false when the script exits non-zero', async () => {
    const cwd = await tmpAbs();
    const runner = new CheckScriptRunner();
    const r = await runner.run(cwd, 'exit 7', 'post-task');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.passed).toBe(false);
  });

  it('captures both stdout and stderr in combined output', async () => {
    const cwd = await tmpAbs();
    const runner = new CheckScriptRunner();
    const r = await runner.run(cwd, 'echo on-stdout; echo on-stderr 1>&2', 'feedback');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.output).toContain('on-stdout');
      expect(r.value.output).toContain('on-stderr');
    }
  });

  it('passes the phase via RALPHCTL_LIFECYCLE_EVENT env var', async () => {
    const cwd = await tmpAbs();
    const runner = new CheckScriptRunner();
    const r = await runner.run(cwd, 'echo "$RALPHCTL_LIFECYCLE_EVENT"', 'post-task');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.output).toContain('post-task');
  });

  it('honours the per-call timeout and emits a marker', async () => {
    const cwd = await tmpAbs();
    const runner = new CheckScriptRunner();
    // 50ms timeout, script sleeps 5s — should be killed.
    const r = await runner.run(cwd, 'sleep 5', 'setup', 50);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.passed).toBe(false);
      expect(r.value.output).toContain('timeout exceeded');
    }
  }, 10_000);

  it('returns passed=false (not Result.error) when the script does not exist', async () => {
    const cwd = await tmpAbs();
    const runner = new CheckScriptRunner();
    // Non-existent command — shell exits 127. Not a system error —
    // a missing tool is a config issue the harness should surface as a
    // failed gate, not a crash.
    const r = await runner.run(cwd, 'definitely-not-a-real-binary-xyz', 'setup');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.passed).toBe(false);
  });

  it('handles scripts producing more than 2 MB of output (maxBuffer regression)', async () => {
    // Legacy regression: spawnSync default maxBuffer=1 MB caused the child
    // to be killed with a spurious error. The runner must buffer at least
    // 2 MB and still return passed=true for an exit-0 script.
    if (process.platform === 'win32') return; // skip on Windows
    const cwd = await tmpAbs();
    const runner = new CheckScriptRunner();
    // Emit 2 MB via node (fs.writeSync is synchronous so bytes flush before exit).
    const script = 'node -e "const fs=require(\\"fs\\"); fs.writeSync(1, \\"x\\".repeat(2*1024*1024))"';
    const r = await runner.run(cwd, script, 'setup');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.passed).toBe(true);
      expect(r.value.output.length).toBeGreaterThanOrEqual(2 * 1024 * 1024);
    }
  }, 15_000);

  it('timeout kills the child process (not just rejects promise)', async () => {
    // Verify that a timed-out script is actually killed — the output should
    // contain the timeout marker and passed should be false.
    if (process.platform === 'win32') return; // skip on Windows
    const cwd = await tmpAbs();
    const runner = new CheckScriptRunner();
    const r = await runner.run(cwd, 'sleep 5', 'setup', 100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.passed).toBe(false);
      expect(r.value.output).toContain('timeout exceeded after 100ms');
    }
  }, 10_000);
});

// NOTE: RALPHCTL_SETUP_TIMEOUT_MS env var regression (afe771f9~1:lifecycle.test.ts)
// The legacy runLifecycleHook read RALPHCTL_SETUP_TIMEOUT_MS from the environment
// to set the default timeout. The src CheckScriptRunner accepts a constructor
// argument instead, but the composition root (shared-deps.ts) instantiates it as
// `new CheckScriptRunner()` without reading the env var — so the env-var override
// path is not wired in src. This is a behavioral regression that requires a
// source-code change to fix (reading the env var in shared-deps.ts or in the
// CheckScriptRunner constructor). Test intentionally omitted here; fix required.
