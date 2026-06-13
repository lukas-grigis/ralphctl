/**
 * heap-snapshot — best-effort post-mortem dump contract.
 *
 * Two things to pin:
 *  - Happy path: writes a real `.heapsnapshot` file into a tmp dir (v8.writeHeapSnapshot runs
 *    in-process; the file is small for the test process but non-empty) and returns its path.
 *    The injected clock drives a deterministic, fs-safe filename.
 *  - Failure path: when the underlying v8 write throws, the helper returns {ok:false} and NEVER
 *    throws — a failure near-OOM must not crash the process further.
 *
 * Why the failure path uses a real I/O fault (not a v8 mock): `v8.writeHeapSnapshot` lives on an
 * ESM module namespace that is not configurable, so `vi.spyOn` can't redefine it. Instead we make
 * the target "directory" collide with an existing regular file — `mkdirSync(dir, {recursive})`
 * then throws ENOTDIR/EEXIST, which is exactly the kind of near-OOM fs fault we must survive.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeHeapSnapshotToDir } from '@src/integration/observability/heap-snapshot.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'heap-snapshot-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeHeapSnapshotToDir', () => {
  it('writes a non-empty .heapsnapshot file and returns its path', () => {
    const result = writeHeapSnapshotToDir(dir, () => '2026-06-13T10:00:00.000Z');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    expect(result.path).toBe(join(dir, 'heap-2026-06-13T10-00-00-000Z.heapsnapshot'));
    expect(existsSync(result.path)).toBe(true);
    expect(statSync(result.path).size).toBeGreaterThan(0);
    // A real V8 heap snapshot is JSON; sanity-check it streamed actual content.
    expect(readFileSync(result.path, 'utf8').startsWith('{')).toBe(true);
  });

  it('creates the target directory if it does not yet exist', () => {
    const nested = join(dir, 'a', 'b', 'c');
    const result = writeHeapSnapshotToDir(nested, () => '2026-06-13T11:00:00.000Z');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(existsSync(result.path)).toBe(true);
  });

  it('defaults to a real clock when none is injected', () => {
    const result = writeHeapSnapshotToDir(dir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.path).toMatch(/heap-.*\.heapsnapshot$/);
  });

  it('returns {ok:false} and does NOT throw when the underlying fs write fails', () => {
    // Make the target "directory" a pre-existing regular file so mkdirSync throws (ENOTDIR/EEXIST)
    // — a real near-OOM fs fault the helper must swallow rather than re-crash on.
    const collidingPath = join(dir, 'not-a-dir');
    writeFileSync(collidingPath, 'i am a file');

    let result: ReturnType<typeof writeHeapSnapshotToDir>;
    expect(() => {
      result = writeHeapSnapshotToDir(collidingPath, () => '2026-06-13T12:00:00.000Z');
    }).not.toThrow();

    expect(result!.ok).toBe(false);
    if (result!.ok) throw new Error('unreachable');
    expect(result!.error.length).toBeGreaterThan(0);
  });
});
