import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AbsolutePath } from '../../domain/values/absolute-path.ts';
import { readJsonFile, writeJsonFile } from './json-io.ts';

function uniqueRoot(): AbsolutePath {
  return AbsolutePath.trustString(
    join(tmpdir(), `ralphctl-jsonio-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`)
  );
}

const FIXTURE_SCHEMA = z.object({
  name: z.string(),
  count: z.number(),
});

type Fixture = z.infer<typeof FIXTURE_SCHEMA>;

describe('json-io', () => {
  let root: AbsolutePath;
  let target: AbsolutePath;

  beforeEach(async () => {
    root = uniqueRoot();
    await mkdir(root, { recursive: true });
    target = AbsolutePath.trustString(join(root, 'data.json'));
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });

  it('writes and reads a value through schema validation', async () => {
    const value: Fixture = { name: 'hello', count: 7 };
    const w = await writeJsonFile(target, value, FIXTURE_SCHEMA);
    expect(w.ok).toBe(true);
    const r = await readJsonFile(target, FIXTURE_SCHEMA);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(value);
  });

  it('returns io subCode when the file does not exist', async () => {
    const r = await readJsonFile(target, FIXTURE_SCHEMA);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.subCode).toBe('io');
      expect(r.error.path).toBe(target);
    }
  });

  it('returns parse subCode for invalid JSON', async () => {
    await writeFile(target, '{not json');
    const r = await readJsonFile(target, FIXTURE_SCHEMA);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.subCode).toBe('parse');
  });

  it('returns schema-mismatch for shape violations on read', async () => {
    await writeFile(target, JSON.stringify({ name: 1, count: 'no' }));
    const r = await readJsonFile(target, FIXTURE_SCHEMA);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.subCode).toBe('schema-mismatch');
  });

  it('returns schema-mismatch when writing an invalid value', async () => {
    const w = await writeJsonFile(target, { name: 'x', count: 'not-a-number' } as unknown as Fixture, FIXTURE_SCHEMA);
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.error.subCode).toBe('schema-mismatch');
  });

  it('writes through a temp file (atomic)', async () => {
    // Write a known-good value, then peek to confirm the file ends up at the
    // target path (not stuck at a tmp).
    const v: Fixture = { name: 'a', count: 1 };
    await writeJsonFile(target, v, FIXTURE_SCHEMA);
    const r = await readJsonFile(target, FIXTURE_SCHEMA);
    expect(r.ok).toBe(true);
  });

  it('overwrites an existing file', async () => {
    await writeJsonFile(target, { name: 'first', count: 1 }, FIXTURE_SCHEMA);
    await writeJsonFile(target, { name: 'second', count: 2 }, FIXTURE_SCHEMA);
    const r = await readJsonFile(target, FIXTURE_SCHEMA);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe('second');
  });

  it('creates the parent directory if missing', async () => {
    const nested = AbsolutePath.trustString(join(root, 'a', 'b', 'c', 'data.json'));
    const w = await writeJsonFile(nested, { name: 'n', count: 0 }, FIXTURE_SCHEMA);
    expect(w.ok).toBe(true);
  });
});
