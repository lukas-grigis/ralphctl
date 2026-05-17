import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { createShellScriptRunner, DEFAULT_SHELL_TIMEOUT_MS } from '@src/integration/io/shell-script-runner.ts';
import type { Spawn, SpawnOptions } from '@src/integration/io/spawn.ts';

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
}

const makeStream = (): EventEmitter & { setEncoding: (e: string) => void } => {
  const ee = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  ee.setEncoding = (): void => {};
  return ee;
};

const makeFakeChild = (script: FakeChildScript): ChildProcessWithoutNullStreams => {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & { _killed: boolean };
  const stdout = makeStream();
  const stderr = makeStream();
  Object.assign(child, {
    stdout,
    stderr,
    stdin: { end(): void {} },
    pid: 12345,
    kill(): boolean {
      child._killed = true;
      setTimeout(() => child.emit('close', null), 0);
      return true;
    },
    _killed: false,
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
): { spawn: Spawn; calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> } => {
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const spawn: Spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return makeFakeChild(script);
  };
  return { spawn, calls };
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
      expect(result.error.subCode).toBe('io');
      expect(result.error.message).toContain('ENOENT');
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

  it('uses default timeout of 5 minutes when none provided', async () => {
    expect(DEFAULT_SHELL_TIMEOUT_MS).toBe(5 * 60_000);
  });

  it('passes through env vars merged on top of process.env', async () => {
    const { spawn, calls } = fakeSpawn({ exitCode: 0 });
    const runner = createShellScriptRunner({ spawn });
    await runner.run(cwd, 'env', { env: { RALPHCTL_PHASE: 'post-task' } });

    expect(calls[0]?.options.env?.['RALPHCTL_PHASE']).toBe('post-task');
    // Some host env var leaks through (e.g. HOME or PATH).
    expect(Object.keys(calls[0]?.options.env ?? {}).length).toBeGreaterThan(1);
  });
});
