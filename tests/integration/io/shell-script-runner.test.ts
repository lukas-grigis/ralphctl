import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { createShellScriptRunner, DEFAULT_SHELL_TIMEOUT_MS } from '@src/integration/io/shell-script-runner.ts';
import type { Spawn, SpawnOptions } from '@src/integration/io/spawn.ts';
import { markProcessGroupLeader } from '@src/integration/io/kill-process-tree.ts';

const cwd = ((): AbsolutePath => {
  const r = AbsolutePath.parse('/tmp');
  if (!r.ok) throw new Error('test setup');
  return r.value;
})();

interface FakeChildScript {
  readonly stdout?: readonly string[];
  readonly stderr?: readonly string[];
  readonly exitCode?: number | null;
  readonly stdoutBeforeExitDelayMs?: number;
  readonly emitErrorMessage?: string;
  readonly hang?: boolean;
  /** Simulate a SIGTERM-trapping script: only a SIGKILL actually closes the child. */
  readonly trapSigterm?: boolean;
}

const makeStream = (): EventEmitter & { setEncoding: (e: string) => void } => {
  const ee = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  ee.setEncoding = (): void => {};
  return ee;
};

type FakeChild = ChildProcessWithoutNullStreams & {
  _killed: boolean;
  _signals: NodeJS.Signals[];
  _stdinEndCalls: number;
};

const makeFakeChild = (script: FakeChildScript): FakeChild => {
  const child = new EventEmitter() as FakeChild;
  const stdout = makeStream();
  const stderr = makeStream();
  Object.assign(child, {
    stdout,
    stderr,
    stdin: {
      on: () => undefined,
      end(): void {
        child._stdinEndCalls += 1;
      },
    },
    pid: 12345,
    kill(sig?: NodeJS.Signals): boolean {
      child._killed = true;
      child._signals.push(sig ?? 'SIGTERM');
      // A SIGTERM-trapping script ignores SIGTERM and only dies on the hard SIGKILL. Otherwise
      // any signal closes the child on the next tick (the original fake-child behaviour).
      if (script.trapSigterm === true && sig !== 'SIGKILL') return true;
      setTimeout(() => child.emit('close', null), 0);
      return true;
    },
    _killed: false,
    _signals: [],
    _stdinEndCalls: 0,
  });
  setTimeout(() => {
    for (const c of script.stdout ?? []) stdout.emit('data', Buffer.from(c, 'utf8'));
    for (const c of script.stderr ?? []) stderr.emit('data', Buffer.from(c, 'utf8'));
    if (script.emitErrorMessage !== undefined) {
      child.emit('error', new Error(script.emitErrorMessage));
      return;
    }
    if (script.hang === true) return;
    setTimeout(() => child.emit('close', script.exitCode ?? 0), script.stdoutBeforeExitDelayMs ?? 0);
  }, 0);
  return child;
};

const fakeSpawn = (
  script: FakeChildScript
): {
  spawn: Spawn;
  calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }>;
  children: FakeChild[];
} => {
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const children: FakeChild[] = [];
  const spawn: Spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = makeFakeChild(script);
    children.push(child);
    return child;
  };
  return { spawn, calls, children };
};

describe('createShellScriptRunner', () => {
  it('runs a green script (exit 0) and returns passed:true', async () => {
    const { spawn, calls } = fakeSpawn({ stdout: ['hello\n'], exitCode: 0 });
    const runner = createShellScriptRunner({ spawn });
    const result = await runner.run(cwd, 'echo hello');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.passed).toBe(true);
      expect(result.value.exitCode).toBe(0);
      expect(result.value.output).toBe('hello');
    }
    expect(calls[0]?.command).toBe('echo hello');
    expect(calls[0]?.options.shell).toBe(true);
    expect(calls[0]?.options.cwd).toBe('/tmp');
    expect(calls[0]?.options.detached).toBe(process.platform !== 'win32');
  });

  it('runs a red script (non-zero exit) and returns passed:false with combined output', async () => {
    const { spawn } = fakeSpawn({ stdout: ['ok\n'], stderr: ['boom\n'], exitCode: 1 });
    const runner = createShellScriptRunner({ spawn });
    const result = await runner.run(cwd, 'false');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.passed).toBe(false);
      expect(result.value.exitCode).toBe(1);
      expect(result.value.output).toBe('ok\nboom');
    }
  });

  it('returns StorageError when spawn itself throws', async () => {
    const spawn: Spawn = () => {
      throw new Error('ENOENT: shell missing');
    };
    const runner = createShellScriptRunner({ spawn });
    const result = await runner.run(cwd, 'true');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.error;
      if (err.code !== 'storage-error') throw new Error(`expected StorageError, got ${err.code}`);
      expect(err.subCode).toBe('io');
      expect(err.message).toContain('ENOENT');
    }
  });

  it('treats child error event as passed:false with marker (not a system error)', async () => {
    const { spawn } = fakeSpawn({ emitErrorMessage: 'shell vanished' });
    const runner = createShellScriptRunner({ spawn });
    const result = await runner.run(cwd, 'true');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.passed).toBe(false);
      expect(result.value.output).toContain('[spawn error: shell vanished]');
    }
  });

  it('honours per-call timeoutMs override and marks passed:false with timeout marker', async () => {
    const { spawn } = fakeSpawn({ hang: true });
    const runner = createShellScriptRunner({ spawn });
    const result = await runner.run(cwd, 'sleep 999', { timeoutMs: 5 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.passed).toBe(false);
      expect(result.value.output).toContain('[timeout exceeded after 5ms]');
    }
  });

  it('escalates a timeout kill to SIGKILL when the script traps SIGTERM', async () => {
    // The runner only settles on `close`; without escalation a SIGTERM-trapping script outlives the timeout.
    const { spawn, children } = fakeSpawn({ hang: true, trapSigterm: true });
    const runner = createShellScriptRunner({ spawn, abortKillGraceMs: 5 });
    const result = await runner.run(cwd, 'trap "" TERM; sleep 999', { timeoutMs: 10 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.passed).toBe(false);
      expect(result.value.output).toContain('[timeout exceeded after 10ms]');
    }
    expect(children[0]?._signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('sends exactly one SIGTERM and no SIGKILL when a timed-out child exits on SIGTERM', async () => {
    const { spawn, children } = fakeSpawn({ hang: true });
    const runner = createShellScriptRunner({ spawn, abortKillGraceMs: 30 });
    const result = await runner.run(cwd, 'sleep 999', { timeoutMs: 5 });

    expect(result.ok).toBe(true);
    // Outlast the grace window so a leaked SIGKILL timer would have fired.
    await new Promise((r) => setTimeout(r, 60));
    expect(children[0]?._signals).toEqual(['SIGTERM']);
  });

  it('closes the child stdin once after spawning', async () => {
    const { spawn, children } = fakeSpawn({ exitCode: 0 });
    const runner = createShellScriptRunner({ spawn });
    await runner.run(cwd, 'true');

    expect(children[0]?._stdinEndCalls).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('gives a stdin-reading script EOF instead of blocking', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ralphctl-shell-stdin-'));
    try {
      const parsed = AbsolutePath.parse(dir);
      if (!parsed.ok) throw new Error('test setup');
      const runner = createShellScriptRunner();
      const result = await runner.run(parsed.value, 'read x || echo eof', { timeoutMs: 5000 });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.output).toContain('eof');
        expect(result.value.durationMs).toBeLessThan(5000);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses default timeout of 5 minutes when none provided', async () => {
    expect(DEFAULT_SHELL_TIMEOUT_MS).toBe(5 * 60_000);
  });

  describe('abort signal', () => {
    // A held repo lock + a 5-minute verify timeout meant a Ctrl-C mid setup/verify was delayed
    // for up to that timeout. The runner now threads the chain's AbortSignal: an abort kills the
    // child tree promptly and surfaces as the codebase's AbortError (propagated transparently),
    // NOT as a passed:false gate failure.

    it('kills the child promptly and surfaces AbortError when aborted mid-run', async () => {
      // A hanging script never closes on its own; only the abort-triggered kill resolves it.
      const { spawn } = fakeSpawn({ hang: true });
      const runner = createShellScriptRunner({ spawn });
      const controller = new AbortController();

      // Abort on the next tick — after spawn, while the child is still "running".
      const pending = runner.run(cwd, 'sleep 999', { signal: controller.signal });
      setTimeout(() => controller.abort(), 0);
      const result = await pending;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.name).toBe('AbortError');
        expect(result.error.code).toBe('aborted');
      }
    });

    it('escalates SIGTERM → SIGKILL after the grace window for a SIGTERM-trapping script', async () => {
      // A script that traps SIGTERM ignores the first kill and would outlive the abort, stranding
      // the run on a resource a competitor may now own. The runner schedules a hard SIGKILL after
      // the grace window; only that signal closes this fake child. Inject a 5ms grace so the test
      // doesn't wait out the real 5s ladder.
      const { spawn, children } = fakeSpawn({ hang: true, trapSigterm: true });
      const runner = createShellScriptRunner({ spawn, abortKillGraceMs: 5 });
      const controller = new AbortController();

      const pending = runner.run(cwd, 'trap "" TERM; sleep 999', { signal: controller.signal });
      setTimeout(() => controller.abort(), 0);
      const result = await pending;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.name).toBe('AbortError');
        expect(result.error.code).toBe('aborted');
      }
      // The abort sent SIGTERM first, then escalated to SIGKILL once the grace window elapsed.
      const signals = children[0]?._signals ?? [];
      expect(signals).toContain('SIGTERM');
      expect(signals).toContain('SIGKILL');
      expect(signals.indexOf('SIGTERM')).toBeLessThan(signals.indexOf('SIGKILL'));
    });

    it('does not fire a stray SIGKILL when the child exits cleanly within the grace window', async () => {
      // A well-behaved child that closes on the abort's SIGTERM must NOT receive a later SIGKILL —
      // finish() clears the grace timer. A long grace makes a stray kill observable if it leaked.
      const { spawn, children } = fakeSpawn({ hang: true });
      const runner = createShellScriptRunner({ spawn, abortKillGraceMs: 10_000 });
      const controller = new AbortController();

      const pending = runner.run(cwd, 'sleep 999', { signal: controller.signal });
      setTimeout(() => controller.abort(), 0);
      const result = await pending;

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.name).toBe('AbortError');
      // The child closed on the SIGTERM; the grace timer was cleared, so no SIGKILL followed.
      const signals = children[0]?._signals ?? [];
      expect(signals).toContain('SIGTERM');
      expect(signals).not.toContain('SIGKILL');
    });

    it('short-circuits to AbortError without spawning when the signal is already aborted', async () => {
      const { spawn, calls } = fakeSpawn({ exitCode: 0 });
      const runner = createShellScriptRunner({ spawn });
      const controller = new AbortController();
      controller.abort();

      const result = await runner.run(cwd, 'echo hi', { signal: controller.signal });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.name).toBe('AbortError');
      }
      // Nothing was spawned — the short-circuit fires before the spawn() call.
      expect(calls).toHaveLength(0);
    });

    it('ignores the signal listener once the script settles normally', async () => {
      // A green run that completes before any abort must resolve passed:true, and a later abort
      // (post-settle) must not flip the already-resolved result.
      const { spawn } = fakeSpawn({ stdout: ['done\n'], exitCode: 0 });
      const runner = createShellScriptRunner({ spawn });
      const controller = new AbortController();

      const result = await runner.run(cwd, 'echo done', { signal: controller.signal });
      controller.abort(); // late abort — run already settled

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.passed).toBe(true);
        expect(result.value.output).toBe('done');
      }
    });
  });

  it('passes through env vars merged on top of process.env', async () => {
    const { spawn, calls } = fakeSpawn({ exitCode: 0 });
    const runner = createShellScriptRunner({ spawn });
    await runner.run(cwd, 'env', { env: { RALPHCTL_PHASE: 'post-task' } });

    expect(calls[0]?.options.env?.['RALPHCTL_PHASE']).toBe('post-task');
    // Some host env var leaks through (e.g. HOME or PATH).
    expect(Object.keys(calls[0]?.options.env ?? {}).length).toBeGreaterThan(1);
  });

  describe('NO_COLOR default', () => {
    // Persisted setup/verify logs are plain text — ANSI escape codes from vitest / eslint /
    // tsc render as `^[[1m^[[30m…` garbage when viewed in an editor. The runner sets
    // NO_COLOR=1 by default; modern Node / Python / Rust / Go / Ruby CLIs honour it. The
    // default sits BEFORE process.env so a user who exports NO_COLOR= (empty) or
    // FORCE_COLOR=1 can override; opts.env wins last.

    it('defaults NO_COLOR=1 on the spawn env', async () => {
      const originalNoColor = process.env['NO_COLOR'];
      const originalForceColor = process.env['FORCE_COLOR'];
      delete process.env['NO_COLOR'];
      delete process.env['FORCE_COLOR'];
      try {
        const { spawn, calls } = fakeSpawn({ exitCode: 0 });
        const runner = createShellScriptRunner({ spawn });
        await runner.run(cwd, 'true');

        expect(calls[0]?.options.env?.['NO_COLOR']).toBe('1');
      } finally {
        if (originalNoColor !== undefined) process.env['NO_COLOR'] = originalNoColor;
        if (originalForceColor !== undefined) process.env['FORCE_COLOR'] = originalForceColor;
      }
    });

    it('lets caller-supplied opts.env override the NO_COLOR default', async () => {
      const { spawn, calls } = fakeSpawn({ exitCode: 0 });
      const runner = createShellScriptRunner({ spawn });
      await runner.run(cwd, 'true', { env: { NO_COLOR: '' } });

      expect(calls[0]?.options.env?.['NO_COLOR']).toBe('');
    });

    it('lets a user-exported process.env.NO_COLOR override the default', async () => {
      const originalNoColor = process.env['NO_COLOR'];
      process.env['NO_COLOR'] = 'custom';
      try {
        const { spawn, calls } = fakeSpawn({ exitCode: 0 });
        const runner = createShellScriptRunner({ spawn });
        await runner.run(cwd, 'true');

        expect(calls[0]?.options.env?.['NO_COLOR']).toBe('custom');
      } finally {
        if (originalNoColor === undefined) delete process.env['NO_COLOR'];
        else process.env['NO_COLOR'] = originalNoColor;
      }
    });
  });

  describe('pnpm headless defaults (CI / frozen-lockfile)', () => {
    // Setup/verify scripts spawn with no TTY. pnpm 11 aborts its node_modules purge without a
    // TTY (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`) and ignores every confirm-modules-purge
    // form — `CI=true` is the only env lever that suppresses it. `PNPM_CONFIG_FROZEN_LOCKFILE=false`
    // neutralises CI's frozen-lockfile flip so a bare `pnpm install` keeps its pre-CI (non-frozen)
    // behaviour. Defaults sit BEFORE process.env so a user can opt out by exporting `CI=`.

    it('defaults CI=true and PNPM_CONFIG_FROZEN_LOCKFILE=false on the spawn env', async () => {
      const savedCi = process.env['CI'];
      const savedFrozen = process.env['PNPM_CONFIG_FROZEN_LOCKFILE'];
      delete process.env['CI'];
      delete process.env['PNPM_CONFIG_FROZEN_LOCKFILE'];
      try {
        const { spawn, calls } = fakeSpawn({ exitCode: 0 });
        const runner = createShellScriptRunner({ spawn });
        await runner.run(cwd, 'pnpm install');

        expect(calls[0]?.options.env?.['CI']).toBe('true');
        expect(calls[0]?.options.env?.['PNPM_CONFIG_FROZEN_LOCKFILE']).toBe('false');
      } finally {
        if (savedCi === undefined) delete process.env['CI'];
        else process.env['CI'] = savedCi;
        if (savedFrozen === undefined) delete process.env['PNPM_CONFIG_FROZEN_LOCKFILE'];
        else process.env['PNPM_CONFIG_FROZEN_LOCKFILE'] = savedFrozen;
      }
    });

    it('lets a user-exported process.env.CI override the default (opt-out)', async () => {
      const savedCi = process.env['CI'];
      process.env['CI'] = '';
      try {
        const { spawn, calls } = fakeSpawn({ exitCode: 0 });
        const runner = createShellScriptRunner({ spawn });
        await runner.run(cwd, 'true');

        expect(calls[0]?.options.env?.['CI']).toBe('');
      } finally {
        if (savedCi === undefined) delete process.env['CI'];
        else process.env['CI'] = savedCi;
      }
    });

    it('lets caller-supplied opts.env override the CI default', async () => {
      const { spawn, calls } = fakeSpawn({ exitCode: 0 });
      const runner = createShellScriptRunner({ spawn });
      await runner.run(cwd, 'true', { env: { CI: 'false' } });

      expect(calls[0]?.options.env?.['CI']).toBe('false');
    });

    it('lets a user-exported process.env.PNPM_CONFIG_FROZEN_LOCKFILE override the default', async () => {
      // Symmetry with the CI opt-out: the frozen-lockfile default also sits before process.env, so a
      // user who wants the frozen install (e.g. CI parity) can export it and win.
      const savedFrozen = process.env['PNPM_CONFIG_FROZEN_LOCKFILE'];
      process.env['PNPM_CONFIG_FROZEN_LOCKFILE'] = 'true';
      try {
        const { spawn, calls } = fakeSpawn({ exitCode: 0 });
        const runner = createShellScriptRunner({ spawn });
        await runner.run(cwd, 'pnpm install');

        expect(calls[0]?.options.env?.['PNPM_CONFIG_FROZEN_LOCKFILE']).toBe('true');
      } finally {
        if (savedFrozen === undefined) delete process.env['PNPM_CONFIG_FROZEN_LOCKFILE'];
        else process.env['PNPM_CONFIG_FROZEN_LOCKFILE'] = savedFrozen;
      }
    });
  });

  describe('process-group kill', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const negativePidKills = (spy: { mock: { calls: unknown[][] } }): unknown[][] =>
      spy.mock.calls.filter(([pid]) => typeof pid === 'number' && pid < 0);

    it('never signals a process group for an injected fake child on abort', async () => {
      // The fake's pid (12345) is made up; a group kill would hit whatever real group owns it.
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const { spawn, children } = fakeSpawn({ hang: true });
      const runner = createShellScriptRunner({ spawn });
      const controller = new AbortController();

      const pending = runner.run(cwd, 'sleep 999', { signal: controller.signal });
      setTimeout(() => controller.abort(), 0);
      const result = await pending;

      expect(result.ok).toBe(false);
      expect(negativePidKills(killSpy)).toEqual([]);
      expect(children[0]?._signals).toContain('SIGTERM');
    });

    it('never signals a process group for an injected fake child on timeout', async () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const { spawn, children } = fakeSpawn({ hang: true });
      const runner = createShellScriptRunner({ spawn });

      const result = await runner.run(cwd, 'sleep 999', { timeoutMs: 5 });

      expect(result.ok).toBe(true);
      expect(negativePidKills(killSpy)).toEqual([]);
      expect(children[0]?._killed).toBe(true);
    });

    it.skipIf(process.platform === 'win32')(
      'kills the forked grandchild of a real script on abort (default spawn leads its own group)',
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'ralphctl-shell-group-'));
        const pidFile = join(dir, 'grandchild.pid');
        const isAlive = (pid: number): boolean => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        };
        let grandchild: number | undefined;
        try {
          const runner = createShellScriptRunner({ abortKillGraceMs: 200 });
          const controller = new AbortController();
          const pending = runner.run(cwd, `sleep 30 & echo $! > '${pidFile}'; wait`, {
            signal: controller.signal,
          });
          await vi.waitFor(() => {
            if (!existsSync(pidFile) || readFileSync(pidFile, 'utf8').trim() === '') throw new Error('no pid yet');
          });
          grandchild = Number(readFileSync(pidFile, 'utf8').trim());
          expect(isAlive(grandchild)).toBe(true);

          controller.abort();
          const result = await pending;

          expect(result.ok).toBe(false);
          const pid = grandchild;
          await vi.waitFor(() => {
            expect(isAlive(pid)).toBe(false);
          });
        } finally {
          if (grandchild !== undefined && isAlive(grandchild)) process.kill(grandchild, 'SIGKILL');
          rmSync(dir, { recursive: true, force: true });
        }
      }
    );
  });

  describe.skipIf(process.platform === 'win32')('orphan reaper', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const fakeReaper = () => ({ watch: vi.fn<(pgid: number) => void>(), unwatch: vi.fn<(pgid: number) => void>() });

    // Marked like the real spawn's child so processGroupOf sees a group leader.
    const markedSpawn = (script: FakeChildScript): Spawn => {
      const { spawn } = fakeSpawn(script);
      return (command, args, options) => {
        const child = spawn(command, args, options);
        markProcessGroupLeader(child);
        return child;
      };
    };

    it('watches the group on spawn and unwatches it once on close', async () => {
      const reaper = fakeReaper();
      const runner = createShellScriptRunner({ spawn: markedSpawn({ exitCode: 0 }), reaper });

      const result = await runner.run(cwd, 'true');

      expect(result.ok).toBe(true);
      expect(reaper.watch.mock.calls).toEqual([[12345]]);
      expect(reaper.unwatch.mock.calls).toEqual([[12345]]);
    });

    it('unwatches once when the child errors', async () => {
      const reaper = fakeReaper();
      const runner = createShellScriptRunner({ spawn: markedSpawn({ emitErrorMessage: 'gone' }), reaper });

      await runner.run(cwd, 'true');

      expect(reaper.watch).toHaveBeenCalledTimes(1);
      expect(reaper.unwatch.mock.calls).toEqual([[12345]]);
    });

    it('unwatches once when the run is aborted', async () => {
      // The group signal reports ESRCH so the kill falls back to the fake's own kill(), which closes it.
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      });
      const reaper = fakeReaper();
      const runner = createShellScriptRunner({ spawn: markedSpawn({ hang: true }), reaper });
      const controller = new AbortController();

      const pending = runner.run(cwd, 'sleep 999', { signal: controller.signal });
      setTimeout(() => controller.abort(), 0);
      const result = await pending;

      expect(result.ok).toBe(false);
      expect(reaper.watch).toHaveBeenCalledTimes(1);
      expect(reaper.unwatch.mock.calls).toEqual([[12345]]);
    });

    it('never watches an unmarked fake child', async () => {
      const reaper = fakeReaper();
      const { spawn } = fakeSpawn({ exitCode: 0 });
      const runner = createShellScriptRunner({ spawn, reaper });

      await runner.run(cwd, 'true');

      expect(reaper.watch).not.toHaveBeenCalled();
      expect(reaper.unwatch).not.toHaveBeenCalled();
    });
  });
});
