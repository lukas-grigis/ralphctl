import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';

describe('createAtomicWriteFile', () => {
  let root: AbsolutePath;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const tmp = await makeTmpRoot();
    root = tmp.root;
    cleanup = tmp.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  it('writes a fresh file at the requested absolute path', async () => {
    const adapter = createAtomicWriteFile();
    const target = AbsolutePath.parse(join(String(root), 'fresh.md'));
    expect(target.ok).toBe(true);
    if (!target.ok) return;

    const result = await adapter(target.value, '# hello\n');
    expect(result.ok).toBe(true);

    const onDisk = await fs.readFile(String(target.value), 'utf8');
    expect(onDisk).toBe('# hello\n');
  });

  it('creates intermediate directories when they do not exist', async () => {
    const adapter = createAtomicWriteFile();
    const target = AbsolutePath.parse(join(String(root), 'nested', 'sub', 'file.md'));
    expect(target.ok).toBe(true);
    if (!target.ok) return;

    const result = await adapter(target.value, 'body');
    expect(result.ok).toBe(true);

    const onDisk = await fs.readFile(String(target.value), 'utf8');
    expect(onDisk).toBe('body');
  });

  it('overwrites an existing file in-place (atomic rename)', async () => {
    const adapter = createAtomicWriteFile();
    const target = AbsolutePath.parse(join(String(root), 'existing.md'));
    expect(target.ok).toBe(true);
    if (!target.ok) return;

    await fs.writeFile(String(target.value), 'old content', 'utf8');

    const result = await adapter(target.value, 'new content');
    expect(result.ok).toBe(true);

    const onDisk = await fs.readFile(String(target.value), 'utf8');
    expect(onDisk).toBe('new content');
  });
});
