import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { createGitRunner } from '@src/integration/io/git-runner.ts';
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
  Object.assign(child, {
    stdout: makeStream(),
    stderr: makeStream(),
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
    for (const c of script.stdout ?? []) (child.stdout as EventEmitter).emit('data', Buffer.from(c, 'utf8'));
    for (const c of script.stderr ?? []) (child.stderr as EventEmitter).emit('data', Buffer.from(c, 'utf8'));
    if (script.emitErrorMessage !== undefined) {
      child.emit('error', new Error(script.emitErrorMessage));
      return;
    }
    if (script.hang === true) return;
    setTimeout(() => child.emit('close', script.exitCode ?? 0), 0);
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

describe('createGitRunner', () => {
  it('captures stdout and exit code from a successful run', async () => {
    const { spawn, calls } = fakeSpawn({ stdout: ['main\n'], exitCode: 0 });
    const runner = createGitRunner({ spawn });
    const result = await runner.run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stdout).toBe('main\n');
      expect(result.value.exitCode).toBe(0);
    }
    expect(calls[0]?.command).toBe('git');
    expect(calls[0]?.args).toEqual(['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(calls[0]?.options.cwd).toBe('/tmp');
    expect(calls[0]?.options.shell).toBeUndefined();
  });

  it('surfaces non-zero exits as Result.ok with stderr captured (caller decides)', async () => {
    const { spawn } = fakeSpawn({ stderr: ['fatal: not a git repo\n'], exitCode: 128 });
    const runner = createGitRunner({ spawn });
    const result = await runner.run(cwd, ['status']);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exitCode).toBe(128);
      expect(result.value.stderr).toContain('fatal');
    }
  });

  it('returns StorageError(io) when spawn throws synchronously', async () => {
    const spawn: Spawn = () => {
      throw new Error('ENOENT: git missing');
    };
    const runner = createGitRunner({ spawn });
    const result = await runner.run(cwd, ['status']);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.subCode).toBe('io');
  });

  it('returns StorageError(io) when child emits an error event', async () => {
    const { spawn } = fakeSpawn({ emitErrorMessage: 'broken pipe' });
    const runner = createGitRunner({ spawn });
    const result = await runner.run(cwd, ['status']);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.subCode).toBe('io');
      expect(result.error.message).toContain('broken pipe');
    }
  });

  it('times out and returns StorageError(io) when child hangs', async () => {
    const { spawn } = fakeSpawn({ hang: true });
    const runner = createGitRunner({ spawn });
    const result = await runner.run(cwd, ['log'], { timeoutMs: 5 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.subCode).toBe('io');
      expect(result.error.message).toContain('timed out');
    }
  });

  it('caps oversized stdout: returns truncated output with marker, exits ok (not a timeout), kills the child', async () => {
    // Drive a tiny injected cap so we exercise the byte ceiling without buffering 50 MB. Two
    // chunks below the cap each, but cumulatively over it — the second trips truncation.
    const { spawn } = fakeSpawn({ stdout: ['aaaa', 'bbbb', 'cccc'], exitCode: 0 });
    let killed = false;
    const trackedSpawn: Spawn = (command, args, options) => {
      const child = spawn(command, args, options) as ChildProcessWithoutNullStreams & { _killed: boolean };
      const origKill = child.kill.bind(child);
      child.kill = ((sig?: NodeJS.Signals | number): boolean => {
        killed = true;
        return origKill(sig);
      }) as typeof child.kill;
      return child;
    };
    const runner = createGitRunner({ spawn: trackedSpawn, maxOutputBytes: 6 });
    const result = await runner.run(cwd, ['diff', 'HEAD']);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stdout).toContain('[git output exceeded 6 byte cap — truncated]');
      // Only the chunks accepted before the cap tripped are retained; the dropped chunk is gone.
      expect(result.value.stdout).toContain('aaaa');
      expect(result.value.stdout).not.toContain('cccc');
      // Cap-truncation must NOT be misreported as a timeout StorageError.
      expect(result.error).toBeUndefined();
    }
    expect(killed).toBe(true);
  });

  it('does not append a marker for small output under the cap', async () => {
    const { spawn } = fakeSpawn({ stdout: ['main\n'], exitCode: 0 });
    const runner = createGitRunner({ spawn, maxOutputBytes: 6 });
    const result = await runner.run(cwd, ['rev-parse', 'HEAD']);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stdout).toBe('main\n');
      expect(result.value.stdout).not.toContain('truncated');
    }
  });

  it('passes args verbatim — no shell, so quotes / backticks / newlines stay literal', async () => {
    const { spawn, calls } = fakeSpawn({ exitCode: 0 });
    const runner = createGitRunner({ spawn });
    const message = "feat(x): ` $foo \" 'bar'\nsecond line";
    await runner.run(cwd, ['commit', '-m', message]);

    expect(calls[0]?.args[2]).toBe(message);
  });
});
