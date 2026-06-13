import { describe, expect, it } from 'vitest';
import { type LearningRecord, serializeLearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';
import {
  LEDGER_MAX_PENDING_ROWS,
  LEDGER_MAX_ROWS,
  type LedgerRow,
  compactLedger,
} from '@src/application/flows/_shared/memory/compact-ledger.ts';

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

/** Build a row carrying the record's serialized raw line (the normal streamed-row shape). */
const row = (over: Partial<LearningRecord> = {}): LedgerRow => {
  const rec = record(over);
  return { raw: serializeLearningRecord(rec).trimEnd(), record: rec };
};

const ids = (rows: readonly LedgerRow[]): string[] => rows.map((r) => r.record?.id ?? '<blank>');

describe('compactLedger', () => {
  it('returns an empty result for no rows', () => {
    const out = compactLedger([]);
    expect(out.rows).toEqual([]);
    expect(out.evictedCount).toBe(0);
    expect(out.deduplicatedCount).toBe(0);
  });

  it('passes a single row through untouched', () => {
    const r = row({ id: 'a' });
    const out = compactLedger([r]);
    expect(out.rows).toEqual([r]);
    expect(out.deduplicatedCount).toBe(0);
    expect(out.evictedCount).toBe(0);
  });

  it('drops blank rows (record undefined)', () => {
    const out = compactLedger([{ raw: '', record: undefined }, row({ id: 'a' })]);
    expect(ids(out.rows)).toEqual(['a']);
  });

  it('keeps the FIRST unpromoted occurrence among unpromoted duplicates', () => {
    const first = row({ id: 'dup', text: 'first' });
    const second = row({ id: 'dup', text: 'second' });
    const out = compactLedger([first, second]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.record?.text).toBe('first');
    expect(out.deduplicatedCount).toBe(1);
  });

  it('promotes-wins-over-unpromoted regardless of order', () => {
    const unpromoted = row({ id: 'x', text: 'pending' });
    const promoted = row({ id: 'x', text: 'promoted', promotedAt: '2026-05-30T12:00:00.000Z' });
    const out = compactLedger([unpromoted, promoted]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.record?.promotedAt).not.toBeNull();
    expect(out.rows[0]?.record?.text).toBe('promoted');
  });

  it('keeps the LAST promoted among multiple promoted', () => {
    const p1 = row({ id: 'x', text: 'first-promo', promotedAt: '2026-05-01T00:00:00.000Z' });
    const p2 = row({ id: 'x', text: 'second-promo', promotedAt: '2026-05-02T00:00:00.000Z' });
    const out = compactLedger([p1, p2]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.record?.text).toBe('second-promo');
    expect(out.rows[0]?.record?.promotedAt).toBe('2026-05-02T00:00:00.000Z');
  });

  it('represents the winner by its RAW LINE, never re-serialized (forward-compat)', () => {
    // A future-field raw line that does NOT round-trip through the schema.
    const rec = record({ id: 'f' });
    const rawWithFuture = JSON.stringify({ ...rec, futureField: 'keep-me' });
    const winnerRow: LedgerRow = { raw: rawWithFuture, record: rec };
    const loserRow = row({ id: 'f', text: 'duplicate-stripped' });

    const out = compactLedger([winnerRow, loserRow]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.raw).toBe(rawWithFuture); // exact raw line preserved
    expect(JSON.parse(out.rows[0]?.raw ?? '{}').futureField).toBe('keep-me');
  });

  it('emits survivors in their original relative order', () => {
    const out = compactLedger([row({ id: 'c' }), row({ id: 'a' }), row({ id: 'b' })]);
    expect(ids(out.rows)).toEqual(['c', 'a', 'b']);
  });

  it('caps pending at LEDGER_MAX_PENDING_ROWS, evicting the OLDEST', () => {
    const rows = Array.from({ length: LEDGER_MAX_PENDING_ROWS + 10 }, (_, i) => row({ id: `id-${i}` }));
    const out = compactLedger(rows);
    expect(out.rows).toHaveLength(LEDGER_MAX_PENDING_ROWS);
    expect(out.evictedCount).toBe(10);
    // Oldest (id-0..id-9) evicted; id-10 is the new oldest survivor.
    expect(out.rows[0]?.record?.id).toBe('id-10');
    expect(out.rows.at(-1)?.record?.id).toBe(`id-${LEDGER_MAX_PENDING_ROWS + 9}`);
  });

  it('NEVER evicts promoted tombstones even when total exceeds LEDGER_MAX_ROWS', () => {
    // More promoted tombstones than the total cap — none may be evicted; pending shed to zero.
    const tombstones = Array.from({ length: LEDGER_MAX_ROWS + 50 }, (_, i) =>
      row({ id: `t-${i}`, promotedAt: '2026-05-01T00:00:00.000Z' })
    );
    const pending = Array.from({ length: 20 }, (_, i) => row({ id: `p-${i}` }));
    const out = compactLedger([...tombstones, ...pending]);

    const survivingIds = new Set(ids(out.rows));
    // Every tombstone survives.
    for (const t of tombstones) expect(survivingIds.has(t.record?.id ?? '')).toBe(true);
    // All pending evicted (tombstones alone already exceed the cap).
    for (const p of pending) expect(survivingIds.has(p.record?.id ?? '')).toBe(false);
    expect(out.evictedCount).toBe(20);
  });

  it('evicts pending FIRST to satisfy the total cap, keeping tombstones', () => {
    const tombstones = Array.from({ length: LEDGER_MAX_ROWS - 5 }, (_, i) =>
      row({ id: `t-${i}`, promotedAt: '2026-05-01T00:00:00.000Z' })
    );
    const pending = Array.from({ length: 50 }, (_, i) => row({ id: `p-${i}` }));
    const out = compactLedger([...tombstones, ...pending]);

    expect(out.rows).toHaveLength(LEDGER_MAX_ROWS);
    const tombstoneCount = out.rows.filter((r) => r.record?.promotedAt !== null).length;
    expect(tombstoneCount).toBe(LEDGER_MAX_ROWS - 5); // all tombstones kept
    const pendingCount = out.rows.filter((r) => r.record?.promotedAt === null).length;
    expect(pendingCount).toBe(5); // only headroom-many pending kept
  });

  it('is idempotent — compacting compacted output is a no-op', () => {
    const rows = [
      row({ id: 'dup', text: 'first' }),
      row({ id: 'dup', text: 'second' }),
      row({ id: 'p', promotedAt: '2026-05-01T00:00:00.000Z' }),
      ...Array.from({ length: LEDGER_MAX_PENDING_ROWS + 30 }, (_, i) => row({ id: `id-${i}` })),
    ];
    const once = compactLedger(rows);
    const twice = compactLedger(once.rows);
    expect(twice.rows).toEqual(once.rows);
    expect(twice.deduplicatedCount).toBe(0);
    expect(twice.evictedCount).toBe(0);
  });

  it('handles an all-promoted ledger (all tombstones, none evicted)', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ id: `t-${i}`, promotedAt: '2026-05-01T00:00:00.000Z' }));
    const out = compactLedger(rows);
    expect(out.rows).toHaveLength(10);
    expect(out.evictedCount).toBe(0);
  });

  it('handles an all-pending ledger under the cap (none evicted)', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ id: `id-${i}` }));
    const out = compactLedger(rows);
    expect(out.rows).toHaveLength(10);
    expect(out.evictedCount).toBe(0);
    expect(out.deduplicatedCount).toBe(0);
  });
});
