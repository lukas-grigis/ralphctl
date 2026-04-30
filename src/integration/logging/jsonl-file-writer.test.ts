/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AbsolutePath } from '../../domain/values/absolute-path.ts';
import { IsoTimestamp } from '../../domain/values/iso-timestamp.ts';
import { resolveStoragePaths, type StoragePaths } from '../persistence/storage-paths.ts';
import { JsonlFileWriter } from './jsonl-file-writer.ts';

function uniqueRoot(): AbsolutePath {
  return AbsolutePath.trustString(
    join(tmpdir(), `ralphctl-jsonl-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`)
  );
}

const NOW = IsoTimestamp.trustString('2026-04-29T00:00:00.000Z');

describe('JsonlFileWriter', () => {
  let root: AbsolutePath;
  let paths: StoragePaths;

  beforeEach(() => {
    root = uniqueRoot();
    paths = resolveStoragePaths({ root });
    // Don't pre-create logs dir — the writer must mkdir on first write.
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes a record under <logsDir>/<session-id>.jsonl', async () => {
    const w = new JsonlFileWriter({ sessionId: 'sess-1', logsDir: paths.logsDir });
    const r = await w.write({ level: 'info', message: 'hello', timestamp: NOW });
    expect(r.ok).toBe(true);
    await w.dispose();

    const file = join(paths.logsDir, 'sess-1.jsonl');
    const body = await readFile(file, 'utf-8');
    expect(body.trim()).toBe(JSON.stringify({ level: 'info', message: 'hello', timestamp: NOW }));
    expect(w.path).toBe(file);
  });

  it('appends multiple records, one per line, in call order', async () => {
    const w = new JsonlFileWriter({ sessionId: 'sess-2', logsDir: paths.logsDir });
    await w.write({ level: 'info', message: 'a', timestamp: NOW });
    await w.write({ level: 'warn', message: 'b', timestamp: NOW });
    await w.write({ level: 'error', message: 'c', timestamp: NOW });
    await w.dispose();

    const body = await readFile(join(paths.logsDir, 'sess-2.jsonl'), 'utf-8');
    const lines = body.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect((JSON.parse(lines[0]!) as Record<string, unknown>)['message']).toBe('a');
    expect((JSON.parse(lines[1]!) as Record<string, unknown>)['message']).toBe('b');
    expect((JSON.parse(lines[2]!) as Record<string, unknown>)['message']).toBe('c');
  });

  it('serialises concurrent writes (no byte interleaving)', async () => {
    const w = new JsonlFileWriter({ sessionId: 'sess-3', logsDir: paths.logsDir });
    const all = await Promise.all(
      Array.from({ length: 20 }, (_, i) => w.write({ level: 'info', message: `m${String(i)}`, timestamp: NOW }))
    );
    expect(all.every((r) => r.ok)).toBe(true);
    await w.dispose();

    const body = await readFile(join(paths.logsDir, 'sess-3.jsonl'), 'utf-8');
    const lines = body.trim().split('\n');
    expect(lines).toHaveLength(20);
    for (const line of lines) {
      // Every line must round-trip as valid JSON — interleaving would break parse.
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });

  it('round-trips a context payload alongside the level/message/timestamp', async () => {
    const w = new JsonlFileWriter({ sessionId: 'sess-4', logsDir: paths.logsDir });
    await w.write({
      level: 'info',
      message: 'started',
      timestamp: NOW,
      context: { sprintId: 'abc', taskId: 'def', count: 3 },
    });
    await w.dispose();

    const body = await readFile(join(paths.logsDir, 'sess-4.jsonl'), 'utf-8');
    const obj = JSON.parse(body.trim()) as Record<string, unknown>;
    expect(obj['sprintId']).toBe('abc');
    expect(obj['taskId']).toBe('def');
    expect(obj['count']).toBe(3);
  });

  it('creates the logs directory lazily on first write', async () => {
    // Confirm the directory does not exist yet.
    await expect(readFile(paths.logsDir)).rejects.toBeDefined();

    const w = new JsonlFileWriter({ sessionId: 'sess-5', logsDir: paths.logsDir });
    await w.write({ level: 'info', message: 'lazy', timestamp: NOW });
    await w.dispose();

    const body = await readFile(join(paths.logsDir, 'sess-5.jsonl'), 'utf-8');
    expect(body).toContain('lazy');
  });

  it('reuses an existing logs directory without error', async () => {
    await mkdir(paths.logsDir, { recursive: true });
    const w = new JsonlFileWriter({ sessionId: 'sess-6', logsDir: paths.logsDir });
    const r = await w.write({ level: 'info', message: 'ok', timestamp: NOW });
    expect(r.ok).toBe(true);
    await w.dispose();
  });

  it('returns an error from write() after dispose()', async () => {
    const w = new JsonlFileWriter({ sessionId: 'sess-7', logsDir: paths.logsDir });
    await w.write({ level: 'info', message: 'first', timestamp: NOW });
    await w.dispose();
    const r = await w.write({ level: 'info', message: 'after', timestamp: NOW });
    expect(r.ok).toBe(false);
  });

  it('dispose() is idempotent', async () => {
    const w = new JsonlFileWriter({ sessionId: 'sess-8', logsDir: paths.logsDir });
    await w.write({ level: 'info', message: 'one', timestamp: NOW });
    await w.dispose();
    await expect(w.dispose()).resolves.toBeUndefined();
  });

  // Ported from afe771f9~1:src/integration/logging — legacy coverage
  it('disposing without ever writing creates no file', async () => {
    const { existsSync } = await import('node:fs');
    const w = new JsonlFileWriter({ sessionId: 'sess-9', logsDir: paths.logsDir });
    await w.dispose();
    // No file should have been created.
    expect(existsSync(join(paths.logsDir, 'sess-9.jsonl'))).toBe(false);
  });
});
