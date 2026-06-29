import { type LearningRecord, isRetired } from '@src/application/flows/_shared/memory/learning-record.ts';
import { LEDGER_MAX_ROWS } from '@src/application/flows/_shared/memory/read-ledger.ts';

/**
 * A record is SETTLED — a tombstone that is never evicted and always wins a dedup tie — once it has
 * reached a terminal disposition: PROMOTED into a native context file (`promotedAt !== null`) or
 * durably RETIRED (the operator declined it). Both must survive compaction so their suppression of a
 * re-emitted duplicate persists: a promoted learning is already in the project's context file, and a
 * retired one must never be re-proposed.
 */
const isSettled = (record: LearningRecord): boolean => record.promotedAt !== null || isRetired(record);

export { LEDGER_MAX_ROWS };

/**
 * Hard cap on PENDING (not-yet-promoted) rows retained on disk after compaction. Pending rows are
 * candidates the operator hasn't acted on; the oldest are evicted once this many accumulate. The
 * cap is well below {@link LEDGER_MAX_ROWS} so promoted tombstones always have headroom — a
 * project that promotes steadily never starves its own suppression set.
 *
 * @public
 */
export const LEDGER_MAX_PENDING_ROWS = 200;

/**
 * One row in / out of the compactor: the byte-for-byte raw NDJSON line plus its parsed record.
 * A `record` of `undefined` (a blank line) is dropped — compaction operates on real rows.
 */
export interface LedgerRow {
  readonly raw: string;
  readonly record: LearningRecord | undefined;
}

/**
 * Result of a compaction pass.
 *  - `rows`: the surviving rows in their ORIGINAL relative order, each carrying its raw line.
 *  - `deduplicatedCount`: rows collapsed because a same-id winner was chosen elsewhere.
 *  - `evictedCount`: surviving-winner rows dropped purely to satisfy the size caps.
 */
export interface CompactionResult {
  readonly rows: readonly LedgerRow[];
  readonly evictedCount: number;
  readonly deduplicatedCount: number;
}

interface Candidate {
  readonly row: LedgerRow;
  readonly record: LearningRecord;
  readonly position: number;
}

/**
 * Compact a learnings ledger to a bounded, deduplicated set while preserving every load-bearing
 * invariant of the procedural-memory pipeline. PURE — no I/O, no clock. Idempotent: compacting an
 * already-compacted result is a no-op.
 *
 * Steps:
 *  1. Drop blank rows (`record === undefined`).
 *  2. Group by id and pick ONE winner per id (invariant: dedup semantics):
 *     - if any occurrence is SETTLED (promoted OR retired), the LAST settled wins;
 *     - otherwise the FIRST unsettled wins.
 *     The winner is represented by its RAW LINE (invariant: byte-for-byte forward-compat) —
 *     compaction NEVER re-serializes a record.
 *  3. Split winners into settled tombstones (promoted / retired) and pending rows.
 *  4. Cap pending at {@link LEDGER_MAX_PENDING_ROWS}, evicting the OLDEST by original position.
 *  5. Cap the total at {@link LEDGER_MAX_ROWS}, evicting PENDING first — settled tombstones are
 *     NEVER evicted (invariant: promotion/retirement-suppression survives compaction).
 *  6. Emit survivors in their original relative order.
 *
 * @public
 */
export const compactLedger = (rows: readonly LedgerRow[]): CompactionResult => {
  // 1. Index every real (non-blank) row with its original position; blanks are dropped silently.
  const candidates: Candidate[] = [];
  for (const [position, row] of rows.entries()) {
    if (row.record === undefined) continue;
    candidates.push({ row, record: row.record, position });
  }

  // 2. Group by id, pick the winner per dedup rule. `deduplicatedCount` counts every real row that
  //    is NOT the winner of its group (i.e. a collapsed duplicate).
  const winnerByid = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const existing = winnerByid.get(candidate.record.id);
    if (existing === undefined) {
      winnerByid.set(candidate.record.id, candidate);
      continue;
    }
    winnerByid.set(candidate.record.id, pickWinner(existing, candidate));
  }
  const deduplicatedCount = candidates.length - winnerByid.size;

  // Winners in their original relative order (by first-seen position of the WINNING row).
  const winners = [...winnerByid.values()].sort((a, b) => a.position - b.position);

  // 3. Split winners into tombstones (settled = promoted / retired — never evicted) and pending.
  const tombstones = winners.filter((c) => isSettled(c.record));
  let pending = winners.filter((c) => !isSettled(c.record));

  let evictedCount = 0;

  // 4. Cap pending — evict the OLDEST (smallest position) first. `pending` is already
  //    position-ascending, so dropping from the front evicts oldest.
  if (pending.length > LEDGER_MAX_PENDING_ROWS) {
    const overflow = pending.length - LEDGER_MAX_PENDING_ROWS;
    pending = pending.slice(overflow);
    evictedCount += overflow;
  }

  // 5. Cap the total — settled tombstones are inviolable, so only pending can be shed here. Evict
  //    the oldest pending until the total fits (or pending is exhausted).
  const total = tombstones.length + pending.length;
  if (total > LEDGER_MAX_ROWS) {
    const overflow = Math.min(total - LEDGER_MAX_ROWS, pending.length);
    pending = pending.slice(overflow);
    evictedCount += overflow;
  }

  // 6. Re-merge survivors and restore original relative order.
  const survivors = [...tombstones, ...pending].sort((a, b) => a.position - b.position);

  return {
    rows: survivors.map((c) => c.row),
    evictedCount,
    deduplicatedCount,
  };
};

/**
 * Pick the surviving row between two same-id candidates seen in stream order (`existing` came
 * first). A SETTLED row (promoted or retired) always beats an unsettled one; between two settled the
 * LATER one wins (a promotion/retirement stamped later is the current disposition); between two
 * unsettled the EARLIER (`existing`) wins.
 */
const pickWinner = (existing: Candidate, next: Candidate): Candidate => {
  const existingSettled = isSettled(existing.record);
  const nextSettled = isSettled(next.record);

  if (existingSettled && nextSettled) return next; // last-settled-wins
  if (nextSettled) return next; // settled-wins-over-unsettled
  if (existingSettled) return existing; // keep settled over a later unsettled
  return existing; // first-occurrence-wins among unsettled
};
