import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeJsonAtomic, writeTextAtomic } from '@src/integration/io/fs.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';

describe('writeTextAtomic', () => {
  let root: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const tmp = await makeTmpRoot();
    root = String(tmp.root);
    cleanup = tmp.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  it('writes content durably and leaves no temp file behind', async () => {
    const target = join(root, 'state.json');
    const result = await writeTextAtomic(target, 'durable body\n');
    expect(result.ok).toBe(true);

    expect(await fs.readFile(target, 'utf8')).toBe('durable body\n');

    // The fsync-before-rename path must remove the sibling temp file on success.
    const siblings = await fs.readdir(root);
    expect(siblings.some((name) => name.includes('.tmp.'))).toBe(false);
    expect(siblings).toContain('state.json');
  });

  it('overwrites an existing file atomically (full new content, never partial)', async () => {
    const target = join(root, 'tasks.json');
    await fs.writeFile(target, 'old', 'utf8');

    const result = await writeTextAtomic(target, 'brand new content');
    expect(result.ok).toBe(true);
    expect(await fs.readFile(target, 'utf8')).toBe('brand new content');

    const siblings = await fs.readdir(root);
    expect(siblings.some((name) => name.includes('.tmp.'))).toBe(false);
  });

  it('creates intermediate directories and fsyncs the parent without error', async () => {
    const target = join(root, 'nested', 'deep', 'execution.json');
    const result = await writeTextAtomic(target, 'x');
    expect(result.ok).toBe(true);
    expect(await fs.readFile(target, 'utf8')).toBe('x');
  });

  it('writeJsonAtomic pretty-prints and round-trips', async () => {
    const target = join(root, 'sprint.json');
    const result = await writeJsonAtomic(target, { a: 1, b: ['x'] });
    expect(result.ok).toBe(true);

    const onDisk = await fs.readFile(target, 'utf8');
    expect(onDisk).toBe(`${JSON.stringify({ a: 1, b: ['x'] }, null, 2)}\n`);
    expect(JSON.parse(onDisk)).toEqual({ a: 1, b: ['x'] });
  });
});
