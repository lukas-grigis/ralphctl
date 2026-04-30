import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { NodeProcessRunner } from './process-runner.ts';

async function tmpAbs(): Promise<AbsolutePath> {
  const dir = await mkdtemp(join(tmpdir(), 'ralphctl-proc-runner-'));
  return AbsolutePath.trustString(dir);
}

describe('NodeProcessRunner', () => {
  it('captures stdout from a successful command', async () => {
    const cwd = await tmpAbs();
    const runner = new NodeProcessRunner();
    const r = await runner.run('node', ['-e', 'process.stdout.write("hello")'], { cwd });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.stdout).toBe('hello');
      expect(r.value.exitCode).toBe(0);
    }
  });

  it('captures stderr from a successful command', async () => {
    const cwd = await tmpAbs();
    const runner = new NodeProcessRunner();
    const r = await runner.run('node', ['-e', 'process.stderr.write("oops")'], { cwd });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.stderr).toBe('oops');
      expect(r.value.exitCode).toBe(0);
    }
  });

  it('reports a non-zero exit code', async () => {
    const cwd = await tmpAbs();
    const runner = new NodeProcessRunner();
    const r = await runner.run('node', ['-e', 'process.exit(7)'], { cwd });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.exitCode).toBe(7);
  });

  it('returns a StorageError when the binary does not exist', async () => {
    const cwd = await tmpAbs();
    const runner = new NodeProcessRunner();
    const r = await runner.run('/nonexistent/binary/path/ralphctl-test', [], { cwd });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('storage-error');
      expect(r.error.subCode).toBe('io');
    }
  });

  it('writes stdin to the child', async () => {
    const cwd = await tmpAbs();
    const runner = new NodeProcessRunner();
    const r = await runner.run(
      'node',
      ['-e', 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(s))'],
      { cwd, stdin: 'piped-input' }
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.stdout).toBe('piped-input');
  });

  it('merges env over process.env', async () => {
    const cwd = await tmpAbs();
    const runner = new NodeProcessRunner();
    const r = await runner.run('node', ['-e', 'process.stdout.write(String(process.env.RALPHCTL_PROC_RUNNER_TEST))'], {
      cwd,
      env: { RALPHCTL_PROC_RUNNER_TEST: 'value-42' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.stdout).toBe('value-42');
  });

  it('short-circuits when the abort signal is already aborted', async () => {
    const cwd = await tmpAbs();
    const runner = new NodeProcessRunner();
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await runner.run('node', ['-e', '0'], {
      cwd,
      abortSignal: ctrl.signal,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.subCode).toBe('io');
  });

  it('sends SIGTERM when aborted mid-run and exits within the grace window', async () => {
    const cwd = await tmpAbs();
    const runner = new NodeProcessRunner({ abortGraceMs: 1000 });
    const ctrl = new AbortController();

    // A child that traps SIGTERM and exits cleanly so we can observe the
    // signal-driven shutdown path without escalating to SIGKILL.
    const promise = runner.run('node', ['-e', 'process.on("SIGTERM",()=>process.exit(143));setTimeout(()=>{},5000)'], {
      cwd,
      abortSignal: ctrl.signal,
    });
    setTimeout(() => {
      ctrl.abort();
    }, 50);

    const r = await promise;
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Either 143 (caught SIGTERM) or null→1 if the child died from
      // SIGTERM without code. The point is the run resolved promptly.
      expect(r.value.exitCode).toBeGreaterThan(0);
    }
  });

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const cwd = await tmpAbs();
    const runner = new NodeProcessRunner({ abortGraceMs: 100 });
    const ctrl = new AbortController();

    // Child that swallows SIGTERM and would otherwise live for 5s.
    const promise = runner.run('node', ['-e', 'process.on("SIGTERM",()=>{});setTimeout(()=>{},5000)'], {
      cwd,
      abortSignal: ctrl.signal,
    });
    setTimeout(() => {
      ctrl.abort();
    }, 50);

    const r = await promise;
    expect(r.ok).toBe(true);
    if (r.ok) {
      // SIGKILL leaves the child with no exit code; node's child.close
      // yields code === null, which the runner normalises to 1.
      expect(r.value.exitCode).toBeGreaterThanOrEqual(1);
    }
  }, 5000);

  // Ported from afe771f9~1:src/integration/ai/session/process-manager.test.ts
  it('spawns the child in the requested cwd', async () => {
    if (process.platform === 'win32') return; // skip on Windows (pwd → different command)
    const cwd = await tmpAbs();
    const runner = new NodeProcessRunner();
    const r = await runner.run('pwd', [], { cwd });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // realpath in case tmpdir uses a symlink (macOS /var → /private/var).
      const { realpath } = await import('node:fs/promises');
      const resolved = await realpath(cwd);
      expect(r.value.stdout.trim()).toBe(resolved);
    }
  });

  it('ESRCH (process already gone) is tolerated — abort does not throw', async () => {
    // Verify that aborting after the child has already exited does not
    // surface as an error. The runner's abort listener catches the ESRCH
    // from child.kill() and swallows it — the settled result stays ok.
    const cwd = await tmpAbs();
    const runner = new NodeProcessRunner({ abortGraceMs: 200 });
    const ctrl = new AbortController();

    // Child exits immediately; abort races with close event.
    const promise = runner.run('node', ['-e', 'process.exit(0)'], {
      cwd,
      abortSignal: ctrl.signal,
    });
    // Abort after a short delay — child may already be gone by then.
    await new Promise((r) => setTimeout(r, 30));
    ctrl.abort();

    const r = await promise;
    // Either the child exited cleanly before abort, or the abort raced but
    // both paths should produce a Result (not a thrown exception).
    expect(r.ok).toBeDefined();
  }, 5_000);
});
