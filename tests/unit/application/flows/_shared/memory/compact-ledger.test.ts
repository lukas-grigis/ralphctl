import { describe, expect, it } from 'vitest';
import { type LearningRecord, serializeLearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';
import {
  LEDGER_MAX_PENDING_ROWS,
  LEDGER_MAX_ROWS,
  type LedgerRow,
  compactLedger,
} from '@src/application/flows/_shared/memory/compact-ledger.ts';

// Default text embeds the id so bulk-generated fixture rows (which vary only by id) stay well below
// NEAR_DUPLICATE_JACCARD_THRESHOLD of each other — distinct ledger rows normally have distinct text;
// only the dedicated near-duplicate-merge tests below deliberately construct near-identical text.
const record = (over: Partial<LearningRecord> = {}): LearningRecord => {
  const id = over.id ?? 'id-1';
  return {
    v: 1,
    id,
    text: `learning text ${id}`,
    repo: '/repos/app',
    repoName: 'app',
    taskKind: 'feature',
    sprintId: 'sprint-1',
    taskId: 'task-1',
    timestamp: '2026-05-30T10:00:00.000Z',
    promotedAt: null,
    ...over,
  };
};

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

  it('treats a RETIRED row as an inviolable tombstone (never evicted, suppresses a re-emitted twin)', () => {
    // A retired learning must keep suppressing a later null-twin so the operator's decline sticks.
    const out = compactLedger([
      row({ id: 'r', retiredAt: '2026-06-29T00:00:00.000Z' }),
      row({ id: 'r', text: 're-emitted by a later task' }), // null twin, loses to the retired tombstone
      row({ id: 'p' }),
    ]);
    const rRows = out.rows.filter((r) => r.record?.id === 'r');
    expect(rRows).toHaveLength(1);
    expect(rRows[0]?.record?.retiredAt).toBe('2026-06-29T00:00:00.000Z');
  });

  it('never evicts retired tombstones under the total cap, shedding pending first', () => {
    const retired = Array.from({ length: LEDGER_MAX_ROWS - 3 }, (_, i) =>
      row({ id: `r-${i}`, retiredAt: '2026-06-29T00:00:00.000Z' })
    );
    const pending = Array.from({ length: 40 }, (_, i) => row({ id: `p-${i}` }));
    const out = compactLedger([...retired, ...pending]);
    expect(out.rows).toHaveLength(LEDGER_MAX_ROWS);
    const retiredKept = out.rows.filter(
      (r) => r.record?.retiredAt !== null && r.record?.retiredAt !== undefined
    ).length;
    expect(retiredKept).toBe(LEDGER_MAX_ROWS - 3); // every retired tombstone survives
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

// 12 shared unique words + 1 distinct trailing word gives a word-set Jaccard of 12/14 ≈ 0.857 between
// any two variants below — just over NEAR_DUPLICATE_JACCARD_THRESHOLD (0.85). Below-threshold and
// unrelated-text cases use ordinary short phrases instead.
const PARAPHRASE_BASE = 'tests need a real database connection to properly catch every integration edge';
const paraphrase = (word: string): string => `${PARAPHRASE_BASE} ${word}`;

describe('compactLedger — near-duplicate merge', () => {
  it('merges a paraphrase pair (same kind, same appliesTo, near-identical text) onto the newest, stamping supersedes', () => {
    const original = row({ id: 'a', text: paraphrase('bugs') });
    const rewording = row({ id: 'b', text: paraphrase('issues') });
    const out = compactLedger([original, rewording]);

    expect(out.rows).toHaveLength(1);
    expect(out.deduplicatedCount).toBe(1);
    const winner = out.rows[0]?.record;
    expect(winner?.id).toBe('b'); // newest wins
    expect(winner?.supersedes).toEqual(['a']);
  });

  it('does NOT merge rows below the similarity threshold', () => {
    const a = row({ id: 'a', text: 'tests need a real database' });
    const b = row({ id: 'b', text: 'module Y is tightly coupled to module Z' });
    const out = compactLedger([a, b]);
    expect(out.rows).toHaveLength(2);
    expect(out.deduplicatedCount).toBe(0);
  });

  // 11 shared words + 2 distinct words on each side gives a word-set Jaccard of 11/15 ≈ 0.733 —
  // comfortably in the 0.6-0.84 band just under NEAR_DUPLICATE_JACCARD_THRESHOLD (0.85), unlike the
  // unrelated-text case above (~0.05). A regression that lowers the constant into this band (or
  // inverts the `>=` comparison) would merge these two distinct learnings; this pins the boundary.
  it('does NOT merge rows just below the near-duplicate threshold (~0.73 similarity)', () => {
    const a = row({
      id: 'a',
      text: 'retry wrapper needs circuit breaker logic before every payment gateway call urgently now',
    });
    const b = row({
      id: 'b',
      text: 'retry wrapper needs circuit breaker logic before every payment gateway call recently added',
    });
    const out = compactLedger([a, b]);
    expect(out.rows).toHaveLength(2);
    expect(out.deduplicatedCount).toBe(0);
  });

  it('does NOT merge same-text rows across different kinds', () => {
    const learning = row({ id: 'a', text: 'adopt hexagonal layering across the codebase', kind: 'learning' });
    const decision = row({ id: 'b', text: 'adopt hexagonal layering across the codebase', kind: 'decision' });
    const out = compactLedger([learning, decision]);
    expect(out.rows).toHaveLength(2);
    expect(out.deduplicatedCount).toBe(0);
  });

  it('does NOT merge same-text rows across different appliesTo', () => {
    const a = row({ id: 'a', text: 'flaky test needs a retry wrapper', appliesTo: 'web app' });
    const b = row({ id: 'b', text: 'flaky test needs a retry wrapper', appliesTo: 'mobile app' });
    const out = compactLedger([a, b]);
    expect(out.rows).toHaveLength(2);
    expect(out.deduplicatedCount).toBe(0);
  });

  it('NEVER merges a SETTLED (promoted or retired) row, even against a near-identical pending row', () => {
    const promoted = row({ id: 'a', text: paraphrase('bugs'), promotedAt: '2026-06-01T00:00:00.000Z' });
    const pending = row({ id: 'b', text: paraphrase('issues') });
    const out = compactLedger([promoted, pending]);
    expect(out.rows).toHaveLength(2);
    expect(out.deduplicatedCount).toBe(0);
    expect(out.rows.some((r) => r.record?.id === 'a' && r.record.promotedAt !== null)).toBe(true);
    expect(out.rows.some((r) => r.record?.id === 'b')).toBe(true);
  });

  it('chains three successive paraphrases onto the single newest winner', () => {
    const v1 = row({ id: 'v1', text: paraphrase('today') });
    const v2 = row({ id: 'v2', text: paraphrase('currently') });
    const v3 = row({ id: 'v3', text: paraphrase('presently') });
    const out = compactLedger([v1, v2, v3]);

    expect(out.rows).toHaveLength(1);
    expect(out.deduplicatedCount).toBe(2);
    const winner = out.rows[0]?.record;
    expect(winner?.id).toBe('v3');
    expect(winner?.supersedes).toEqual(['v1', 'v2']);
  });

  it('preserves untouched (non-merged) rows byte-for-byte via their original raw line', () => {
    const rawWithFuture = JSON.stringify({ ...record({ id: 'solo' }), futureField: 'keep-me' });
    const soloRow: LedgerRow = { raw: rawWithFuture, record: record({ id: 'solo' }) };
    const out = compactLedger([soloRow]);
    expect(out.rows[0]?.raw).toBe(rawWithFuture);
  });

  it('a later compaction pass keeps accumulating supersedes on top of an already-merged winner', () => {
    const v1 = row({ id: 'v1', text: paraphrase('today') });
    const v2 = row({ id: 'v2', text: paraphrase('currently') });
    const firstPass = compactLedger([v1, v2]);
    expect(firstPass.rows).toHaveLength(1);
    expect(firstPass.rows[0]?.record?.supersedes).toEqual(['v1']);

    const v3 = row({ id: 'v3', text: paraphrase('presently') });
    const secondPass = compactLedger([...firstPass.rows, v3]);
    expect(secondPass.rows).toHaveLength(1);
    expect(secondPass.rows[0]?.record?.id).toBe('v3');
    expect(secondPass.rows[0]?.record?.supersedes).toEqual(['v1', 'v2']);
  });

  it('is idempotent across a merge — compacting merged output a second time is a no-op', () => {
    const v1 = row({ id: 'v1', text: paraphrase('today') });
    const v2 = row({ id: 'v2', text: paraphrase('currently') });
    const once = compactLedger([v1, v2]);
    const twice = compactLedger(once.rows);
    expect(twice.rows).toEqual(once.rows);
    expect(twice.deduplicatedCount).toBe(0);
    expect(twice.evictedCount).toBe(0);
  });
});
