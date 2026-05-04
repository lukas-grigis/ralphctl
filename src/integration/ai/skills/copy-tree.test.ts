import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { copyTree } from './copy-tree.ts';

function uniqueRoot(): string {
  return join(
    tmpdir(),
    `ralphctl-copy-tree-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
  );
}

describe('copyTree', () => {
  let root: string;
  let src: string;
  let dst: string;

  beforeEach(async () => {
    root = uniqueRoot();
    src = join(root, 'src');
    dst = join(root, 'dst');
    await mkdir(src, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('copies a flat directory of files', async () => {
    await writeFile(join(src, 'a.txt'), 'A', 'utf-8');
    await writeFile(join(src, 'b.txt'), 'B', 'utf-8');

    const r = await copyTree(src, dst);
    expect(r.ok).toBe(true);

    expect(await readFile(join(dst, 'a.txt'), 'utf-8')).toBe('A');
    expect(await readFile(join(dst, 'b.txt'), 'utf-8')).toBe('B');
  });

  it('recursively copies nested directories', async () => {
    await mkdir(join(src, 'nested', 'deep'), { recursive: true });
    await writeFile(join(src, 'nested', 'deep', 'leaf.txt'), 'L', 'utf-8');

    const r = await copyTree(src, dst);
    expect(r.ok).toBe(true);

    expect(await readFile(join(dst, 'nested', 'deep', 'leaf.txt'), 'utf-8')).toBe('L');
  });

  it('creates the destination if it does not exist (mkdir -p semantics)', async () => {
    await writeFile(join(src, 'one.txt'), '1', 'utf-8');
    const target = join(dst, 'does', 'not', 'exist');

    const r = await copyTree(src, target);
    expect(r.ok).toBe(true);

    expect(await readFile(join(target, 'one.txt'), 'utf-8')).toBe('1');
  });

  it('resolves a symlink and writes the underlying file (no symlinks in dst)', async () => {
    await writeFile(join(src, 'real.txt'), 'real', 'utf-8');
    await symlink(join(src, 'real.txt'), join(src, 'link.txt'));

    const r = await copyTree(src, dst);
    expect(r.ok).toBe(true);

    const entries = await readdir(dst);
    expect(entries.sort()).toStrictEqual(['link.txt', 'real.txt']);
    // Both should be plain files with the same body — link.txt is a copy,
    // not a symlink.
    expect(await readFile(join(dst, 'link.txt'), 'utf-8')).toBe('real');
  });

  it('returns a StorageError when the source does not exist', async () => {
    const r = await copyTree(join(root, 'missing'), dst);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.subCode).toBe('io');
  });

  it('refuses to follow a symlink that targets a directory (would risk infinite recursion)', async () => {
    await mkdir(join(src, 'real-dir'), { recursive: true });
    await writeFile(join(src, 'real-dir', 'inside.txt'), 'X', 'utf-8');
    await symlink(join(src, 'real-dir'), join(src, 'dir-link'));

    const r = await copyTree(src, dst);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('symlink target is not a regular file');
  });
});
