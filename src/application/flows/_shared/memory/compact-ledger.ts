import {
  type LearningRecord,
  isRetired,
  recordKind,
  serializeLearningRecord,
} from '@src/application/flows/_shared/memory/learning-record.ts';
import { LEDGER_MAX_ROWS } from '@src/application/flows/_shared/memory/read-ledger.ts';

/**
 * A record is SETTLED — a tombstone that is never evicted and always wins a dedup tie — once it has
 * reached a terminal disposition: PROMOTED into a native context file (`promotedAt !== null`) or
 * durably RETIRED (the operator declined it). Both must survive compaction so their suppression of a
 * re-emitted duplicate persists: a promoted learning is already in the project's context file, and a
 * retired one must never be re-proposed. Settled rows are also excluded from near-duplicate merging
 * (see {@link mergeNearDuplicates}) — a settled disposition is final and must never be merged away.
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
 *  - `deduplicatedCount`: rows collapsed because a same-id winner was chosen elsewhere, PLUS rows
 *    absorbed by a near-duplicate paraphrase merge (see {@link mergeNearDuplicates}) — both are the
 *    same shape of event from a caller's perspective (a row disappeared into a surviving winner).
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
 *     this step NEVER re-serializes a record.
 *  3. Merge near-duplicate PENDING winners (paraphrase drift) — see {@link mergeNearDuplicates}.
 *     Settled winners (tombstones) are never touched by this step. A merged row IS re-serialized
 *     (its `supersedes` genuinely changed); every row this step leaves alone still carries its
 *     original byte-for-byte raw line.
 *  4. Split winners into settled tombstones (promoted / retired) and pending rows.
 *  5. Cap pending at {@link LEDGER_MAX_PENDING_ROWS}, evicting the OLDEST by original position.
 *  6. Cap the total at {@link LEDGER_MAX_ROWS}, evicting PENDING first — settled tombstones are
 *     NEVER evicted (invariant: promotion/retirement-suppression survives compaction).
 *  7. Emit survivors in their original relative order.
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
  const idDeduplicatedCount = candidates.length - winnerByid.size;

  // Winners in their original relative order (by first-seen position of the WINNING row).
  const winners = [...winnerByid.values()].sort((a, b) => a.position - b.position);

  // 3. Merge near-duplicate PENDING winners; settled winners bypass this step untouched.
  const settledWinners = winners.filter((c) => isSettled(c.record));
  const unsettledWinners = winners.filter((c) => !isSettled(c.record));
  const { winners: mergedPending, mergedAwayCount } = mergeNearDuplicates(unsettledWinners);
  const deduplicatedCount = idDeduplicatedCount + mergedAwayCount;

  // 4. Split (already split above — `settledWinners` are the tombstones, `mergedPending` is pending).
  const tombstones = settledWinners;
  let pending = mergedPending;

  let evictedCount = 0;

  // 5. Cap pending — evict the OLDEST (smallest position) first. `pending` is already
  //    position-ascending, so dropping from the front evicts oldest.
  if (pending.length > LEDGER_MAX_PENDING_ROWS) {
    const overflow = pending.length - LEDGER_MAX_PENDING_ROWS;
    pending = pending.slice(overflow);
    evictedCount += overflow;
  }

  // 6. Cap the total — settled tombstones are inviolable, so only pending can be shed here. Evict
  //    the oldest pending until the total fits (or pending is exhausted).
  const total = tombstones.length + pending.length;
  if (total > LEDGER_MAX_ROWS) {
    const overflow = Math.min(total - LEDGER_MAX_ROWS, pending.length);
    pending = pending.slice(overflow);
    evictedCount += overflow;
  }

  // 7. Re-merge survivors and restore original relative order.
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

/**
 * Jaccard threshold above which two same-group PENDING rows are treated as paraphrase duplicates and
 * merged. Deliberately high — only genuinely repetitive rewordings collapse — the moderate (not
 * aggressive) consolidation intensity that keeps a merge in the sweet spot rather than degrading
 * signal the way over-compression does (arXiv 2604.04373). The exact cutoff is an engineering
 * budget, not a value derived from that source.
 */
const NEAR_DUPLICATE_JACCARD_THRESHOLD = 0.85;

/** Lower-cased, punctuation-stripped word set for near-duplicate text comparison. */
const wordSet = (text: string): ReadonlySet<string> =>
  new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 0)
  );

/** Jaccard similarity of two word sets — 0 when either is empty. */
const wordJaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) if (b.has(word)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

/** Near-duplicate grouping key: same memory kind (learning/decision) + same `appliesTo` (or ''). */
const nearDuplicateGroupKey = (record: LearningRecord): string => `${recordKind(record)} ${record.appliesTo ?? ''}`;

interface NearDuplicateCluster {
  /** Current representative for this cluster — always the newest member merged in so far. */
  tip: Candidate;
  /** Ids this cluster's eventual winner supersedes, accumulated across merges (excludes the tip's own id). */
  readonly supersedes: Set<string>;
  /** True once a SECOND row has merged into this cluster — gates re-serialization (see below). */
  touched: boolean;
}

/**
 * Merge near-duplicate (paraphrase-drift) PENDING rows onto one winner per cluster — settled rows
 * never reach this function (see the `isSettled` filter in {@link compactLedger}) and so can never be
 * merged away, matching the invariant that a settled disposition is final.
 *
 * Rows are grouped by {@link nearDuplicateGroupKey} (same kind, same `appliesTo`), then processed
 * OLDEST-FIRST within each group: a row joins the first existing cluster in its group whose current
 * tip's text is at least {@link NEAR_DUPLICATE_JACCARD_THRESHOLD} similar (word-set Jaccard), and
 * becomes that cluster's new tip — "winner = newest" falls out of the oldest-first processing order
 * rather than a second sort. The old tip's id (and anything it already superseded from an earlier
 * compaction pass) folds into the cluster's `supersedes` set, an incremental delta on top of what the
 * ledger already recorded rather than a destructive rewrite (arXiv 2510.04618). A row that never
 * matches an existing cluster starts a new one of its own.
 *
 * A cluster that never absorbs a second row is emitted UNCHANGED — its original candidate, raw line
 * included — so the exact-id dedup step's byte-for-byte invariant extends to every row this step
 * leaves alone. Only a cluster that actually merged this pass is re-serialized (its `supersedes`
 * genuinely changed), which is also what keeps a second compaction pass over already-merged output a
 * true no-op: nothing merges again, so nothing gets touched a second time.
 */
const mergeNearDuplicates = (
  unsettled: readonly Candidate[]
): { readonly winners: readonly Candidate[]; readonly mergedAwayCount: number } => {
  const ordered = [...unsettled].sort((a, b) => a.position - b.position);
  const groups = new Map<string, NearDuplicateCluster[]>();
  let mergedAwayCount = 0;

  for (const candidate of ordered) {
    const key = nearDuplicateGroupKey(candidate.record);
    let clusters = groups.get(key);
    if (clusters === undefined) {
      clusters = [];
      groups.set(key, clusters);
    }

    const match = clusters.find(
      (cluster) =>
        wordJaccard(wordSet(cluster.tip.record.text), wordSet(candidate.record.text)) >=
        NEAR_DUPLICATE_JACCARD_THRESHOLD
    );
    if (match === undefined) {
      clusters.push({ tip: candidate, supersedes: new Set(candidate.record.supersedes ?? []), touched: false });
      continue;
    }

    match.supersedes.add(match.tip.record.id);
    for (const id of match.tip.record.supersedes ?? []) match.supersedes.add(id);
    for (const id of candidate.record.supersedes ?? []) match.supersedes.add(id);
    match.supersedes.delete(candidate.record.id); // the new tip cannot supersede itself
    match.tip = candidate;
    match.touched = true;
    mergedAwayCount += 1;
  }

  const winners: Candidate[] = [];
  for (const clusters of groups.values()) {
    for (const cluster of clusters) {
      if (!cluster.touched) {
        winners.push(cluster.tip); // untouched this pass — keep its raw line byte-for-byte
        continue;
      }
      const mergedRecord: LearningRecord = { ...cluster.tip.record, supersedes: [...cluster.supersedes].sort() };
      winners.push({
        row: { raw: serializeLearningRecord(mergedRecord).trimEnd(), record: mergedRecord },
        record: mergedRecord,
        position: cluster.tip.position,
      });
    }
  }

  return { winners: winners.sort((a, b) => a.position - b.position), mergedAwayCount };
};
