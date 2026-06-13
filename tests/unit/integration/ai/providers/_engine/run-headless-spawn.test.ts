/**
 * Lifecycle tests for the shared headless-spawn helper. The provider adapters delegate every
 * "attach listeners → install watchdog → await exit → detach" choreography to this helper, so
 * any bug here multiplies across claude / codex / copilot. Tests focus on:
 *
 *  - Listener detach in finally on the success path.
 *  - Listener detach even when the close-await throws (provider-level error after attach).
 *  - Stdin handling: prompt sent when provided, stdin closed when omitted (copilot's argv path).
 *  - Watchdog stop is called even when the await rejects.
 */

import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessSpawn } from '@src/integration/ai/providers/_engine/run-headless-spawn.ts';

interface FakeChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdoutListeners: () => number;
  readonly stderrListeners: () => number;
  readonly stdinEnd: (chunk?: string) => void;
  readonly stdinEndChunks: string[];
  readonly emitClose: (code: number | null, signal: NodeJS.Signals | null) => void;
  readonly emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  readonly emitError: (err: NodeJS.ErrnoException) => void;
  readonly emitStdinError: (err: NodeJS.ErrnoException) => void;
  readonly emitStdout: (chunk: string) => void;
  readonly emitStderr: (chunk: string) => void;
}

interface MakeFakeChildOpts {
  /** When set, `stdin.end()` synchronously throws — exercises the destroyed-stream guard. */
  readonly stdinEndThrows?: boolean;
}

const makeFakeChild = (opts: MakeFakeChildOpts = {}): FakeChild => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  // stdin is an EventEmitter Writable in production — the helper attaches an `'error'` listener
  // to swallow EPIPE against a dead child, so the fake must support `.on`.
  const stdin = new EventEmitter();
  const stdinEndChunks: string[] = [];
  Object.assign(stdin, {
    end: (chunk?: string) => {
      if (opts.stdinEndThrows === true) throw new Error('write after end');
      stdinEndChunks.push(chunk ?? '<no-arg>');
    },
  });
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    stdout,
    stderr,
    stdin,
    kill: vi.fn().mockReturnValue(true),
  });
  // setEncoding is called by the helper — accept it as a no-op.
  Object.assign(stdout, { setEncoding: () => undefined });
  Object.assign(stderr, { setEncoding: () => undefined });
  return {
    child,
    stdoutListeners: () => stdout.listenerCount('data'),
    stderrListeners: () => stderr.listenerCount('data'),
    stdinEnd: (chunk) => stdinEndChunks.push(chunk ?? '<no-arg>'),
    stdinEndChunks,
    emitClose: (code, signal) => child.emit('close', code, signal),
    emitExit: (code, signal) => child.emit('exit', code, signal),
    emitError: (err) => child.emit('error', err),
    emitStdinError: (err) => stdin.emit('error', err),
    emitStdout: (chunk) => stdout.emit('data', chunk),
    emitStderr: (chunk) => stderr.emit('data', chunk),
  };
};

const errno = (code: string, message: string): NodeJS.ErrnoException => {
  const e = new Error(message) as NodeJS.ErrnoException;
  e.code = code;
  return e;
};

describe('runHeadlessSpawn', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('detaches stdout/stderr listeners after a successful close', async () => {
    const f = makeFakeChild();
    const onStdout = vi.fn();
    const onStderr = vi.fn();
    const p = runHeadlessSpawn({
      child: f.child,
      onStdout,
      onStderr,
      stdin: 'prompt',
      resolveOn: 'close',
      idleMs: 1000,
    });

    // Listeners attached.
    expect(f.stdoutListeners()).toBeGreaterThan(0);
    expect(f.stderrListeners()).toBeGreaterThan(0);

    // Stream a chunk to verify the listener is wired.
    f.emitStdout('hi');
    expect(onStdout).toHaveBeenCalledWith('hi');

    f.emitClose(0, null);
    const result = await p;
    expect(result).toEqual({ code: 0, signal: null });

    // After resolution the helper must have stripped its listeners.
    expect(f.stdoutListeners()).toBe(0);
    expect(f.stderrListeners()).toBe(0);
  });

  it('sends prompt via stdin.end when `stdin` is provided', async () => {
    const f = makeFakeChild();
    const p = runHeadlessSpawn({
      child: f.child,
      onStdout: () => undefined,
      onStderr: () => undefined,
      stdin: 'hello-world',
      resolveOn: 'close',
      idleMs: 1000,
    });
    f.emitClose(0, null);
    await p;
    expect(f.stdinEndChunks).toEqual(['hello-world']);
  });

  it('closes stdin without a payload when `stdin` is omitted (copilot argv path)', async () => {
    const f = makeFakeChild();
    const p = runHeadlessSpawn({
      child: f.child,
      onStdout: () => undefined,
      onStderr: () => undefined,
      resolveOn: 'exit',
      idleMs: 1000,
    });
    f.emitExit(0, null);
    await p;
    // `<no-arg>` is the sentinel our fake records when `end()` is called with no payload.
    expect(f.stdinEndChunks).toEqual(['<no-arg>']);
  });

  it('detaches listeners even when the watchdog kills the child via SIGTERM', async () => {
    const f = makeFakeChild();
    const p = runHeadlessSpawn({
      child: f.child,
      onStdout: () => undefined,
      onStderr: () => undefined,
      stdin: 'p',
      resolveOn: 'close',
      idleMs: 100,
      onIdle: () => undefined,
    });

    // Trip the watchdog: advance time past idle. The fake child's kill is a no-op so we still
    // need to emit close ourselves to drain the await; the assertion is that listeners detach.
    vi.advanceTimersByTime(150);
    f.emitClose(null, 'SIGTERM');
    const result = await p;
    expect(result.signal).toBe('SIGTERM');
    expect(f.stdoutListeners()).toBe(0);
    expect(f.stderrListeners()).toBe(0);
  });

  // FINDING 1 — a failed spawn (missing / non-executable binary, ENOENT / EACCES) or a child
  // that dies before stdin drains raises an `'error'` event. Without a listener Node treats it
  // as an unhandled error and kills the whole ralphctl process. The helper must resolve the exit
  // promise with the captured error so classifySpawnExit can convert it to an InvalidStateError.
  it('resolves with spawnError (code/signal null) when the child emits an error event', async () => {
    const f = makeFakeChild();
    const p = runHeadlessSpawn({
      child: f.child,
      onStdout: () => undefined,
      onStderr: () => undefined,
      stdin: 'prompt',
      resolveOn: 'close',
      idleMs: 1000,
    });

    f.emitError(errno('ENOENT', 'spawn claude ENOENT'));
    const result = await p;
    expect(result.code).toBeNull();
    expect(result.signal).toBeNull();
    expect(result.spawnError?.code).toBe('ENOENT');
    expect(result.spawnError?.message).toContain('ENOENT');
    // Listeners still detach on the error path (the finally runs).
    expect(f.stdoutListeners()).toBe(0);
    expect(f.stderrListeners()).toBe(0);
  });

  it('latches the first settle: a real exit after an error event does not overwrite spawnError', async () => {
    const f = makeFakeChild();
    const p = runHeadlessSpawn({
      child: f.child,
      onStdout: () => undefined,
      onStderr: () => undefined,
      resolveOn: 'exit',
      idleMs: 1000,
    });

    f.emitError(errno('EACCES', 'spawn EACCES'));
    // A late exit can still fire — it must NOT clobber the already-resolved spawn error.
    f.emitExit(1, null);
    const result = await p;
    expect(result.spawnError?.code).toBe('EACCES');
    expect(result.code).toBeNull();
  });

  it('swallows an EPIPE on stdin against a dead child (no unhandled error)', async () => {
    const f = makeFakeChild();
    const p = runHeadlessSpawn({
      child: f.child,
      onStdout: () => undefined,
      onStderr: () => undefined,
      stdin: 'prompt',
      resolveOn: 'close',
      idleMs: 1000,
    });

    // Emit an EPIPE on the stdin stream — the helper's swallow handler must absorb it so it never
    // surfaces as an unhandled 'error' that would crash the process. The spawn `'error'` event is
    // what drives the real outcome.
    expect(() => f.emitStdinError(errno('EPIPE', 'write EPIPE'))).not.toThrow();
    f.emitError(errno('ENOENT', 'spawn claude ENOENT'));
    const result = await p;
    expect(result.spawnError?.code).toBe('ENOENT');
  });

  it('tolerates a synchronous throw from stdin.end (destroyed stream) — error event still drives the outcome', async () => {
    const f = makeFakeChild({ stdinEndThrows: true });
    const p = runHeadlessSpawn({
      child: f.child,
      onStdout: () => undefined,
      onStderr: () => undefined,
      stdin: 'prompt',
      resolveOn: 'close',
      idleMs: 1000,
    });

    f.emitError(errno('ENOENT', 'spawn claude ENOENT'));
    const result = await p;
    expect(result.spawnError?.code).toBe('ENOENT');
    expect(f.stdoutListeners()).toBe(0);
  });
});
