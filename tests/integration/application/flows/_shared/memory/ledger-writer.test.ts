/**
 * Integration tests for the ledger writer. `appendMemoryRecords` appends crash-safe NDJSON line(s)
 * and bounds the file when it grows past the size threshold — but DELIBERATELY does NOT regenerate
 * the `learnings.md` mirror (that O(n) read+reparse+rewrite moved off the hot gen-eval path; the
 * mirror is rendered lazily at distill / sprint close). Uses a real tmpdir so the on-disk paths are
 * exercised end to end.
 *
 * Also fences the concurrency contract (#288): the bound is a whole-file read-modify-write, so two
 * concurrent callers on ONE ledger (every parallel implement branch shares the project ledger) must
 * funnel the WHOLE call through a shared mutex or a sibling's appended row is silently clobbered.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { createAppendFile } from '@src/integration/io/append-file-adapter.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { type LearningRecord, serializeLearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';
import {
  appendMemoryRecords,
  boundLedgerIfNeeded,
  learningsMdPath,
  mirrorLearningsMd,
} from '@src/application/flows/_shared/memory/ledger-writer.ts';
import { LEDGER_MAX_PENDING_ROWS } from '@src/application/flows/_shared/memory/compact-ledger.ts';
import { createFoldQueue } from '@src/application/flows/implement/wave-branch.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'ralph-ledger-writer-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const ledgerPath = () => absolutePath(join(dir, 'learnings.ndjson'));

const rec = (over: Partial<LearningRecord> & { text: string; id: string }): LearningRecord => ({
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

const nonBlankLines = (raw: string): readonly string[] => raw.split('\n').filter((l) => l.trim().length > 0);

describe('appendMemoryRecords', () => {
  it('appends NDJSON line(s) and does NOT regenerate learnings.md on the hot path', async () => {
    const deps = { appendFile: createAppendFile(), writeFile: createAtomicWriteFile(), log: noopLogger };

    const r1 = await appendMemoryRecords(ledgerPath(), [rec({ id: 'a', text: 'first insight' })], deps);
    expect(r1.ok).toBe(true);
    const r2 = await appendMemoryRecords(ledgerPath(), [rec({ id: 'b', text: 'second insight' })], deps);
    expect(r2.ok).toBe(true);

    // The ledger has both lines (crash-safe append).
    const ndjson = await fs.readFile(join(dir, 'learnings.ndjson'), 'utf8');
    expect(nonBlankLines(ndjson)).toHaveLength(2);

    // The mirror is LAZY — no learnings.md was written on the append path.
    await expect(fs.access(join(dir, 'learnings.md'))).rejects.toBeTruthy();
  });

  it('appends learning + decision rows side by side (kind discriminator)', async () => {
    const deps = { appendFile: createAppendFile(), writeFile: createAtomicWriteFile(), log: noopLogger };
    const res = await appendMemoryRecords(
      ledgerPath(),
      [
        rec({ id: 'l1', text: 'a learning', kind: 'learning' }),
        rec({ id: 'd1', text: 'a decision', kind: 'decision' }),
      ],
      deps
    );
    expect(res.ok).toBe(true);
    const lines = nonBlankLines(await fs.readFile(join(dir, 'learnings.ndjson'), 'utf8')).map(
      (l) => JSON.parse(l) as LearningRecord
    );
    expect(lines.map((r) => r.kind)).toEqual(['learning', 'decision']);
  });

  it('an append failure is returned as an error', async () => {
    const failing = async () => {
      const { Result } = await import('@src/domain/result.ts');
      const { StorageError } = await import('@src/domain/value/error/storage-error.ts');
      return Result.error(new StorageError({ subCode: 'io', message: 'disk full' }));
    };
    const deps = { appendFile: failing, writeFile: createAtomicWriteFile(), log: noopLogger };
    const res = await appendMemoryRecords(ledgerPath(), [rec({ id: 'x', text: 'x' })], deps);
    expect(res.ok).toBe(false);
  });
});

describe('boundLedgerIfNeeded (always-on size bounding)', () => {
  // A line wide enough that a few hundred rows clear the size threshold (size / 300 >= 450).
  const wide = (i: number): LearningRecord =>
    rec({ id: `id-${String(i)}`, text: `insight ${String(i)} ${'x'.repeat(280)}` });

  it('is a no-op when the ledger is under the size threshold', async () => {
    const before = [
      serializeLearningRecord(rec({ id: 'a', text: 'a' })),
      serializeLearningRecord(rec({ id: 'b', text: 'b' })),
    ].join('');
    await fs.writeFile(join(dir, 'learnings.ndjson'), before, 'utf8');

    const res = await boundLedgerIfNeeded(ledgerPath(), { writeFile: createAtomicWriteFile(), log: noopLogger });
    expect(res.ok).toBe(true);
    // Byte-for-byte untouched — no rewrite under the threshold.
    expect(await fs.readFile(join(dir, 'learnings.ndjson'), 'utf8')).toBe(before);
  });

  it('compacts an over-threshold ledger, evicting the oldest pending past the cap', async () => {
    // Enough distinct pending rows to BOTH exceed the byte threshold and overflow the pending cap.
    const total = LEDGER_MAX_PENDING_ROWS + 150;
    const body = Array.from({ length: total }, (_, i) => serializeLearningRecord(wide(i))).join('');
    await fs.writeFile(join(dir, 'learnings.ndjson'), body, 'utf8');

    const res = await boundLedgerIfNeeded(ledgerPath(), { writeFile: createAtomicWriteFile(), log: noopLogger });
    expect(res.ok).toBe(true);

    const after = nonBlankLines(await fs.readFile(join(dir, 'learnings.ndjson'), 'utf8'));
    // Pending capped at LEDGER_MAX_PENDING_ROWS; the OLDEST were evicted (newest survive).
    expect(after).toHaveLength(LEDGER_MAX_PENDING_ROWS);
    const survivingIds = after.map((l) => (JSON.parse(l) as LearningRecord).id);
    expect(survivingIds).toContain(`id-${String(total - 1)}`); // newest survives
    expect(survivingIds).not.toContain('id-0'); // oldest evicted
  });
});

describe('concurrent appends vs. bounding (the parallel-branch race)', () => {
  // Wide enough that LEDGER_MAX_PENDING_ROWS + 150 rows clear the size threshold (size / 300 >= 450).
  const wide = (i: number): LearningRecord =>
    rec({ id: `id-${String(i)}`, text: `insight ${String(i)} ${'x'.repeat(280)}` });

  /** Seed an over-threshold ledger so the next `appendMemoryRecords` triggers a compaction rewrite. */
  const seedOverThresholdLedger = async (): Promise<void> => {
    const body = Array.from({ length: LEDGER_MAX_PENDING_ROWS + 150 }, (_, i) => serializeLearningRecord(wide(i))).join(
      ''
    );
    await fs.writeFile(join(dir, 'learnings.ndjson'), body, 'utf8');
  };

  /**
   * A `WriteFile` that PARKS its first call until released — the deterministic stand-in for the
   * real race window between the bound's read and its atomic rename. Later calls pass straight
   * through.
   */
  const gatedWriteFile = () => {
    const inner = createAtomicWriteFile();
    let releaseGate = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let signalParked = (): void => undefined;
    const parked = new Promise<void>((resolve) => {
      signalParked = resolve;
    });
    let first = true;
    const fn: WriteFile = async (path, body) => {
      if (first) {
        first = false;
        signalParked();
        await gate;
      }
      return inner(path, body);
    };
    return { fn, parked, release: () => releaseGate() };
  };

  const idsOnDisk = async (): Promise<readonly string[]> =>
    nonBlankLines(await fs.readFile(join(dir, 'learnings.ndjson'), 'utf8')).map(
      (l) => (JSON.parse(l) as LearningRecord).id
    );

  const alpha = rec({ id: 'branch-alpha', text: 'alpha branch pinned the node version' });
  const beta = rec({ id: 'branch-beta', text: 'beta branch found a flaky snapshot ordering' });

  it('UNSERIALISED: a sibling append landing mid-bound is clobbered by the rewrite', async () => {
    // Control case — proves the interleaving below really exercises the race the mutex closes.
    await seedOverThresholdLedger();
    const gated = gatedWriteFile();
    const appendFile = createAppendFile();

    // Branch A appends its row, then parks inside the bound (read done, rewrite pending).
    const branchA = appendMemoryRecords(ledgerPath(), [alpha], { appendFile, writeFile: gated.fn, log: noopLogger });
    await gated.parked;

    // Branch B runs to completion in that window — its row is on disk before A's rewrite lands.
    const branchB = await appendMemoryRecords(ledgerPath(), [beta], {
      appendFile,
      writeFile: createAtomicWriteFile(),
      log: noopLogger,
    });
    expect(branchB.ok).toBe(true);

    gated.release();
    expect((await branchA).ok).toBe(true);

    // A's rewrite was computed from a snapshot taken BEFORE B's append — B's row is gone.
    const ids = await idsOnDisk();
    expect(ids).toContain('branch-alpha');
    expect(ids).not.toContain('branch-beta');
  });

  it('SERIALISED through one FoldQueue: every appended row survives the bound', async () => {
    await seedOverThresholdLedger();
    const gated = gatedWriteFile();
    const appendFile = createAppendFile();
    const ledgerMutex = createFoldQueue();

    const branchA = ledgerMutex.run(() =>
      appendMemoryRecords(ledgerPath(), [alpha], { appendFile, writeFile: gated.fn, log: noopLogger })
    );
    await gated.parked;

    // Branch B enqueues while A is mid-bound — the mutex holds its APPEND back too, which is the
    // whole point (serialising only the rewrite would still let this append be clobbered).
    const branchB = ledgerMutex.run(() =>
      appendMemoryRecords(ledgerPath(), [beta], { appendFile, writeFile: createAtomicWriteFile(), log: noopLogger })
    );
    await new Promise((resolve) => setImmediate(resolve));
    gated.release();

    expect((await branchA).ok).toBe(true);
    expect((await branchB).ok).toBe(true);

    const ids = await idsOnDisk();
    expect(ids).toContain('branch-alpha');
    expect(ids).toContain('branch-beta');
  });
});

describe('mirrorLearningsMd (lazy render)', () => {
  it('renders learnings.md next to the ledger from a parsed record set', async () => {
    const mdPath = learningsMdPath(ledgerPath());
    expect(mdPath).toBeTruthy();
    await mirrorLearningsMd(
      ledgerPath(),
      [rec({ id: 'a', text: 'first insight' }), rec({ id: 'b', text: 'second insight' })],
      createAtomicWriteFile(),
      noopLogger
    );
    const md = await fs.readFile(join(dir, 'learnings.md'), 'utf8');
    expect(md).toContain('first insight');
    expect(md).toContain('second insight');
  });
});
