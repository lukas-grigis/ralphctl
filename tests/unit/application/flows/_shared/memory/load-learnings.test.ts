import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { type LearningRecord, serializeLearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';
import { loadLearningsLeaf } from '@src/application/flows/_shared/memory/load-learnings.ts';

const record = (over: Partial<LearningRecord> = {}): LearningRecord => ({
  v: 1,
  id: 'id-1',
  text: 'learning text',
  repo: '/repos/app',
  repoName: 'app',
  taskKind: 'feature',
  sprintId: 'sprint-1',
  taskId: 'task-1',
  timestamp: '2026-05-30T10:00:00.000Z',
  promotedAt: null,
  ...over,
});

interface TestCtx {
  readonly path: AbsolutePath;
  readonly candidates?: readonly LearningRecord[];
}

const makeLeaf = () =>
  loadLearningsLeaf<TestCtx>(
    { logger: noopLogger },
    {
      path: (ctx) => ctx.path,
      output: (ctx, candidates) => ({ ...ctx, candidates }),
    }
  );

describe('loadLearningsLeaf', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;
  let ledgerPath: AbsolutePath;

  beforeEach(async () => {
    root = await makeTmpRoot();
    ledgerPath = absolutePath(join(String(root.root), 'learnings.ndjson'));
  });
  afterEach(async () => {
    await root.cleanup();
  });

  const writeLedger = async (lines: readonly string[]): Promise<void> => {
    await fs.writeFile(String(ledgerPath), lines.join(''), 'utf8');
  };

  it('loads not-yet-promoted records and skips promoted ones', async () => {
    await writeLedger([
      serializeLearningRecord(record({ id: 'a' })),
      serializeLearningRecord(record({ id: 'b', promotedAt: '2026-05-30T12:00:00.000Z' })),
      serializeLearningRecord(record({ id: 'c' })),
    ]);

    const result = await makeLeaf().execute({ path: ledgerPath });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = (result.value.ctx.candidates ?? []).map((r) => r.id);
    expect(ids).toEqual(['a', 'c']);
  });

  it('dedups by record id, keeping the first occurrence', async () => {
    await writeLedger([
      serializeLearningRecord(record({ id: 'dup', text: 'first' })),
      serializeLearningRecord(record({ id: 'dup', text: 'second' })),
    ]);

    const result = await makeLeaf().execute({ path: ledgerPath });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const candidates = result.value.ctx.candidates ?? [];
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.text).toBe('first');
  });

  it('skips malformed lines without failing the load', async () => {
    await writeLedger([serializeLearningRecord(record({ id: 'good' })), '{ not json }\n', 'null\n']);

    const result = await makeLeaf().execute({ path: ledgerPath });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value.ctx.candidates ?? []).map((r) => r.id)).toEqual(['good']);
  });

  it('proposes nothing when the ledger file is absent', async () => {
    const missing = absolutePath(join(String(root.root), 'nope', 'learnings.ndjson'));
    const result = await makeLeaf().execute({ path: missing });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.candidates).toEqual([]);
  });

  it('re-propagates AbortError when the read is cancelled mid-flight (NOT an empty ledger)', async () => {
    // Big enough body that the read does not resolve before the microtask abort fires.
    const lines = Array.from({ length: 5000 }, (_, i) => serializeLearningRecord(record({ id: `id-${i}` })));
    await writeLedger(lines);

    const controller = new AbortController();
    // Signal is NOT aborted at leaf entry (so the leaf wrapper's checkAborted passes) — it aborts
    // during the fs.readFile, exercising the use-case's own re-propagation path.
    queueMicrotask(() => controller.abort());

    const result = await makeLeaf().execute({ path: ledgerPath }, controller.signal);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Critical: a cancelled read must surface as Aborted, never as an empty candidate list.
    expect(result.error.error.code).toBe(ErrorCode.Aborted);
  });

  it('surfaces Aborted (not empty) when the signal is already aborted at entry', async () => {
    await writeLedger([serializeLearningRecord(record())]);
    const controller = new AbortController();
    controller.abort();

    const result = await makeLeaf().execute({ path: ledgerPath }, controller.signal);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe(ErrorCode.Aborted);
  });
});
