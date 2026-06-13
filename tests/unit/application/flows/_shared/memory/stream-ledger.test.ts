import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { type LearningRecord, serializeLearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';
import {
  type LedgerLine,
  LEDGER_MAX_ROWS,
  statLedgerExceedsThreshold,
  streamLedgerLines,
} from '@src/application/flows/_shared/memory/stream-ledger.ts';

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

const drain = async (path: AbsolutePath, signal?: AbortSignal): Promise<LedgerLine[]> => {
  const out: LedgerLine[] = [];
  for await (const line of streamLedgerLines(path, signal)) out.push(line);
  return out;
};

describe('streamLedgerLines', () => {
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

  it('yields parsed records with their raw line', async () => {
    await writeLedger([serializeLearningRecord(record({ id: 'a' })), serializeLearningRecord(record({ id: 'b' }))]);
    const lines = await drain(ledgerPath);
    expect(lines.map((l) => l.record?.id)).toEqual(['a', 'b']);
    expect(lines.every((l) => l.parseError === undefined)).toBe(true);
    // Raw line round-trips back to the same record.
    expect(JSON.parse(lines[0]?.raw ?? '{}').id).toBe('a');
  });

  it('yields a blank line as record/parseError both undefined', async () => {
    await writeLedger([serializeLearningRecord(record({ id: 'a' })), '\n']);
    const lines = await drain(ledgerPath);
    const blank = lines.find((l) => l.record === undefined);
    expect(blank).toBeDefined();
    expect(blank?.parseError).toBeUndefined();
  });

  it('yields a parseError (not a throw) for a malformed line', async () => {
    await writeLedger([serializeLearningRecord(record({ id: 'a' })), '{ corrupt\n']);
    const lines = await drain(ledgerPath);
    const bad = lines.find((l) => l.parseError !== undefined);
    expect(bad).toBeDefined();
    expect(bad?.record).toBeUndefined();
  });

  it('yields nothing for an absent ledger (ENOENT)', async () => {
    const missing = absolutePath(join(String(root.root), 'nope', 'learnings.ndjson'));
    expect(await drain(missing)).toEqual([]);
  });

  it('throws AbortError when the signal is already aborted at entry', async () => {
    await writeLedger([serializeLearningRecord(record())]);
    const controller = new AbortController();
    controller.abort();
    await expect(drain(ledgerPath, controller.signal)).rejects.toMatchObject({ code: ErrorCode.Aborted });
  });

  it('throws AbortError when the signal fires mid-stream', async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => serializeLearningRecord(record({ id: `id-${i}` })));
    await writeLedger(lines);
    const controller = new AbortController();

    // Abort as soon as the first line is observed, then keep consuming — the generator must throw
    // AbortError on the next iteration rather than yielding the rest of the file.
    const consume = async (): Promise<void> => {
      let seen = 0;
      for await (const line of streamLedgerLines(ledgerPath, controller.signal)) {
        void line.raw;
        seen += 1;
        if (seen === 1) controller.abort();
      }
    };
    await expect(consume()).rejects.toMatchObject({ code: ErrorCode.Aborted });
  });
});

describe('statLedgerExceedsThreshold', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;
  let ledgerPath: AbsolutePath;

  beforeEach(async () => {
    root = await makeTmpRoot();
    ledgerPath = absolutePath(join(String(root.root), 'learnings.ndjson'));
  });
  afterEach(async () => {
    await root.cleanup();
  });

  it('returns false for an absent ledger', async () => {
    expect(await statLedgerExceedsThreshold(ledgerPath)).toBe(false);
  });

  it('returns false for a small ledger', async () => {
    await fs.writeFile(String(ledgerPath), serializeLearningRecord(record()), 'utf8');
    expect(await statLedgerExceedsThreshold(ledgerPath)).toBe(false);
  });

  it('returns true once the byte size estimates past 90% of the cap', async () => {
    // ESTIMATED_ROW_BYTES=300 internally; write well past LEDGER_MAX_ROWS rows worth of bytes.
    const rows = Array.from({ length: LEDGER_MAX_ROWS + 50 }, (_, i) =>
      serializeLearningRecord(record({ id: `id-${i}`, text: 'x'.repeat(300) }))
    );
    await fs.writeFile(String(ledgerPath), rows.join(''), 'utf8');
    expect(await statLedgerExceedsThreshold(ledgerPath)).toBe(true);
  });
});
