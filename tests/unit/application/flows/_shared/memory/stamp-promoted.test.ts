import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import {
  type LearningRecord,
  parseLearningLine,
  serializeLearningRecord,
} from '@src/application/flows/_shared/memory/learning-record.ts';
import { stampPromotedLeaf } from '@src/application/flows/_shared/memory/stamp-promoted.ts';

const PROMOTED_AT = '2026-05-30T15:00:00.000Z' as IsoTimestamp;

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
  readonly acceptedIds: readonly string[];
  readonly stampedCount?: number;
}

const makeLeaf = () =>
  stampPromotedLeaf<TestCtx>(
    { writeFile: createAtomicWriteFile(), logger: noopLogger, clock: () => PROMOTED_AT },
    {
      path: (ctx) => ctx.path,
      acceptedIds: (ctx) => ctx.acceptedIds,
      output: (ctx, stampedCount) => ({ ...ctx, stampedCount }),
    }
  );

describe('stampPromotedLeaf', () => {
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

  const readLedger = async (): Promise<LearningRecord[]> => {
    const raw = await fs.readFile(String(ledgerPath), 'utf8');
    const out: LearningRecord[] = [];
    for (const line of raw.split('\n')) {
      const parsed = parseLearningLine(line);
      if (parsed.ok && parsed.value !== undefined) out.push(parsed.value);
    }
    return out;
  };

  it('stamps only the accepted, still-unpromoted ids and leaves the rest untouched', async () => {
    await writeLedger([
      serializeLearningRecord(record({ id: 'a' })),
      serializeLearningRecord(record({ id: 'b' })),
      serializeLearningRecord(record({ id: 'c' })),
    ]);

    const result = await makeLeaf().execute({ path: ledgerPath, acceptedIds: ['a', 'c'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.stampedCount).toBe(2);

    const after = await readLedger();
    const byId = new Map(after.map((r) => [r.id, r]));
    expect(byId.get('a')?.promotedAt).toBe(PROMOTED_AT);
    expect(byId.get('c')?.promotedAt).toBe(PROMOTED_AT);
    expect(byId.get('b')?.promotedAt).toBeNull();
  });

  it('does not re-stamp an already-promoted accepted id (idempotent)', async () => {
    await writeLedger([
      serializeLearningRecord(record({ id: 'a', promotedAt: '2026-05-01T00:00:00.000Z' })),
      serializeLearningRecord(record({ id: 'b' })),
    ]);

    const result = await makeLeaf().execute({ path: ledgerPath, acceptedIds: ['a', 'b'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.stampedCount).toBe(1); // only 'b' flips

    const byId = new Map((await readLedger()).map((r) => [r.id, r]));
    // 'a' keeps its original promotion timestamp — never back-dated.
    expect(byId.get('a')?.promotedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(byId.get('b')?.promotedAt).toBe(PROMOTED_AT);
  });

  it('preserves an unknown future field on a non-stamped row when stamping a different row', async () => {
    // A newer ralphctl version may add a field the current schema doesn't know. The schema is a
    // plain z.object that strips unknown keys on parse, so re-serializing a parsed record would
    // delete it. Non-stamped rows must round-trip byte-for-byte so an older pinned binary running
    // distill against a shared ledger does not destroy data it was only meant to tolerate.
    const futureLine = `${JSON.stringify({ ...record({ id: 'b' }), futureField: 'keep-me' })}\n`;
    await writeLedger([serializeLearningRecord(record({ id: 'a' })), futureLine]);

    const result = await makeLeaf().execute({ path: ledgerPath, acceptedIds: ['a'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.stampedCount).toBe(1);

    const raw = await fs.readFile(String(ledgerPath), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    // Row 'a' was stamped (promotedAt set); row 'b' kept its raw line verbatim incl. futureField.
    const stamped = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(stamped.id).toBe('a');
    expect(stamped.promotedAt).toBe(PROMOTED_AT);
    const preserved = JSON.parse(lines[1] ?? '{}') as Record<string, unknown>;
    expect(preserved.id).toBe('b');
    expect(preserved.futureField).toBe('keep-me');
  });

  it('no-ops (no write, stampedCount 0) when the accepted set is empty', async () => {
    await writeLedger([serializeLearningRecord(record({ id: 'a' }))]);
    const before = await fs.readFile(String(ledgerPath), 'utf8');

    const result = await makeLeaf().execute({ path: ledgerPath, acceptedIds: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.stampedCount).toBe(0);
    // File is untouched (no rewrite when nothing is accepted).
    expect(await fs.readFile(String(ledgerPath), 'utf8')).toBe(before);
  });

  it('no-ops when the ledger file is absent', async () => {
    const missing = absolutePath(join(String(root.root), 'gone', 'learnings.ndjson'));
    const result = await makeLeaf().execute({ path: missing, acceptedIds: ['a'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.stampedCount).toBe(0);
  });

  it('fails with a StorageError when a line is malformed (cannot safely rewrite)', async () => {
    await writeLedger([serializeLearningRecord(record({ id: 'a' })), '{ corrupt\n']);
    const result = await makeLeaf().execute({ path: ledgerPath, acceptedIds: ['a'] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe(ErrorCode.Storage);
  });

  it('re-propagates AbortError when the read is cancelled mid-flight', async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => serializeLearningRecord(record({ id: `id-${i}` })));
    await writeLedger(lines);

    const controller = new AbortController();
    queueMicrotask(() => controller.abort());

    const result = await makeLeaf().execute({ path: ledgerPath, acceptedIds: ['id-0'] }, controller.signal);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe(ErrorCode.Aborted);
  });
});
