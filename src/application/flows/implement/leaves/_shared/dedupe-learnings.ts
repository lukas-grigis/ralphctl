import type { LearningEntry } from '@src/domain/signal.ts';

/**
 * Dedupe structured learnings by insight text, preserving first-seen order and
 * trimming the insight. Entries whose insight is empty / whitespace-only are
 * dropped. The first occurrence of each insight is kept (its context /
 * applies-to ride along); later duplicates are discarded.
 *
 * Identity is the TRIMMED insight text, case-sensitive with no internal-whitespace
 * collapse — deliberately coarser than the ledger's
 * {@link import('@src/application/flows/_shared/memory/learning-record.ts').deriveLearningId},
 * which additionally lower-cases and collapses whitespace runs (`normalizeForId`). So two
 * insights differing only by case or internal spacing survive this write-side pass as distinct
 * lines, then collapse onto ONE row downstream where read-side / distill dedup keys on the
 * normalized `id`. Any extra ledger lines this leniency emits are therefore harmless.
 *
 * Shared by the progress-journal and append-learnings leaves.
 */
export function dedupeLearnings(entries: readonly LearningEntry[]): LearningEntry[] {
  const seen = new Set<string>();
  const out: LearningEntry[] = [];
  for (const entry of entries) {
    const text = entry.text.trim();
    if (text.length === 0) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ ...entry, text });
  }
  return out;
}
