import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createFsLogTailReader, DEFAULT_LOG_TAIL_BYTES } from '@src/integration/io/read-log-tail.ts';

describe('createFsLogTailReader', () => {
  let dir: string;

  beforeEach(async () => {
    const raw = await mkdtemp(join(tmpdir(), 'ralphctl-log-tail-'));
    dir = await realpath(raw);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the file contents verbatim when the file is smaller than the cap', async () => {
    const path = join(dir, 'small.log');
    await writeFile(path, 'hello world\n', 'utf8');
    const reader = createFsLogTailReader();
    const tail = await reader(absolutePath(path));
    expect(tail).toBe('hello world\n');
  });

  it('returns only the trailing `maxBytes` when the file is larger than the cap', async () => {
    const path = join(dir, 'big.log');
    const huge = 'A'.repeat(DEFAULT_LOG_TAIL_BYTES * 2) + 'FINAL_LINE';
    await writeFile(path, huge, 'utf8');
    const reader = createFsLogTailReader();
    const tail = await reader(absolutePath(path));
    expect(tail).toBeDefined();
    if (tail === undefined) return;
    // Tail is capped at the default; the marker isn't injected at this layer (the
    // adapter is intentionally bytes-only — callers prepend a "(truncated)" marker
    // when they need one).
    expect(Buffer.from(tail, 'utf8').length).toBeLessThanOrEqual(DEFAULT_LOG_TAIL_BYTES);
    expect(tail.endsWith('FINAL_LINE')).toBe(true);
  });

  it('honours a smaller `maxBytes` cap', async () => {
    const path = join(dir, 'tiny.log');
    await writeFile(path, 'ABCDEFGHIJ', 'utf8');
    const reader = createFsLogTailReader();
    const tail = await reader(absolutePath(path), 4);
    expect(tail).toBe('GHIJ');
  });

  it('returns undefined when the file is missing (display surfaces fall back gracefully)', async () => {
    const reader = createFsLogTailReader();
    const tail = await reader(absolutePath(join(dir, 'does-not-exist.log')));
    expect(tail).toBeUndefined();
  });

  it('returns empty string for an empty file', async () => {
    const path = join(dir, 'empty.log');
    await writeFile(path, '', 'utf8');
    const reader = createFsLogTailReader();
    const tail = await reader(absolutePath(path));
    expect(tail).toBe('');
  });
});
