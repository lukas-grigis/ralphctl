/**
 * Tests for the cross-platform clipboard adapter. We script `spawn` so we never reach a real
 * `pbcopy` / `wl-copy` / `xclip` / `clip.exe` — that keeps the tests stable on whatever host
 * vitest happens to be running on.
 */

import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { createCopyToClipboard } from '@src/integration/io/clipboard.ts';
import type { Spawn } from '@src/integration/io/spawn.ts';

interface FakeChildOptions {
  readonly exitCode?: number | null;
  readonly errorOnSpawn?: Error;
  readonly errorOnWrite?: Error;
}

const makeFakeChild = (opts: FakeChildOptions = {}): ReturnType<Spawn> & { stdinChunks: string[] } => {
  const ee = new EventEmitter();
  const stdinChunks: string[] = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      if (opts.errorOnWrite) {
        cb(opts.errorOnWrite);
        return;
      }
      stdinChunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      cb();
    },
    final(cb) {
      cb();
      setImmediate(() => {
        if (opts.errorOnSpawn) ee.emit('error', opts.errorOnSpawn);
        else ee.emit('close', opts.exitCode ?? 0);
      });
    },
  });
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  // Cast through unknown: we satisfy only the surface the adapter touches.
  const child = ee as unknown as ReturnType<Spawn> & { stdinChunks: string[] };
  Object.assign(child, { stdin, stdout, stderr, stdinChunks });
  return child;
};

const spyOnSpawn = (children: Array<ReturnType<typeof makeFakeChild>>): Spawn => {
  let i = 0;
  return vi.fn(() => {
    const next = children[i] ?? children[children.length - 1];
    i += 1;
    if (next === undefined) throw new Error('test: no fake child queued');
    return next;
  }) as unknown as Spawn;
};

describe('createCopyToClipboard', () => {
  it('shells out to pbcopy on darwin and resolves ok on exit code 0', async () => {
    const fake = makeFakeChild({ exitCode: 0 });
    const spawn = spyOnSpawn([fake]);
    const copy = createCopyToClipboard({ spawn, platform: 'darwin', env: {} });

    const result = await copy('hello');
    expect(result.ok).toBe(true);
    expect(fake.stdinChunks.join('')).toBe('hello');
  });

  it('shells out to clip.exe on win32', async () => {
    const fake = makeFakeChild({ exitCode: 0 });
    const spawnCalls: Array<[string, readonly string[]]> = [];
    const spawn = vi.fn((cmd: string, args: readonly string[]) => {
      spawnCalls.push([cmd, args]);
      return fake;
    }) as unknown as Spawn;
    const copy = createCopyToClipboard({ spawn, platform: 'win32', env: {} });

    const result = await copy('payload');
    expect(result.ok).toBe(true);
    expect(spawnCalls[0]?.[0]).toBe('clip.exe');
  });

  it('prefers wl-copy when WAYLAND_DISPLAY is set on linux', async () => {
    const fake = makeFakeChild({ exitCode: 0 });
    const calls: string[] = [];
    const spawn = vi.fn((cmd: string) => {
      calls.push(cmd);
      return fake;
    }) as unknown as Spawn;
    const copy = createCopyToClipboard({ spawn, platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } });

    await copy('x');
    expect(calls[0]).toBe('wl-copy');
  });

  it('falls back to xclip when wl-copy is missing', async () => {
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
    const first = makeFakeChild({ errorOnSpawn: enoent });
    const second = makeFakeChild({ exitCode: 0 });
    const calls: string[] = [];
    const spawn = vi.fn((cmd: string) => {
      calls.push(cmd);
      return calls.length === 1 ? first : second;
    }) as unknown as Spawn;
    const copy = createCopyToClipboard({
      spawn,
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
    });

    const result = await copy('x');
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['wl-copy', 'xclip']);
  });

  it('returns unsupported-platform with no spawn when host has no helper', async () => {
    const spawn = vi.fn() as unknown as Spawn;
    const copy = createCopyToClipboard({ spawn, platform: 'aix' as NodeJS.Platform, env: {} });

    const result = await copy('x');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unsupported-platform');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns helper-nonzero when the helper exits with a non-zero status', async () => {
    const fake = makeFakeChild({ exitCode: 7 });
    const spawn = spyOnSpawn([fake]);
    const copy = createCopyToClipboard({ spawn, platform: 'darwin', env: {} });

    const result = await copy('x');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('helper-nonzero');
  });
});
