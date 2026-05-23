/**
 * Unit tests for the AppendFile adapter (audit-[07]).
 *
 * Contract:
 *  - First call to a path creates parent directories and the file.
 *  - Subsequent calls to the same path concatenate.
 *  - Sequential appends preserve order (single-process).
 *  - A vanished parent directory is healed on the next call (cache invalidation).
 *  - Returns Result.error(StorageError) on filesystem failure; never throws.
 */

import { promises as fs } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { createAppendFile } from '@src/integration/io/append-file-adapter.ts';

const parsePath = (p: string): AbsolutePath => {
  const parsed = AbsolutePath.parse(p);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};

describe('createAppendFile', () => {
  let root: string;

  beforeEach(async () => {
    const raw = await mkdtemp(join(tmpdir(), 'ralphctl-append-'));
    root = await realpath(raw);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates the file on first call and writes the supplied text', async () => {
    const append = createAppendFile();
    const path = parsePath(join(root, 'a', 'b', 'journal.md'));
    const result = await append(path, 'hello\n');
    expect(result.ok).toBe(true);
    const contents = await readFile(String(path), 'utf8');
    expect(contents).toBe('hello\n');
  });

  it('concatenates across successive calls to the same path', async () => {
    const append = createAppendFile();
    const path = parsePath(join(root, 'journal.md'));
    await append(path, 'one\n');
    await append(path, 'two\n');
    await append(path, 'three\n');
    const contents = await readFile(String(path), 'utf8');
    expect(contents).toBe('one\ntwo\nthree\n');
  });

  it('creates parent directories implicitly (mkdir recursive)', async () => {
    const append = createAppendFile();
    const path = parsePath(join(root, 'deep', 'nested', 'tree', 'progress.md'));
    const result = await append(path, '# header\n');
    expect(result.ok).toBe(true);
    const stat = await fs.stat(String(path));
    expect(stat.isFile()).toBe(true);
  });

  it('heals a vanished parent directory between calls', async () => {
    const append = createAppendFile();
    const subdir = join(root, 'ephemeral');
    const path = parsePath(join(subdir, 'journal.md'));
    await append(path, 'before\n');
    await rm(subdir, { recursive: true, force: true });
    const result = await append(path, 'after\n');
    expect(result.ok).toBe(true);
    const contents = await readFile(String(path), 'utf8');
    expect(contents).toBe('after\n');
  });

  it('returns a StorageError when the underlying fs call fails', async () => {
    const collidingParent = join(root, 'not-a-dir');
    await fs.writeFile(collidingParent, 'sentinel');
    const append = createAppendFile();
    const path = parsePath(join(collidingParent, 'journal.md'));
    const result = await append(path, 'x');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(StorageError);
  });

  it('preserves byte-exact content (no encoding mangling)', async () => {
    const append = createAppendFile();
    const path = parsePath(join(root, 'utf8.md'));
    const payload = '## Task: foo\n\n- Verdict: pass\n';
    await append(path, payload);
    const contents = await readFile(String(path), 'utf8');
    expect(contents).toBe(payload);
  });
});
