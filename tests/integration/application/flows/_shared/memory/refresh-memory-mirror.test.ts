/**
 * Integration test for the always-on `refresh-memory-mirror` leaf — the durable narrative-tier
 * refresh that regenerates `learnings.md` from the per-project ledger at sprint close, independent of
 * the human-gated distill. It is best-effort (absent ledger → no-op) and re-propagates `AbortError`.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { type LearningRecord, serializeLearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';
import { refreshMemoryMirrorLeaf } from '@src/application/flows/_shared/memory/refresh-memory-mirror.ts';

const PROJECT_ID = 'proj-mirror';

let dir: string;
let projectDir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'ralph-mirror-'));
  projectDir = join(dir, PROJECT_ID);
  await fs.mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const rec = (over: Partial<LearningRecord> & { id: string; text: string }): LearningRecord => ({
  v: 1,
  repo: '/repo',
  repoName: 'demo',
  taskKind: 'feature',
  sprintId: 's1',
  taskId: 't1',
  timestamp: '2026-06-19T10:00:00.000Z',
  promotedAt: null,
  ...over,
});

const makeLeaf = () =>
  refreshMemoryMirrorLeaf<Record<string, never>>(
    { writeFile: createAtomicWriteFile(), logger: noopLogger },
    { memoryRoot: absolutePath(dir), projectId: PROJECT_ID }
  );

describe('refreshMemoryMirrorLeaf', () => {
  it('renders learnings.md from the ledger, distinguishing decisions', async () => {
    await fs.writeFile(
      join(projectDir, 'learnings.ndjson'),
      [
        serializeLearningRecord(rec({ id: 'l1', text: 'a prior learning', kind: 'learning' })),
        serializeLearningRecord(rec({ id: 'd1', text: 'a prior decision', kind: 'decision' })),
      ].join(''),
      'utf8'
    );

    const result = await makeLeaf().execute({});
    expect(result.ok).toBe(true);

    const md = await fs.readFile(join(projectDir, 'learnings.md'), 'utf8');
    expect(md).toContain('a prior learning');
    expect(md).toContain('a prior decision');
    expect(md).toContain('· decision'); // the decision row is tagged in the narrative
  });

  it('is a no-op when the ledger is absent (no mirror written)', async () => {
    const result = await makeLeaf().execute({});
    expect(result.ok).toBe(true);
    await expect(fs.access(join(projectDir, 'learnings.md'))).rejects.toBeTruthy();
  });

  it('re-propagates AbortError when the read is cancelled mid-flight', async () => {
    const lines = Array.from({ length: 5000 }, (_, i) =>
      serializeLearningRecord(rec({ id: `id-${String(i)}`, text: `t ${String(i)}` }))
    );
    await fs.writeFile(join(projectDir, 'learnings.ndjson'), lines.join(''), 'utf8');

    const controller = new AbortController();
    queueMicrotask(() => controller.abort());

    const result = await makeLeaf().execute({}, controller.signal);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe(ErrorCode.Aborted);
  });
});
