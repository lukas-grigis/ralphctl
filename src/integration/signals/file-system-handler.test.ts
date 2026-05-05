import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import { TaskId } from '@src/domain/values/task-id.ts';
import { FileLocker } from '@src/integration/persistence/file-locker.ts';
import {
  ensureLayoutDirs,
  resolveStoragePaths,
  type StoragePaths,
} from '@src/integration/persistence/storage-paths.ts';
import { FileSystemSignalHandler } from './file-system-handler.ts';

const SPRINT_ID = SprintId.trustString('20260429-120000-demo');
const TASK_ID = TaskId.trustString('abcdef01');
const NOW = IsoTimestamp.trustString('2026-04-29T12:00:00.000Z');

function uniqueRoot(): AbsolutePath {
  return AbsolutePath.trustString(
    join(tmpdir(), `ralphctl-fsh-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`)
  );
}

describe('FileSystemSignalHandler', () => {
  let root: AbsolutePath;
  let paths: StoragePaths;
  let handler: FileSystemSignalHandler;

  beforeEach(async () => {
    root = uniqueRoot();
    paths = resolveStoragePaths({ root });
    await ensureLayoutDirs(paths);
    await mkdir(paths.sprintDir(SPRINT_ID), { recursive: true });
    handler = new FileSystemSignalHandler(paths, new FileLocker());
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('appends progress signals to progress.md', async () => {
    const signal: HarnessSignal = {
      type: 'progress',
      summary: 'Wrote the parser',
      timestamp: NOW,
    };
    const r = await handler.handle(signal, { sprintId: SPRINT_ID });
    expect(r.ok).toBe(true);

    const body = await readFile(join(paths.sprintDir(SPRINT_ID), 'progress.md'), 'utf-8');
    expect(body).toContain(NOW);
    expect(body).toContain('Wrote the parser');
  });

  it('includes file list when present on a progress signal', async () => {
    const signal: HarnessSignal = {
      type: 'progress',
      summary: 'Edited routes',
      files: ['src/routes/a.ts', 'src/routes/b.ts'],
      timestamp: NOW,
    };
    const r = await handler.handle(signal, { sprintId: SPRINT_ID });
    expect(r.ok).toBe(true);
    const body = await readFile(join(paths.sprintDir(SPRINT_ID), 'progress.md'), 'utf-8');
    expect(body).toContain('files: src/routes/a.ts, src/routes/b.ts');
  });

  it('appends note signals to progress.md with **Note:** prefix', async () => {
    const signal: HarnessSignal = {
      type: 'note',
      text: 'remember edge case',
      timestamp: NOW,
    };
    const r = await handler.handle(signal, { sprintId: SPRINT_ID });
    expect(r.ok).toBe(true);
    const body = await readFile(join(paths.sprintDir(SPRINT_ID), 'progress.md'), 'utf-8');
    expect(body).toContain('**Note:** remember edge case');
  });

  it('appends blocked signals to progress.md with **Task Blocked:** prefix', async () => {
    const signal: HarnessSignal = {
      type: 'task-blocked',
      reason: 'API down',
      timestamp: NOW,
    };
    const r = await handler.handle(signal, { sprintId: SPRINT_ID });
    expect(r.ok).toBe(true);
    const body = await readFile(join(paths.sprintDir(SPRINT_ID), 'progress.md'), 'utf-8');
    expect(body).toContain('**Task Blocked:** API down');
  });

  it('appends multiple signals as separate lines (append-only)', async () => {
    const a: HarnessSignal = { type: 'progress', summary: 'first', timestamp: NOW };
    const b: HarnessSignal = { type: 'progress', summary: 'second', timestamp: NOW };
    await handler.handle(a, { sprintId: SPRINT_ID });
    await handler.handle(b, { sprintId: SPRINT_ID });
    const body = await readFile(join(paths.sprintDir(SPRINT_ID), 'progress.md'), 'utf-8');
    const lines = body.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('first');
    expect(lines[1]).toContain('second');
  });

  it('appends an evaluation summary to progress.md without writing the full critique sidecar', async () => {
    // The full critique is persisted by `EvaluateAndFixLoopUseCase`
    // under `rounds/<N>/evaluator/evaluation.md` — this handler only
    // emits a one-line summary into the sprint timeline. Asserting the
    // sidecar is intentionally absent prevents a regression that would
    // re-introduce the dual-write path.
    const signal: HarnessSignal = {
      type: 'evaluation',
      status: 'failed',
      dimensions: [{ dimension: 'correctness', score: 2, passed: false, finding: 'missing null guard' }],
      overallScore: 2,
      critique: 'The implementation does not handle null input.',
      timestamp: NOW,
    };
    const r = await handler.handle(signal, {
      sprintId: SPRINT_ID,
      taskId: TASK_ID,
      taskName: 'Sample Task',
    });
    expect(r.ok).toBe(true);

    // No sidecar — the loop owns critique persistence now.
    await expect(
      readFile(join(paths.sprintDir(SPRINT_ID), 'execution', `${TASK_ID}-sample-task`, 'evaluation.md'), 'utf-8')
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const progress = await readFile(join(paths.sprintDir(SPRINT_ID), 'progress.md'), 'utf-8');
    expect(progress).toContain('**Evaluation:** failed');
    expect(progress).toContain('score 2/5');
    expect(progress).toContain('1 dimension(s)');
  });

  it('returns an error when an evaluation signal arrives without taskId', async () => {
    const signal: HarnessSignal = {
      type: 'evaluation',
      status: 'passed',
      dimensions: [],
      timestamp: NOW,
    };
    const r = await handler.handle(signal, { sprintId: SPRINT_ID });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('storage-error');
    }
  });

  it('returns an error when an evaluation signal arrives without taskName', async () => {
    const signal: HarnessSignal = {
      type: 'evaluation',
      status: 'passed',
      dimensions: [],
      timestamp: NOW,
    };
    const r = await handler.handle(signal, { sprintId: SPRINT_ID, taskId: TASK_ID });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('storage-error');
    }
  });

  it('is a no-op for task-verified and task-complete signals', async () => {
    const verified: HarnessSignal = {
      type: 'task-verified',
      output: 'tests pass',
      timestamp: NOW,
    };
    const complete: HarnessSignal = { type: 'task-complete', timestamp: NOW };
    await handler.handle(verified, { sprintId: SPRINT_ID, taskId: TASK_ID });
    await handler.handle(complete, { sprintId: SPRINT_ID, taskId: TASK_ID });

    // No progress file written.
    await expect(readFile(join(paths.sprintDir(SPRINT_ID), 'progress.md'), 'utf-8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('is a no-op for setup-time signals (check-script / agents-md)', async () => {
    const cs: HarnessSignal = {
      type: 'check-script-discovery',
      command: 'pnpm test',
      timestamp: NOW,
    };
    const am: HarnessSignal = {
      type: 'agents-md-proposal',
      content: '# Project',
      timestamp: NOW,
    };
    const a = await handler.handle(cs, { sprintId: SPRINT_ID });
    const b = await handler.handle(am, { sprintId: SPRINT_ID });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it('serialises concurrent appends to progress.md (file lock)', async () => {
    const sig = (n: number): HarnessSignal => ({
      type: 'note',
      text: `n${String(n)}`,
      timestamp: NOW,
    });
    const all = await Promise.all(
      Array.from({ length: 10 }, (_, i) => handler.handle(sig(i), { sprintId: SPRINT_ID }))
    );
    expect(all.every((r) => r.ok)).toBe(true);

    const body = await readFile(join(paths.sprintDir(SPRINT_ID), 'progress.md'), 'utf-8');
    const lines = body.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(10);
  });
});
