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

  it('promotion-suppression survives compaction: a promoted tombstone keeps suppressing a null twin', async () => {
    // 'a' was promoted earlier; a later task re-appended a null-twin (same id, promotedAt null).
    // Compaction must collapse the pair onto the PROMOTED winner so the loader never re-proposes it.
    await writeLedger([
      serializeLearningRecord(record({ id: 'a', promotedAt: '2026-05-01T00:00:00.000Z' })),
      serializeLearningRecord(record({ id: 'a', text: 're-emitted' })), // null twin
      serializeLearningRecord(record({ id: 'b' })),
    ]);

    const result = await makeLeaf().execute({ path: ledgerPath, acceptedIds: ['b'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const after = await readLedger();
    const aRows = after.filter((r) => r.id === 'a');
    expect(aRows).toHaveLength(1); // null twin collapsed away
    expect(aRows[0]?.promotedAt).toBe('2026-05-01T00:00:00.000Z'); // promoted winner kept
  });

  it('preserves an unknown future field when that row is the compaction WINNER', async () => {
    // The future-field row is a promoted tombstone AND the winner over a later null twin. It must
    // round-trip byte-for-byte through compaction (raw line, never re-serialized).
    const futureLine = `${JSON.stringify({
      ...record({ id: 'w', promotedAt: '2026-05-01T00:00:00.000Z' }),
      futureField: 'keep-me',
    })}\n`;
    await writeLedger([
      futureLine,
      serializeLearningRecord(record({ id: 'w', text: 'twin' })), // null twin, loses to promoted
      serializeLearningRecord(record({ id: 'a' })),
    ]);

    const result = await makeLeaf().execute({ path: ledgerPath, acceptedIds: ['a'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const raw = await fs.readFile(String(ledgerPath), 'utf8');
    const wLine = raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((o) => o.id === 'w');
    expect(wLine?.futureField).toBe('keep-me'); // winner's unknown field survived
    expect(wLine?.promotedAt).toBe('2026-05-01T00:00:00.000Z');
  });

  it('dedup equivalence: rewrite collapses duplicate ids to a single promoted row', async () => {
    // Both 'dup' rows are accepted+unpromoted, so both get stamped → both become promoted. Among
    // multiple promoted, last-promoted-wins, so the surviving row is the SECOND. Either way the
    // pair collapses to one promoted row — the loader will never re-propose it.
    await writeLedger([
      serializeLearningRecord(record({ id: 'dup', text: 'first' })),
      serializeLearningRecord(record({ id: 'dup', text: 'second' })),
    ]);

    const result = await makeLeaf().execute({ path: ledgerPath, acceptedIds: ['dup'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const after = await readLedger();
    const dups = after.filter((r) => r.id === 'dup');
    expect(dups).toHaveLength(1);
    expect(dups[0]?.promotedAt).toBe(PROMOTED_AT); // collapsed to a single promoted tombstone
    expect(dups[0]?.text).toBe('second'); // last-promoted-wins among the two stamped twins
  });

  it('empty accepted set under threshold → no write (file untouched)', async () => {
    await writeLedger([serializeLearningRecord(record({ id: 'a' }))]);
    const before = await fs.readFile(String(ledgerPath), 'utf8');

    const result = await makeLeaf().execute({ path: ledgerPath, acceptedIds: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.stampedCount).toBe(0);
    expect(await fs.readFile(String(ledgerPath), 'utf8')).toBe(before);
  });

  it('empty accepted set OVER threshold → compaction-only write reduces the ledger', async () => {
    // Past the size threshold with a duplicate-heavy ledger: even with nothing accepted, a
    // compaction-only pass runs and writes a smaller, de-duplicated file.
    const lines: string[] = [];
    for (let i = 0; i < 800; i += 1) {
      // Each id appears twice so dedup has work to do; padded text pushes past the byte threshold.
      lines.push(serializeLearningRecord(record({ id: `id-${i}`, text: 'x'.repeat(300) })));
      lines.push(serializeLearningRecord(record({ id: `id-${i}`, text: 'x'.repeat(300) })));
    }
    await writeLedger(lines);
    const beforeRows = (await readLedger()).length;

    const result = await makeLeaf().execute({ path: ledgerPath, acceptedIds: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.stampedCount).toBe(0); // nothing stamped

    const afterRows = (await readLedger()).length;
    expect(afterRows).toBeLessThan(beforeRows); // compaction-only still shrank it
  });
});
